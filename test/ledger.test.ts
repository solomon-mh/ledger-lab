import { describe, expect, it } from 'vitest';
import {
  AccountNotFoundError,
  AlreadyReversedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  ValidationError,
} from '../src/errors.js';
import { checkIntegrity, getBalance, listEntries, postTransaction, reverseTransaction, trialBalance } from '../src/ledger.js';
import { account, credit, db, debit, useFreshDatabase } from './helpers.js';

useFreshDatabase();

async function basicAccounts() {
  await account('assets:cash', 'asset');
  await account('revenue:sales', 'revenue');
  await account('liabilities:wallet:alice', 'liability', { allowNegative: false });
}

describe('posting', () => {
  it('posts a balanced transaction and updates balances in each account’s normal direction', async () => {
    await basicAccounts();
    const { transaction, replayed } = await postTransaction(db, {
      idempotencyKey: 'sale-1',
      description: 'Cash sale',
      entries: [debit('assets:cash', 1500), credit('revenue:sales', 1500)],
    });
    expect(replayed).toBe(false);
    expect(transaction.entries).toHaveLength(2);
    expect((await getBalance(db, 'assets:cash')).balance).toBe(1500); // asset grows with debit
    expect((await getBalance(db, 'revenue:sales')).balance).toBe(1500); // revenue grows with credit
  });

  it('rejects transactions where debits != credits, and writes nothing', async () => {
    await basicAccounts();
    await expect(
      postTransaction(db, { idempotencyKey: 'bad', description: 'x', entries: [debit('assets:cash', 1000), credit('revenue:sales', 999)] }),
    ).rejects.toThrow(ValidationError);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM ledger_transactions');
    expect(rows[0].n).toBe(0); // the idempotency claim rolled back too
  });

  it.each([
    ['zero amount', 0],
    ['negative amount', -5],
    ['fractional amount', 10.5],
    ['unsafe integer', 2 ** 53],
  ])('rejects %s', async (_label, amount) => {
    await basicAccounts();
    await expect(
      postTransaction(db, { idempotencyKey: 'k', description: 'x', entries: [debit('assets:cash', amount), credit('revenue:sales', amount)] }),
    ).rejects.toThrow(ValidationError);
  });

  it('rejects a single-entry transaction', async () => {
    await basicAccounts();
    await expect(postTransaction(db, { idempotencyKey: 'k', description: 'x', entries: [debit('assets:cash', 1)] })).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects unknown accounts', async () => {
    await basicAccounts();
    await expect(
      postTransaction(db, { idempotencyKey: 'k', description: 'x', entries: [debit('assets:nope', 1), credit('revenue:sales', 1)] }),
    ).rejects.toThrow(AccountNotFoundError);
  });

  it('keeps currencies separate: 100 USD cannot balance 100 EUR', async () => {
    await account('assets:cash:usd', 'asset', { currency: 'USD' });
    await account('revenue:sales:eur', 'revenue', { currency: 'EUR' });
    await expect(
      postTransaction(db, { idempotencyKey: 'fx', description: 'x', entries: [debit('assets:cash:usd', 100), credit('revenue:sales:eur', 100)] }),
    ).rejects.toThrow(/USD is off by 100/);
  });
});

describe('idempotency', () => {
  it('returns the original transaction when the same request is retried', async () => {
    await basicAccounts();
    const req = { idempotencyKey: 'sale-1', description: 'Cash sale', entries: [debit('assets:cash', 700), credit('revenue:sales', 700)] };
    const first = await postTransaction(db, req);
    const second = await postTransaction(db, req);
    expect(second.replayed).toBe(true);
    expect(second.transaction.id).toBe(first.transaction.id);
    expect((await getBalance(db, 'assets:cash')).balance).toBe(700); // not 1400
  });

  it('refuses to reuse a key for a different request', async () => {
    await basicAccounts();
    await postTransaction(db, { idempotencyKey: 'k1', description: 'a', entries: [debit('assets:cash', 1), credit('revenue:sales', 1)] });
    await expect(
      postTransaction(db, { idempotencyKey: 'k1', description: 'a', entries: [debit('assets:cash', 2), credit('revenue:sales', 2)] }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  it('treats metadata key order as the same request', async () => {
    await basicAccounts();
    const base = { idempotencyKey: 'k', description: 'a', entries: [debit('assets:cash', 1), credit('revenue:sales', 1)] };
    await postTransaction(db, { ...base, metadata: { a: 1, b: 2 } });
    const again = await postTransaction(db, { ...base, metadata: { b: 2, a: 1 } });
    expect(again.replayed).toBe(true);
  });
});

describe('overdraft protection', () => {
  it('blocks a wallet from going below zero', async () => {
    await basicAccounts();
    await postTransaction(db, { idempotencyKey: 'fund', description: 'fund', entries: [debit('assets:cash', 100), credit('liabilities:wallet:alice', 100)] });
    await expect(
      postTransaction(db, { idempotencyKey: 'spend', description: 'spend', entries: [debit('liabilities:wallet:alice', 101), credit('assets:cash', 101)] }),
    ).rejects.toThrow(InsufficientFundsError);
    expect((await getBalance(db, 'liabilities:wallet:alice')).balance).toBe(100);
  });

  it('allows spending exactly the full balance', async () => {
    await basicAccounts();
    await postTransaction(db, { idempotencyKey: 'fund', description: 'fund', entries: [debit('assets:cash', 100), credit('liabilities:wallet:alice', 100)] });
    await postTransaction(db, { idempotencyKey: 'spend', description: 'spend', entries: [debit('liabilities:wallet:alice', 100), credit('assets:cash', 100)] });
    expect((await getBalance(db, 'liabilities:wallet:alice')).balance).toBe(0);
  });

  it('guards apply to accounts that normally may go negative', async () => {
    await account('assets:bank', 'asset');
    await account('liabilities:merchant:m1', 'liability'); // allowNegative defaults to true
    const payout = { idempotencyKey: 'p', description: 'payout', entries: [debit('liabilities:merchant:m1', 50), credit('assets:bank', 50)] };
    await expect(postTransaction(db, { ...payout, guards: ['liabilities:merchant:m1'] })).rejects.toThrow(InsufficientFundsError);
    // without the guard the same posting is allowed (merchant ends up owing us)
    await postTransaction(db, payout);
    expect((await getBalance(db, 'liabilities:merchant:m1')).balance).toBe(-50);
  });
});

describe('reversals', () => {
  it('reverses by posting the mirror image, keeping both in history', async () => {
    await basicAccounts();
    const { transaction } = await postTransaction(db, { idempotencyKey: 's', description: 'sale', entries: [debit('assets:cash', 900), credit('revenue:sales', 900)] });
    const rev = await reverseTransaction(db, transaction.id, { idempotencyKey: 'rev-s', reason: 'entered twice' });
    expect(rev.transaction.reversesId).toBe(transaction.id);
    expect((await getBalance(db, 'assets:cash')).balance).toBe(0);
    expect(await listEntries(db, 'assets:cash')).toHaveLength(2);
  });

  it('cannot reverse the same transaction twice (even with a new key)', async () => {
    await basicAccounts();
    const { transaction } = await postTransaction(db, { idempotencyKey: 's', description: 'sale', entries: [debit('assets:cash', 900), credit('revenue:sales', 900)] });
    await reverseTransaction(db, transaction.id, { idempotencyKey: 'rev-1', reason: 'oops' });
    await expect(reverseTransaction(db, transaction.id, { idempotencyKey: 'rev-2', reason: 'oops again' })).rejects.toThrow(AlreadyReversedError);
  });

  it('a reversal still respects overdraft rules', async () => {
    await basicAccounts();
    const fund = await postTransaction(db, { idempotencyKey: 'f', description: 'fund', entries: [debit('assets:cash', 100), credit('liabilities:wallet:alice', 100)] });
    await postTransaction(db, { idempotencyKey: 'sp', description: 'spend', entries: [debit('liabilities:wallet:alice', 80), credit('assets:cash', 80)] });
    await expect(reverseTransaction(db, fund.transaction.id, { idempotencyKey: 'r', reason: 'x' })).rejects.toThrow(InsufficientFundsError);
  });
});

describe('database-level guarantees (defence in depth)', () => {
  it('refuses UPDATE and DELETE on entries', async () => {
    await basicAccounts();
    await postTransaction(db, { idempotencyKey: 's', description: 'sale', entries: [debit('assets:cash', 5), credit('revenue:sales', 5)] });
    await expect(db.query('UPDATE entries SET amount = 1')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM entries')).rejects.toThrow(/append-only/);
    await expect(db.query('DELETE FROM ledger_transactions')).rejects.toThrow(/append-only/);
  });

  it('refuses an unbalanced transaction written with raw SQL', async () => {
    const cash = await account('assets:cash', 'asset');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        "INSERT INTO ledger_transactions (idempotency_key, request_hash, description) VALUES ('raw', 'x', 'raw') RETURNING id",
      );
      await client.query('INSERT INTO entries (transaction_id, account_id, amount, currency) VALUES ($1, $2, 100, $3)', [rows[0].id, cash.id, 'USD']);
      await expect(client.query('COMMIT')).rejects.toThrow(/at least 2 are required|unbalanced/);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('refuses an entry whose currency differs from its account', async () => {
    const cash = await account('assets:cash', 'asset');
    await expect(
      db.query(
        `WITH t AS (INSERT INTO ledger_transactions (idempotency_key, request_hash, description) VALUES ('c', 'x', 'c') RETURNING id)
         INSERT INTO entries (transaction_id, account_id, amount, currency) SELECT id, $1, 100, 'EUR' FROM t`,
        [cash.id],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('reports', () => {
  it('trial balance balances and integrity check passes', async () => {
    await basicAccounts();
    await postTransaction(db, { idempotencyKey: 'a', description: 'a', entries: [debit('assets:cash', 300), credit('revenue:sales', 300)] });
    await postTransaction(db, { idempotencyKey: 'b', description: 'b', entries: [debit('assets:cash', 50), credit('liabilities:wallet:alice', 50)] });
    const tb = await trialBalance(db);
    expect(tb.balanced).toBe(true);
    expect(tb.totals.USD).toEqual({ debit: 350, credit: 350 });
    expect((await checkIntegrity(db)).ok).toBe(true);
  });

  it('integrity check detects a balance cache that drifted from the entries', async () => {
    await basicAccounts();
    await postTransaction(db, { idempotencyKey: 'a', description: 'a', entries: [debit('assets:cash', 300), credit('revenue:sales', 300)] });
    await db.query("UPDATE account_balances SET balance = 999 WHERE account_id = (SELECT id FROM accounts WHERE code = 'assets:cash')");
    const report = await checkIntegrity(db);
    expect(report.ok).toBe(false);
    expect(report.cacheMismatches).toEqual([{ account: 'assets:cash', cached: 999, actual: 300 }]);
  });

  it('paginates account history with a cursor', async () => {
    await basicAccounts();
    for (let i = 1; i <= 5; i++) {
      await postTransaction(db, { idempotencyKey: `s${i}`, description: `sale ${i}`, entries: [debit('assets:cash', i), credit('revenue:sales', i)] });
    }
    const page1 = await listEntries(db, 'assets:cash', { limit: 2 });
    const page2 = await listEntries(db, 'assets:cash', { limit: 2, beforeId: page1.at(-1)!.entryId });
    expect(page1.map((e) => e.amount)).toEqual([5, 4]);
    expect(page2.map((e) => e.amount)).toEqual([3, 2]);
  });
});
