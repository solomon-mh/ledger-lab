/**
 * These tests fire real concurrent requests at a real Postgres. They are the
 * tests that catch the "read balance, check, then write" race condition that
 * a naive implementation has.
 */
import { describe, expect, it } from 'vitest';
import { InsufficientFundsError } from '../src/errors.js';
import { chart, openWallet, setupPlatformAccounts, topUpWallet, transfer } from '../src/flows.js';
import { withTransaction } from '../src/db.js';
import { checkIntegrity, getBalance, postTransaction } from '../src/ledger.js';
import { db, useFreshDatabase } from './helpers.js';

useFreshDatabase();

async function wallets(...users: string[]) {
  await setupPlatformAccounts(db, 'USD');
  for (const u of users) await openWallet(db, u, 'USD');
}

describe('why the row lock matters', () => {
  it('a NAIVE read-check-write implementation overdraws under concurrency', async () => {
    await wallets('alice');
    await topUpWallet(db, { topUpId: 't1', userId: 'alice', currency: 'USD', amount: 100 });
    const aliceId = (await getBalance(db, chart.wallet('alice', 'USD'))).account.id;

    // The bug: SELECT without FOR UPDATE. Two requests both read "100", both
    // pass the check, both write. pg_sleep just widens the race window so the
    // test is deterministic; in production the window is small but real.
    const naiveWithdraw = (amount: number) =>
      withTransaction(db, async (tx) => {
        const { rows } = await tx.query<{ balance: number }>('SELECT balance FROM account_balances WHERE account_id = $1', [aliceId]);
        const available = -rows[0]!.balance; // liability: normal balance is the negated signed balance
        await tx.query('SELECT pg_sleep(0.02)');
        if (available < amount) throw new Error('insufficient funds');
        await tx.query('UPDATE account_balances SET balance = balance + $2 WHERE account_id = $1', [aliceId, amount]);
      });

    const results = await Promise.allSettled(Array.from({ length: 20 }, () => naiveWithdraw(10)));
    const succeeded = results.filter((r) => r.status === 'fulfilled').length;

    expect(succeeded).toBeGreaterThan(10); // more than the 100 available was spent
    expect((await getBalance(db, chart.wallet('alice', 'USD'))).balance).toBeLessThan(0);
  });
});

describe('concurrency', () => {
  it('20 simultaneous withdrawals of 10 from a balance of 100: exactly 10 succeed, never negative', async () => {
    await wallets('alice', 'bob');
    await topUpWallet(db, { topUpId: 't1', userId: 'alice', currency: 'USD', amount: 100 });

    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) => transfer(db, { transferId: `x${i}`, from: 'alice', to: 'bob', currency: 'USD', amount: 10 })),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(10);
    expect(failed).toHaveLength(10);
    expect(failed.every((r) => r.reason instanceof InsufficientFundsError)).toBe(true);
    expect((await getBalance(db, chart.wallet('alice', 'USD'))).balance).toBe(0);
    expect((await getBalance(db, chart.wallet('bob', 'USD'))).balance).toBe(100);
    expect((await checkIntegrity(db)).ok).toBe(true);
  });

  it('the same idempotency key sent 10 times at once posts exactly once', async () => {
    await wallets('alice', 'bob');
    await topUpWallet(db, { topUpId: 't1', userId: 'alice', currency: 'USD', amount: 1000 });

    const results = await Promise.all(
      Array.from({ length: 10 }, () => transfer(db, { transferId: 'same', from: 'alice', to: 'bob', currency: 'USD', amount: 250 })),
    );

    expect(new Set(results.map((r) => r.transaction.id)).size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect((await getBalance(db, chart.wallet('alice', 'USD'))).balance).toBe(750);
  });

  it('A->B and B->A at the same time do not deadlock (locks are taken in id order)', async () => {
    await wallets('alice', 'bob');
    await topUpWallet(db, { topUpId: 'ta', userId: 'alice', currency: 'USD', amount: 1000 });
    await topUpWallet(db, { topUpId: 'tb', userId: 'bob', currency: 'USD', amount: 1000 });

    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        i % 2 === 0
          ? transfer(db, { transferId: `ab${i}`, from: 'alice', to: 'bob', currency: 'USD', amount: 1 })
          : transfer(db, { transferId: `ba${i}`, from: 'bob', to: 'alice', currency: 'USD', amount: 1 }),
      ),
    );

    expect((await getBalance(db, chart.wallet('alice', 'USD'))).balance).toBe(1000);
    expect((await getBalance(db, chart.wallet('bob', 'USD'))).balance).toBe(1000);
  });

  it('many concurrent postings leave the balance cache equal to SUM(entries)', async () => {
    await wallets('alice', 'bob', 'carol');
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => topUpWallet(db, { topUpId: `t${i}`, userId: ['alice', 'bob', 'carol'][i % 3]!, currency: 'USD', amount: 7 })),
    );
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        postTransaction(db, {
          idempotencyKey: `mix${i}`,
          description: 'mix',
          entries: [
            { account: chart.wallet(['alice', 'bob', 'carol'][i % 3]!, 'USD'), direction: 'debit', amount: 1 },
            { account: chart.wallet(['alice', 'bob', 'carol'][(i + 1) % 3]!, 'USD'), direction: 'credit', amount: 1 },
          ],
        }),
      ),
    );
    const report = await checkIntegrity(db);
    expect(report).toEqual({ ok: true, unbalancedTransactions: [], cacheMismatches: [], overdrawnAccounts: [] });
  });
});
