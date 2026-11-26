/**
 * npm run demo
 *
 * One day at a marketplace, end to end:
 *   1. Customers pay, one refunds, one charges back. The processor pays us out.
 *   2. One webhook got lost and our fee config is 5 cents off (realistic bugs).
 *   3. Reconciliation catches both, plus bank interest we never recorded.
 *   4. We fix them with explained, append-only corrections and re-run: clean.
 *   5. We try to overpay the merchant: blocked. Then pay them correctly.
 */
import { readFile } from 'node:fs/promises';
import { createPool, resetDatabase } from '../src/db.js';
import { LedgerError } from '../src/errors.js';
import * as f from '../src/flows.js';
import { checkIntegrity, createAccount, getBalance, trialBalance } from '../src/ledger.js';
import { formatMoney } from '../src/money.js';
import { parseBankCsv, parseProcessorCsv, reconcile, type ReconciliationReport } from '../src/reconcile.js';

const CUR = 'USD';
const M = 'm_42'; // our merchant (think: a landlord on a rent platform)
const db = createPool();
const $ = (n: number) => formatMoney(n, CUR);
const title = (s: string) => console.log(`\n\x1b[1m== ${s} ==\x1b[0m`);

async function balances(codes: string[]) {
  for (const code of codes) {
    const b = await getBalance(db, code);
    console.log(`  ${code.padEnd(40)} ${$(b.balance).padStart(14)}`);
  }
}

function printReport(r: ReconciliationReport) {
  console.log(`  checked ${r.summary.referencesChecked} references: ${r.summary.matched} matched, ${r.summary.breaks} break(s)`);
  for (const b of r.breaks) console.log(`  \x1b[31m✗ ${b.kind.padEnd(26)}\x1b[0m ${b.detail}`);
  if (!r.breaks.length) console.log('  \x1b[32m✓ ledger, processor and bank all agree\x1b[0m');
}

await resetDatabase(db);
await f.setupPlatformAccounts(db, CUR);
await f.openMerchantAccount(db, M, CUR);
await createAccount(db, { code: 'revenue:interest:usd', name: 'Bank interest', type: 'revenue', currency: CUR });
await createAccount(db, { code: 'equity:owner_capital:usd', name: 'Owner capital', type: 'equity', currency: CUR });
// The company already had 1,000.00 in the bank before today (opening balance).
await f.postAdjustment(db, {
  adjustmentId: 'opening-balance', reason: 'Opening bank balance', externalRef: 'CAPITAL-001', approvedBy: 'finance@platform',
  entries: [{ account: f.chart.bank(CUR), direction: 'debit', amount: 100000 }, { account: 'equity:owner_capital:usd', direction: 'credit', amount: 100000 }],
});

title('1. The day happens (webhooks from the processor)');
const day = '2026-11-20';
await f.recordCharge(db, { chargeId: 'ch_1', merchantId: M, currency: CUR, amount: 10000, processorFee: 320, platformFee: 500, effectiveAt: `${day}T08:15:00Z` });
// BUG #1: our fee table says 750, the processor actually charged 755.
await f.recordCharge(db, { chargeId: 'ch_2', merchantId: M, currency: CUR, amount: 25000, processorFee: 750, platformFee: 1250, effectiveAt: `${day}T09:40:00Z` });
await f.recordCharge(db, { chargeId: 'ch_3', merchantId: M, currency: CUR, amount: 5000, processorFee: 175, platformFee: 250, effectiveAt: `${day}T11:05:00Z` });
// BUG #2: the webhook for ch_4 never arrived (our server was deploying).
await f.recordRefund(db, { refundId: 're_1', chargeId: 'ch_2', merchantId: M, currency: CUR, amount: 5000, platformFeeRefunded: 250, effectiveAt: `${day}T15:00:00Z` });
await f.recordDisputeOpened(db, { disputeId: 'dp_1', chargeId: 'ch_3', merchantId: M, currency: CUR, amount: 5000, disputeFee: 1500, platformFee: 250, effectiveAt: `${day}T17:20:00Z` });
await f.recordProcessorPayout(db, { payoutId: 'po_1', currency: CUR, amount: 34988, effectiveAt: `${day}T23:59:00Z` });
await f.recordBankDeposit(db, { payoutId: 'po_1', currency: CUR, amount: 34988, effectiveAt: '2026-11-21T09:00:00Z' });

// Webhooks are retried. Posting the same charge again changes nothing:
const replay = await f.recordCharge(db, { chargeId: 'ch_1', merchantId: M, currency: CUR, amount: 10000, processorFee: 320, platformFee: 500, effectiveAt: `${day}T08:15:00Z` });
console.log(`  duplicate webhook for ch_1 -> replayed=${replay.replayed} (no double posting)`);

await balances([f.chart.processorReceivable(CUR), f.chart.bank(CUR), f.chart.merchant(M, CUR), f.chart.platformRevenue(CUR)]);
console.log('  ^ processor receivable is NEGATIVE: the processor paid us more than we think it owed. Something is missing.');

title('2. Reconcile: ledger vs processor report vs bank statement');
const processorRows = parseProcessorCsv(await readFile(new URL('../fixtures/processor_report_2026-11-20.csv', import.meta.url), 'utf8'));
const bankRows = parseBankCsv(await readFile(new URL('../fixtures/bank_statement_2026-11-21.csv', import.meta.url), 'utf8'));
const window = { from: `${day}T00:00:00Z`, to: '2026-11-22T00:00:00Z' };
printReport(await reconcile(db, { currency: CUR, processorRows, bankRows, ...window }));

title('3. Resolve each break with an append-only correction');
await f.recordCharge(db, { chargeId: 'ch_4', merchantId: M, currency: CUR, amount: 8000, processorFee: 262, platformFee: 400, effectiveAt: `${day}T13:30:00Z` });
console.log('  ch_4: replayed the missed webhook from the processor API');
await f.postAdjustment(db, {
  adjustmentId: 'recon-2026-11-20-ch_2-fee', reason: 'ch_2 processor fee was 755, we recorded 750', externalRef: 'ch_2', approvedBy: 'finance@platform',
  entries: [{ account: f.chart.processorFees(CUR), direction: 'debit', amount: 5 }, { account: f.chart.processorReceivable(CUR), direction: 'credit', amount: 5 }],
});
console.log('  ch_2: posted a 5-cent fee adjustment (and filed a ticket to fix the fee table)');
await f.postAdjustment(db, {
  adjustmentId: 'interest-2026-11', reason: 'November bank interest', externalRef: 'INT-2026-11', approvedBy: 'finance@platform',
  entries: [{ account: f.chart.bank(CUR), direction: 'debit', amount: 12 }, { account: 'revenue:interest:usd', direction: 'credit', amount: 12 }],
});
console.log('  INT-2026-11: recorded bank interest');
printReport(await reconcile(db, { currency: CUR, processorRows, bankRows, ...window }));
await balances([f.chart.processorReceivable(CUR), f.chart.payoutsInTransit(CUR), f.chart.bank(CUR), f.chart.merchant(M, CUR)]);
const pnl = (await trialBalance(db)).accounts
  .filter((a) => a.type === 'revenue' || a.type === 'expense')
  .reduce((sum, a) => sum + (a.type === 'revenue' ? a.balance : -a.balance), 0);
console.log(`  platform profit today: ${$(pnl)} (fee revenue + interest - processor fees - the 15.00 chargeback fee)`);
console.log('  -> the processor sent less than we owe the merchant; the difference is our own loss, paid from company cash.');

title('4. Pay the merchant');
try {
  await f.payOutMerchant(db, { merchantPayoutId: 'mp_1', merchantId: M, currency: CUR, amount: 50000 });
} catch (err) {
  if (!(err instanceof LedgerError)) throw err;
  console.log(`  \x1b[31m✗ ${err.code}\x1b[0m ${err.message}`);
}
const owed = (await getBalance(db, f.chart.merchant(M, CUR))).balance;
await f.payOutMerchant(db, { merchantPayoutId: 'mp_2', merchantId: M, currency: CUR, amount: owed });
console.log(`  \x1b[32m✓\x1b[0m paid ${$(owed)}, exactly what we owed`);
await balances([f.chart.merchant(M, CUR), f.chart.bank(CUR)]);

title('5. Invariants');
const tb = await trialBalance(db);
console.log(`  trial balance: debits ${$(tb.totals[CUR]!.debit)} = credits ${$(tb.totals[CUR]!.credit)} -> balanced=${tb.balanced}`);
const integrity = await checkIntegrity(db);
console.log(`  integrity check: ok=${integrity.ok} (every transaction sums to zero, cache = SUM(entries), no overdrawn accounts)`);
try {
  await db.query('UPDATE entries SET amount = amount * 2');
} catch (err) {
  console.log(`  tried "UPDATE entries SET amount = amount * 2" -> ${(err as Error).message}`);
}

await db.end();
