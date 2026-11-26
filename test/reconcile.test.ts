import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as f from '../src/flows.js';
import { parseBankCsv, parseCsv, parseProcessorCsv, reconcile } from '../src/reconcile.js';
import { db, useFreshDatabase } from './helpers.js';

useFreshDatabase();

const CUR = 'USD';
const M = 'm_42';
const fixture = async (name: string) => readFile(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');
const window = { from: '2026-11-20T00:00:00Z', to: '2026-11-22T00:00:00Z' };

/** Records the day exactly as the processor reports it. */
async function recordDay(opts: { ch2Fee?: number; skipCh4?: boolean } = {}) {
  await f.setupPlatformAccounts(db, CUR);
  await f.openMerchantAccount(db, M, CUR);
  const at = '2026-11-20T12:00:00Z';
  const charge = (chargeId: string, amount: number, processorFee: number, platformFee: number) =>
    f.recordCharge(db, { chargeId, merchantId: M, currency: CUR, amount, processorFee, platformFee, effectiveAt: at });
  await charge('ch_1', 10000, 320, 500);
  await charge('ch_2', 25000, opts.ch2Fee ?? 755, 1250);
  await charge('ch_3', 5000, 175, 250);
  if (!opts.skipCh4) await charge('ch_4', 8000, 262, 400);
  await f.recordRefund(db, { refundId: 're_1', chargeId: 'ch_2', merchantId: M, currency: CUR, amount: 5000, platformFeeRefunded: 250, effectiveAt: at });
  await f.recordDisputeOpened(db, { disputeId: 'dp_1', chargeId: 'ch_3', merchantId: M, currency: CUR, amount: 5000, disputeFee: 1500, platformFee: 250, effectiveAt: at });
  await f.recordProcessorPayout(db, { payoutId: 'po_1', currency: CUR, amount: 34988, effectiveAt: at });
  await f.recordBankDeposit(db, { payoutId: 'po_1', currency: CUR, amount: 34988, effectiveAt: '2026-11-21T09:00:00Z' });
}

async function run(bankCsv?: string) {
  return reconcile(db, {
    currency: CUR,
    processorRows: parseProcessorCsv(await fixture('processor_report_2026-11-20.csv')),
    bankRows: parseBankCsv(bankCsv ?? (await fixture('bank_statement_2026-11-21.csv'))),
    ...window,
  });
}

const kinds = (r: Awaited<ReturnType<typeof run>>) => r.breaks.map((b) => `${b.kind}:${b.reference}`).sort();

describe('CSV parsing', () => {
  it('handles quoted fields with commas and escaped quotes', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi"""\r\n')).toEqual([{ a: 'x, y', b: 'say "hi"' }]);
  });
  it('rejects non-integer amounts with the line number', () => {
    const csv = 'id,type,source,amount,fee,net,currency,payout_id,created\nbt,charge,ch,10.50,0,10.50,USD,,2026-01-01';
    expect(() => parseProcessorCsv(csv)).toThrow(/line 2: amount must be an integer/);
  });
});

describe('three-way reconciliation', () => {
  it('a perfectly recorded day only flags the unexplained bank interest', async () => {
    await recordDay();
    const report = await run();
    expect(kinds(report)).toEqual(['unexpected_bank_deposit:INT-2026-11']);
    expect(report.summary.matched).toBe(7);
  });

  it('catches a lost webhook and a wrong fee', async () => {
    await recordDay({ ch2Fee: 750, skipCh4: true });
    const report = await run();
    expect(kinds(report)).toEqual(['amount_mismatch:ch_2', 'missing_in_ledger:ch_4', 'unexpected_bank_deposit:INT-2026-11']);
    const mismatch = report.breaks.find((b) => b.kind === 'amount_mismatch')!;
    expect(mismatch).toMatchObject({ expected: 24245, actual: 24250, difference: 5 });
  });

  it('is clean once corrections are posted', async () => {
    await recordDay();
    await f.postAdjustment(db, {
      adjustmentId: 'int', reason: 'interest', externalRef: 'INT-2026-11', approvedBy: 'finance',
      entries: [
        { account: f.chart.bank(CUR), direction: 'debit', amount: 12 },
        { account: f.chart.platformRevenue(CUR), direction: 'credit', amount: 12 },
      ],
    });
    expect((await run()).breaks).toEqual([]);
  });

  it('flags ledger records the processor has never heard of', async () => {
    await recordDay();
    await f.recordCharge(db, { chargeId: 'ch_ghost', merchantId: M, currency: CUR, amount: 100, processorFee: 0, platformFee: 0, effectiveAt: '2026-11-20T20:00:00Z' });
    expect(kinds(await run())).toContain('missing_at_processor:ch_ghost');
  });

  it('flags a payout that never reached the bank, or arrived short', async () => {
    await recordDay();
    const header = 'date,reference,description,amount,currency\n';
    expect(kinds(await run(header))).toEqual(['missing_bank_deposit:po_1']);
    expect(kinds(await run(header + '2026-11-21,po_1,payout,34900,USD\n'))).toEqual(['bank_amount_mismatch:po_1']);
  });

  it('flags a deposit the bank shows but the ledger never recorded', async () => {
    await f.setupPlatformAccounts(db, CUR);
    const processor = 'id,type,source,amount,fee,net,currency,payout_id,created\nbt,payout,po_9,-100,0,-100,USD,po_9,2026-11-20\n';
    const report = await reconcile(db, {
      currency: CUR,
      processorRows: parseProcessorCsv(processor),
      bankRows: parseBankCsv('date,reference,description,amount,currency\n2026-11-21,po_9,payout,100,USD\n'),
    });
    expect(kinds(report)).toEqual(['deposit_not_recorded_in_ledger:po_9', 'missing_in_ledger:po_9', 'payout_composition_mismatch:po_9']);
  });
});
