import { createHash } from 'node:crypto';
import { withTransaction, type Db, type Tx } from './db.js';
import {
  AccountNotFoundError,
  AlreadyReversedError,
  IdempotencyConflictError,
  InsufficientFundsError,
  TransactionNotFoundError,
  ValidationError,
} from './errors.js';
import { assertMinorUnits } from './money.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type Direction = 'debit' | 'credit';

export interface Account {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allowNegative: boolean;
}

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allowNegative?: boolean;
}

export interface EntryInput {
  account: string; // account code
  direction: Direction;
  amount: number; // positive, minor units
}

export interface PostTransactionInput {
  idempotencyKey: string;
  description: string;
  entries: EntryInput[];
  externalRef?: string | null;
  metadata?: Record<string, unknown>;
  effectiveAt?: Date | string;
  /**
   * Accounts whose balance must not go negative because of THIS transaction,
   * even if the account normally may (a merchant can owe us money after a
   * chargeback, but we must never *pay out* more than we owe them).
   */
  guards?: string[];
}

export interface PostedEntry {
  id: number;
  account: string;
  direction: Direction;
  amount: number;
  currency: string;
}

export interface PostedTransaction {
  id: number;
  idempotencyKey: string;
  description: string;
  externalRef: string | null;
  reversesId: number | null;
  metadata: Record<string, unknown>;
  effectiveAt: Date;
  createdAt: Date;
  entries: PostedEntry[];
}

export interface PostResult {
  transaction: PostedTransaction;
  /** true when this idempotency key was already processed and we returned the original result */
  replayed: boolean;
}

// ---------------------------------------------------------------------------
// Sign conventions
// ---------------------------------------------------------------------------
// Stored amounts are signed: debit = +, credit = -.
// Humans read balances in the account's "normal" direction:
//   assets & expenses grow with debits; liabilities, equity & revenue grow with credits.

const DEBIT_NORMAL = new Set<AccountType>(['asset', 'expense']);

export function toNormalBalance(type: AccountType, signed: number): number {
  return DEBIT_NORMAL.has(type) ? signed : 0 - signed; // 0 - x avoids JavaScript -0
}

const signed = (e: EntryInput) => (e.direction === 'debit' ? e.amount : -e.amount);

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

interface AccountRow {
  id: number;
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  allow_negative: boolean;
}

const mapAccount = (r: AccountRow): Account => ({
  id: r.id,
  code: r.code,
  name: r.name,
  type: r.type,
  currency: r.currency,
  allowNegative: r.allow_negative,
});

/** Idempotent: creating an existing account with identical settings returns it. */
export async function createAccount(db: Db, input: CreateAccountInput): Promise<Account> {
  const allowNegative = input.allowNegative ?? true;
  if (!/^[a-z0-9_.:-]+$/.test(input.code)) throw new ValidationError('account code may only contain a-z 0-9 _ . : -');
  if (!/^[A-Z]{3}$/.test(input.currency)) throw new ValidationError('currency must be an ISO 4217 code like USD');
  if (!['asset', 'liability', 'equity', 'revenue', 'expense'].includes(input.type)) {
    throw new ValidationError(`unknown account type ${input.type}`);
  }

  return withTransaction(db, async (tx) => {
    const inserted = await tx.query<AccountRow>(
      `INSERT INTO accounts (code, name, type, currency, allow_negative)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO NOTHING
       RETURNING *`,
      [input.code, input.name, input.type, input.currency, allowNegative],
    );
    if (inserted.rows[0]) {
      await tx.query('INSERT INTO account_balances (account_id) VALUES ($1)', [inserted.rows[0].id]);
      return mapAccount(inserted.rows[0]);
    }
    const existing = mapAccount((await tx.query<AccountRow>('SELECT * FROM accounts WHERE code = $1', [input.code])).rows[0]!);
    if (existing.type !== input.type || existing.currency !== input.currency || existing.allowNegative !== allowNegative) {
      throw new ValidationError(`account ${input.code} already exists with different settings`, { existing });
    }
    return existing;
  });
}

export async function getAccount(db: Db | Tx, code: string): Promise<Account> {
  const row = (await db.query<AccountRow>('SELECT * FROM accounts WHERE code = $1', [code])).rows[0];
  if (!row) throw new AccountNotFoundError([code]);
  return mapAccount(row);
}

export interface Balance {
  account: Account;
  balance: number; // in the account's normal direction
  version: number;
}

/** O(1) read from the cached balance (kept in step with entries inside every posting). */
export async function getBalance(db: Db, code: string): Promise<Balance> {
  const row = (
    await db.query<AccountRow & { balance: number; version: number }>(
      `SELECT a.*, b.balance, b.version
       FROM accounts a JOIN account_balances b ON b.account_id = a.id
       WHERE a.code = $1`,
      [code],
    )
  ).rows[0];
  if (!row) throw new AccountNotFoundError([code]);
  const account = mapAccount(row);
  return { account, balance: toNormalBalance(account.type, row.balance), version: row.version };
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

function validateShape(input: PostTransactionInput): void {
  if (typeof input.idempotencyKey !== 'string' || input.idempotencyKey.length === 0 || input.idempotencyKey.length > 255) {
    throw new ValidationError('idempotencyKey is required (1-255 characters)');
  }
  if (typeof input.description !== 'string' || input.description.trim() === '') {
    throw new ValidationError('description is required');
  }
  if (!Array.isArray(input.entries) || input.entries.length < 2) {
    throw new ValidationError('a transaction needs at least 2 entries');
  }
  input.entries.forEach((e, i) => {
    if (typeof e.account !== 'string' || !e.account) throw new ValidationError(`entries[${i}].account is required`);
    if (e.direction !== 'debit' && e.direction !== 'credit') {
      throw new ValidationError(`entries[${i}].direction must be "debit" or "credit"`);
    }
    assertMinorUnits(e.amount, `entries[${i}].amount`);
    if (e.amount <= 0) throw new ValidationError(`entries[${i}].amount must be positive; use direction for the sign`);
  });
  if (input.metadata !== undefined && (typeof input.metadata !== 'object' || input.metadata === null || Array.isArray(input.metadata))) {
    throw new ValidationError('metadata must be an object');
  }
}

/** JSON.stringify with sorted keys, so {a,b} and {b,a} hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashRequest(input: PostTransactionInput, reversesId: number | null): string {
  const body = {
    description: input.description,
    entries: input.entries.map((e) => ({ account: e.account, direction: e.direction, amount: e.amount })),
    externalRef: input.externalRef ?? null,
    metadata: input.metadata ?? {},
    effectiveAt: input.effectiveAt ? new Date(input.effectiveAt).toISOString() : null,
    guards: [...(input.guards ?? [])].sort(),
    reversesId,
  };
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

/**
 * Post a balanced transaction. All-or-nothing, idempotent, safe under concurrency.
 *
 *  1. Claim the idempotency key (INSERT ... ON CONFLICT DO NOTHING).
 *     A concurrent request with the same key blocks here until we commit or roll back.
 *  2. Resolve accounts; check debits = credits per currency.
 *  3. Lock the balance rows of every touched account, ALWAYS in id order
 *     (consistent lock order = no deadlocks when A->B and B->A run at once).
 *  4. Check overdraft rules against the locked, up-to-date balances.
 *  5. Insert entries and update cached balances.
 * The DB re-checks the zero-sum rule at COMMIT as a last line of defence.
 */
export async function postTransaction(
  db: Db,
  input: PostTransactionInput,
  internal: { reversesId?: number } = {},
): Promise<PostResult> {
  validateShape(input);
  const reversesId = internal.reversesId ?? null;
  const requestHash = hashRequest(input, reversesId);

  return withTransaction(db, async (tx) => {
    // 1. Idempotency
    const claimed = await tx.query<{ id: number }>(
      `INSERT INTO ledger_transactions
         (idempotency_key, request_hash, description, external_ref, reverses_id, metadata, effective_at)
       VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.idempotencyKey,
        requestHash,
        input.description,
        input.externalRef ?? null,
        reversesId,
        JSON.stringify(input.metadata ?? {}),
        input.effectiveAt ? new Date(input.effectiveAt).toISOString() : null,
      ],
    );
    if (!claimed.rows[0]) {
      const existing = (
        await tx.query<{ id: number; request_hash: string }>(
          'SELECT id, request_hash FROM ledger_transactions WHERE idempotency_key = $1',
          [input.idempotencyKey],
        )
      ).rows[0]!;
      if (existing.request_hash !== requestHash) throw new IdempotencyConflictError(input.idempotencyKey);
      return { transaction: await loadTransaction(tx, existing.id), replayed: true };
    }
    const txId = claimed.rows[0].id;

    // 2. Accounts and the balance rule
    const codes = [...new Set(input.entries.map((e) => e.account))];
    const rows = (await tx.query<AccountRow>('SELECT * FROM accounts WHERE code = ANY($1::text[])', [codes])).rows;
    const byCode = new Map(rows.map((r) => [r.code, mapAccount(r)]));
    const missing = codes.filter((c) => !byCode.has(c));
    if (missing.length) throw new AccountNotFoundError(missing);

    const totals = new Map<string, number>();
    const deltas = new Map<number, number>();
    for (const e of input.entries) {
      const acct = byCode.get(e.account)!;
      totals.set(acct.currency, (totals.get(acct.currency) ?? 0) + signed(e));
      deltas.set(acct.id, (deltas.get(acct.id) ?? 0) + signed(e));
    }
    for (const [currency, total] of totals) {
      if (total !== 0) {
        throw new ValidationError(`debits must equal credits; ${currency} is off by ${total}`, { currency, difference: total });
      }
    }

    // 3. Lock balances in a consistent order
    const ids = [...deltas.keys()].sort((a, b) => a - b);
    const locked = await tx.query<{ account_id: number; balance: number }>(
      'SELECT account_id, balance FROM account_balances WHERE account_id = ANY($1::bigint[]) ORDER BY account_id FOR UPDATE',
      [ids],
    );

    // 4. Overdraft rules
    const guards = new Set(input.guards ?? []);
    const byId = new Map([...byCode.values()].map((a) => [a.id, a]));
    for (const row of locked.rows) {
      const acct = byId.get(row.account_id)!;
      const delta = toNormalBalance(acct.type, deltas.get(acct.id)!);
      const after = toNormalBalance(acct.type, row.balance) + delta;
      const mustStayNonNegative = !acct.allowNegative || guards.has(acct.code);
      if (mustStayNonNegative && delta < 0 && after < 0) {
        throw new InsufficientFundsError(acct.code, toNormalBalance(acct.type, row.balance), -delta);
      }
    }

    // 5. Write entries + update the balance cache
    await tx.query(
      `INSERT INTO entries (transaction_id, account_id, amount, currency)
       SELECT $1, * FROM unnest($2::bigint[], $3::bigint[], $4::text[])`,
      [
        txId,
        input.entries.map((e) => byCode.get(e.account)!.id),
        input.entries.map(signed),
        input.entries.map((e) => byCode.get(e.account)!.currency),
      ],
    );
    await tx.query(
      `UPDATE account_balances b
       SET balance = b.balance + d.delta, version = b.version + 1, updated_at = now()
       FROM unnest($1::bigint[], $2::bigint[]) AS d(account_id, delta)
       WHERE b.account_id = d.account_id`,
      [ids, ids.map((id) => deltas.get(id)!)],
    );

    return { transaction: await loadTransaction(tx, txId), replayed: false };
  });
}

/**
 * Undo a transaction by posting its mirror image. We never delete or edit:
 * the original and the reversal both stay in history, and auditors see both.
 */
export async function reverseTransaction(
  db: Db,
  id: number,
  opts: { idempotencyKey: string; reason: string },
): Promise<PostResult> {
  const original = await withTransaction(db, (tx) => loadTransaction(tx, id));
  if (original.reversesId !== null) throw new ValidationError('a reversal cannot itself be reversed; post a new transaction instead');
  try {
    return await postTransaction(
      db,
      {
        idempotencyKey: opts.idempotencyKey,
        description: `Reversal of #${id}: ${opts.reason}`,
        externalRef: original.externalRef,
        metadata: { reason: opts.reason },
        entries: original.entries.map((e) => ({
          account: e.account,
          amount: e.amount,
          direction: e.direction === 'debit' ? 'credit' : 'debit',
        })),
      },
      { reversesId: id },
    );
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23505' && e.constraint === 'ledger_transactions_reverses_id_key') throw new AlreadyReversedError(id);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function loadTransaction(db: Db | Tx, id: number): Promise<PostedTransaction> {
  const header = (
    await db.query<{
      id: number;
      idempotency_key: string;
      description: string;
      external_ref: string | null;
      reverses_id: number | null;
      metadata: Record<string, unknown>;
      effective_at: Date;
      created_at: Date;
    }>('SELECT * FROM ledger_transactions WHERE id = $1', [id])
  ).rows[0];
  if (!header) throw new TransactionNotFoundError(id);
  const entries = (
    await db.query<{ id: number; code: string; amount: number; currency: string }>(
      `SELECT e.id, a.code, e.amount, e.currency
       FROM entries e JOIN accounts a ON a.id = e.account_id
       WHERE e.transaction_id = $1 ORDER BY e.id`,
      [id],
    )
  ).rows;
  return {
    id: header.id,
    idempotencyKey: header.idempotency_key,
    description: header.description,
    externalRef: header.external_ref,
    reversesId: header.reverses_id,
    metadata: header.metadata,
    effectiveAt: header.effective_at,
    createdAt: header.created_at,
    entries: entries.map((e) => ({
      id: e.id,
      account: e.code,
      direction: e.amount > 0 ? 'debit' : 'credit',
      amount: Math.abs(e.amount),
      currency: e.currency,
    })),
  };
}

export interface StatementLine {
  entryId: number;
  transactionId: number;
  description: string;
  direction: Direction;
  amount: number;
  effectiveAt: Date;
}

/** Account history, newest first, with keyset (cursor) pagination: pass the last entryId as `beforeId`. */
export async function listEntries(db: Db, code: string, opts: { limit?: number; beforeId?: number } = {}): Promise<StatementLine[]> {
  const account = await getAccount(db, code);
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const rows = (
    await db.query<{ id: number; transaction_id: number; description: string; amount: number; effective_at: Date }>(
      `SELECT e.id, e.transaction_id, t.description, e.amount, t.effective_at
       FROM entries e JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE e.account_id = $1 AND ($2::bigint IS NULL OR e.id < $2)
       ORDER BY e.id DESC LIMIT $3`,
      [account.id, opts.beforeId ?? null, limit],
    )
  ).rows;
  return rows.map((r) => ({
    entryId: r.id,
    transactionId: r.transaction_id,
    description: r.description,
    direction: r.amount > 0 ? 'debit' : 'credit',
    amount: Math.abs(r.amount),
    effectiveAt: r.effective_at,
  }));
}

// ---------------------------------------------------------------------------
// Reports and invariants
// ---------------------------------------------------------------------------

export interface TrialBalance {
  accounts: { code: string; type: AccountType; currency: string; debit: number; credit: number; balance: number }[];
  totals: Record<string, { debit: number; credit: number }>;
  balanced: boolean;
}

/** Classic accounting check: total debit balances = total credit balances, per currency. */
export async function trialBalance(db: Db): Promise<TrialBalance> {
  const rows = (
    await db.query<{ code: string; type: AccountType; currency: string; signed: number }>(
      `SELECT a.code, a.type, a.currency, COALESCE(sum(e.amount), 0)::bigint AS signed
       FROM accounts a LEFT JOIN entries e ON e.account_id = a.id
       GROUP BY a.id ORDER BY a.currency, a.code`,
    )
  ).rows;
  const totals: TrialBalance['totals'] = {};
  const accounts = rows.map((r) => {
    const t = (totals[r.currency] ??= { debit: 0, credit: 0 });
    const debit = r.signed > 0 ? r.signed : 0;
    const credit = r.signed < 0 ? -r.signed : 0;
    t.debit += debit;
    t.credit += credit;
    return { code: r.code, type: r.type, currency: r.currency, debit, credit, balance: toNormalBalance(r.type, r.signed) };
  });
  return { accounts, totals, balanced: Object.values(totals).every((t) => t.debit === t.credit) };
}

export interface IntegrityReport {
  ok: boolean;
  unbalancedTransactions: { transactionId: number; currency: string; difference: number }[];
  cacheMismatches: { account: string; cached: number; actual: number }[];
  overdrawnAccounts: { account: string; balance: number }[];
}

/**
 * Run this on a schedule (and alert on failure). It proves the invariants
 * from the raw entries, independently of the code that wrote them.
 */
export async function checkIntegrity(db: Db): Promise<IntegrityReport> {
  const unbalanced = (
    await db.query<{ transaction_id: number; currency: string; difference: number }>(
      `SELECT transaction_id, currency, sum(amount)::bigint AS difference
       FROM entries GROUP BY transaction_id, currency HAVING sum(amount) <> 0`,
    )
  ).rows;
  const mismatches = (
    await db.query<{ code: string; cached: number; actual: number }>(
      `SELECT a.code, b.balance AS cached, COALESCE(s.total, 0)::bigint AS actual
       FROM account_balances b
       JOIN accounts a ON a.id = b.account_id
       LEFT JOIN (SELECT account_id, sum(amount) AS total FROM entries GROUP BY account_id) s ON s.account_id = b.account_id
       WHERE b.balance <> COALESCE(s.total, 0)`,
    )
  ).rows;
  const overdrawn = (
    await db.query<{ code: string; balance: number }>(
      `SELECT a.code, CASE WHEN a.type IN ('asset', 'expense') THEN b.balance ELSE -b.balance END AS balance
       FROM accounts a JOIN account_balances b ON b.account_id = a.id
       WHERE NOT a.allow_negative
         AND CASE WHEN a.type IN ('asset', 'expense') THEN b.balance ELSE -b.balance END < 0`,
    )
  ).rows;
  return {
    ok: unbalanced.length === 0 && mismatches.length === 0 && overdrawn.length === 0,
    unbalancedTransactions: unbalanced.map((r) => ({ transactionId: r.transaction_id, currency: r.currency, difference: r.difference })),
    cacheMismatches: mismatches.map((r) => ({ account: r.code, cached: r.cached, actual: r.actual })),
    overdrawnAccounts: overdrawn.map((r) => ({ account: r.code, balance: r.balance })),
  };
}
