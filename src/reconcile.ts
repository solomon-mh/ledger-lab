/**
 * Three-way reconciliation:
 *
 *   OUR LEDGER  <->  PROCESSOR REPORT  <->  BANK STATEMENT
 *
 * 1. Ledger vs processor: for every processor object (charge, refund,
 *    dispute, payout), the net movement the processor reports must equal the
 *    movement on our processor_receivable account for the same reference.
 * 2. Processor vs itself: each payout must equal the sum of the rows it contains.
 * 3. Processor vs bank: each payout must show up in the bank with the same amount.
 * 4. Bank vs ledger: each deposit must be recorded in our ledger.
 *
 * Anything that doesn't match is a "break" for a human (or a rule) to resolve.
 */
import type { Db } from './db.js';
import { ValidationError } from './errors.js';
import { chart } from './flows.js';
import { getAccount } from './ledger.js';

export interface ProcessorRow {
  id: string;
  type: string; // charge | refund | dispute | dispute_won | payout | ...
  source: string; // ch_..., re_..., dp_..., po_...
  amount: number;
  fee: number;
  net: number; // amount - fee; signed from OUR point of view (+ = processor owes us more)
  currency: string;
  payoutId: string | null;
  created: string;
}

export interface BankRow {
  date: string;
  reference: string;
  description: string;
  amount: number;
  currency: string;
}

export type BreakKind =
  | 'missing_in_ledger' // processor has it, we don't (e.g. a lost webhook)
  | 'missing_at_processor' // we have it, processor doesn't (e.g. a bug, or test data)
  | 'amount_mismatch' // both have it, amounts differ (e.g. wrong fee)
  | 'processor_row_inconsistent' // amount - fee != net inside the processor file
  | 'payout_composition_mismatch' // payout != sum of its rows
  | 'missing_bank_deposit' // payout never reached the bank
  | 'bank_amount_mismatch' // bank received a different amount
  | 'unexpected_bank_deposit' // money in bank we can't explain
  | 'deposit_not_recorded_in_ledger'; // bank has it, ledger hasn't recorded arrival

export interface Break {
  kind: BreakKind;
  reference: string;
  expected?: number;
  actual?: number;
  difference?: number;
  detail: string;
}

export interface ReconciliationReport {
  currency: string;
  window: { from: string | null; to: string | null };
  summary: { processorRows: number; referencesChecked: number; matched: number; breaks: number };
  matched: string[];
  breaks: Break[];
}

// ---------------------------------------------------------------------------
// CSV parsing (small RFC 4180 parser: handles quotes, commas and "" escapes)
// ---------------------------------------------------------------------------

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells, i) => {
    if (cells.length !== header.length) {
      throw new ValidationError(`CSV line ${i + 2}: expected ${header.length} columns, got ${cells.length}`);
    }
    return Object.fromEntries(header.map((h, j) => [h.trim(), (cells[j] ?? '').trim()]));
  });
}

function int(row: Record<string, string>, field: string, line: number): number {
  const raw = row[field] ?? '';
  if (!/^-?\d+$/.test(raw)) throw new ValidationError(`CSV line ${line}: ${field} must be an integer in minor units, got "${raw}"`);
  return Number(raw);
}

function requireColumns(rows: Record<string, string>[], cols: string[], name: string) {
  const first = rows[0];
  if (!first) return;
  const missing = cols.filter((c) => !(c in first));
  if (missing.length) throw new ValidationError(`${name} CSV is missing column(s): ${missing.join(', ')}`);
}

export function parseProcessorCsv(text: string): ProcessorRow[] {
  const rows = parseCsv(text);
  requireColumns(rows, ['id', 'type', 'source', 'amount', 'fee', 'net', 'currency', 'payout_id', 'created'], 'processor');
  return rows.map((r, i) => ({
    id: r.id!,
    type: r.type!,
    source: r.source!,
    amount: int(r, 'amount', i + 2),
    fee: int(r, 'fee', i + 2),
    net: int(r, 'net', i + 2),
    currency: r.currency!.toUpperCase(),
    payoutId: r.payout_id || null,
    created: r.created!,
  }));
}

export function parseBankCsv(text: string): BankRow[] {
  const rows = parseCsv(text);
  requireColumns(rows, ['date', 'reference', 'description', 'amount', 'currency'], 'bank');
  return rows.map((r, i) => ({
    date: r.date!,
    reference: r.reference!,
    description: r.description!,
    amount: int(r, 'amount', i + 2),
    currency: r.currency!.toUpperCase(),
  }));
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

export async function reconcile(
  db: Db,
  opts: { currency: string; processorRows: ProcessorRow[]; bankRows: BankRow[]; from?: string; to?: string },
): Promise<ReconciliationReport> {
  const currency = opts.currency.toUpperCase();
  const processorRows = opts.processorRows.filter((r) => r.currency === currency);
  const bankRows = opts.bankRows.filter((r) => r.currency === currency);
  const breaks: Break[] = [];
  const matched: string[] = [];

  // Processor file sanity
  for (const r of processorRows) {
    if (r.amount - r.fee !== r.net) {
      breaks.push({ kind: 'processor_row_inconsistent', reference: r.id, expected: r.amount - r.fee, actual: r.net,
        difference: r.net - (r.amount - r.fee), detail: `${r.id}: amount ${r.amount} - fee ${r.fee} != net ${r.net}` });
    }
  }

  // Processor side, grouped by source object (a dispute can have an "opened" and a "won" row)
  const processorNet = new Map<string, number>();
  for (const r of processorRows) processorNet.set(r.source, (processorNet.get(r.source) ?? 0) + r.net);

  // Ledger side: movements on processor_receivable, grouped by external_ref
  const receivable = await getAccount(db, chart.processorReceivable(currency));
  const ledgerRows = (
    await db.query<{ external_ref: string | null; net: number }>(
      `SELECT t.external_ref, sum(e.amount)::bigint AS net
       FROM entries e JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE e.account_id = $1
         AND (t.external_ref = ANY($2::text[])
              OR ($3::timestamptz IS NOT NULL AND t.effective_at >= $3 AND t.effective_at < $4))
       GROUP BY t.external_ref`,
      [receivable.id, [...processorNet.keys()], opts.from ?? null, opts.to ?? null],
    )
  ).rows;
  const ledgerNet = new Map(ledgerRows.map((r) => [r.external_ref ?? '(no reference)', r.net]));

  // 1. Ledger vs processor
  for (const [ref, expected] of processorNet) {
    const actual = ledgerNet.get(ref);
    if (actual === undefined) {
      breaks.push({ kind: 'missing_in_ledger', reference: ref, expected, detail: `processor reports ${ref} (net ${expected}) but the ledger has no entry for it` });
    } else if (actual !== expected) {
      breaks.push({ kind: 'amount_mismatch', reference: ref, expected, actual, difference: actual - expected,
        detail: `${ref}: processor net ${expected}, ledger net ${actual}` });
    } else matched.push(ref);
  }
  for (const [ref, actual] of ledgerNet) {
    if (!processorNet.has(ref)) {
      breaks.push({ kind: 'missing_at_processor', reference: ref, actual, detail: `ledger has ${ref} (net ${actual}) inside the window but the processor report does not` });
    }
  }

  // 2. Payout composition
  const payouts = processorRows.filter((r) => r.type === 'payout');
  for (const p of payouts) {
    const payoutAmount = -p.net;
    const contents = processorRows.filter((r) => r.payoutId === p.source && r.type !== 'payout').reduce((s, r) => s + r.net, 0);
    if (contents !== payoutAmount) {
      breaks.push({ kind: 'payout_composition_mismatch', reference: p.source, expected: contents, actual: payoutAmount,
        difference: payoutAmount - contents, detail: `payout ${p.source} is ${payoutAmount} but its rows add up to ${contents}` });
    }
  }

  // 3 + 4. Processor vs bank vs ledger
  const usedBankRows = new Set<BankRow>();
  for (const p of payouts) {
    const payoutAmount = -p.net;
    const deposit = bankRows.find((b) => b.reference === p.source && !usedBankRows.has(b));
    if (!deposit) {
      breaks.push({ kind: 'missing_bank_deposit', reference: p.source, expected: payoutAmount, detail: `payout ${p.source} (${payoutAmount}) not found in the bank statement` });
      continue;
    }
    usedBankRows.add(deposit);
    if (deposit.amount !== payoutAmount) {
      breaks.push({ kind: 'bank_amount_mismatch', reference: p.source, expected: payoutAmount, actual: deposit.amount,
        difference: deposit.amount - payoutAmount, detail: `bank received ${deposit.amount} for ${p.source}, expected ${payoutAmount}` });
    }
    const arrived = await db.query('SELECT 1 FROM ledger_transactions WHERE idempotency_key = $1', [`payout:${p.source}:arrived`]);
    if (arrived.rowCount === 0) {
      breaks.push({ kind: 'deposit_not_recorded_in_ledger', reference: p.source, expected: deposit.amount,
        detail: `bank shows ${p.source} but the ledger has not recorded its arrival` });
    }
  }
  // Other bank lines (interest, our own merchant payouts...) must match a ledger
  // movement on the bank account that carries the same reference.
  const bank = await getAccount(db, chart.bank(currency));
  for (const b of bankRows) {
    if (usedBankRows.has(b)) continue;
    const recorded = b.reference
      ? (
          await db.query<{ net: number | null }>(
            `SELECT sum(e.amount)::bigint AS net FROM entries e JOIN ledger_transactions t ON t.id = e.transaction_id
             WHERE e.account_id = $1 AND t.external_ref = $2`,
            [bank.id, b.reference],
          )
        ).rows[0]?.net
      : null;
    if (recorded === b.amount) matched.push(b.reference);
    else {
      breaks.push({ kind: 'unexpected_bank_deposit', reference: b.reference || b.description, actual: b.amount,
        expected: recorded ?? undefined,
        detail: `bank line "${b.description}" (${b.amount}) on ${b.date} matches no payout or ledger entry` });
    }
  }

  return {
    currency,
    window: { from: opts.from ?? null, to: opts.to ?? null },
    summary: { processorRows: processorRows.length, referencesChecked: processorNet.size, matched: matched.length, breaks: breaks.length },
    matched,
    breaks,
  };
}
