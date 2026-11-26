import { afterAll, beforeEach } from 'vitest';
import { createPool, resetDatabase } from '../src/db.js';
import { createAccount, type AccountType } from '../src/ledger.js';

export const db = createPool(process.env.TEST_DATABASE_URL ?? 'postgres://postgres@localhost:5432/ledger_test');

/** Fresh schema before every test so tests never depend on each other. */
export function useFreshDatabase() {
  beforeEach(async () => {
    await resetDatabase(db);
  });
  afterAll(async () => {
    await db.end();
  });
}

export const account = (code: string, type: AccountType, opts: { currency?: string; allowNegative?: boolean } = {}) =>
  createAccount(db, { code, name: code, type, currency: opts.currency ?? 'USD', allowNegative: opts.allowNegative });

export const debit = (account: string, amount: number) => ({ account, direction: 'debit' as const, amount });
export const credit = (account: string, amount: number) => ({ account, direction: 'credit' as const, amount });
