/**
 * Business events -> ledger entries.
 *
 * The scenario: a marketplace (think a property-management or booking
 * platform). Customers pay through a card processor (Stripe-like). The
 * processor keeps a fee and later pays us out to our bank. We keep a
 * platform fee and owe the rest to the merchant (landlord, host, seller).
 *
 * Every function is idempotent: its key is derived from the PROCESSOR'S
 * object id (charge id, refund id...), not from a webhook event id, because
 * processors retry and can send the same fact more than once.
 */
import type { Db } from './db.js';
import { ValidationError } from './errors.js';
import { createAccount, postTransaction, type EntryInput, type PostResult } from './ledger.js';
import { assertMinorUnits } from './money.js';

const lc = (currency: string) => currency.toLowerCase();

/** Chart of accounts. One set per currency: never mix currencies in one account. */
export const chart = {
  processorReceivable: (cur: string) => `assets:processor_receivable:${lc(cur)}`, // money the processor holds for us
  payoutsInTransit: (cur: string) => `assets:payouts_in_transit:${lc(cur)}`, // sent by processor, not yet in bank
  bank: (cur: string) => `assets:bank:${lc(cur)}`,
  processorFees: (cur: string) => `expenses:processor_fees:${lc(cur)}`,
  disputeFees: (cur: string) => `expenses:dispute_fees:${lc(cur)}`,
  platformRevenue: (cur: string) => `revenue:platform_fees:${lc(cur)}`,
  merchant: (id: string, cur: string) => `liabilities:merchant:${id}:${lc(cur)}`, // what we owe a merchant
  wallet: (id: string, cur: string) => `liabilities:wallet:${id}:${lc(cur)}`, // a user's stored balance
};

const dr = (account: string, amount: number): EntryInput => ({ account, direction: 'debit', amount });
const cr = (account: string, amount: number): EntryInput => ({ account, direction: 'credit', amount });
/** Drop zero lines (e.g. a 0 fee) because the ledger rejects zero amounts. */
const lines = (...entries: EntryInput[]) => entries.filter((e) => e.amount !== 0);

function money(fields: Record<string, number>): void {
  for (const [name, value] of Object.entries(fields)) {
    assertMinorUnits(value, name);
    if (value < 0) throw new ValidationError(`${name} cannot be negative`);
  }
}

// ---------------------------------------------------------------------------
// Account setup
// ---------------------------------------------------------------------------

export async function setupPlatformAccounts(db: Db, currency: string): Promise<void> {
  await createAccount(db, { code: chart.processorReceivable(currency), name: 'Processor receivable', type: 'asset', currency });
  await createAccount(db, { code: chart.payoutsInTransit(currency), name: 'Payouts in transit', type: 'asset', currency });
  // allowNegative: false -> we can never send more money than the bank account holds.
  await createAccount(db, { code: chart.bank(currency), name: 'Operating bank account', type: 'asset', currency, allowNegative: false });
  await createAccount(db, { code: chart.processorFees(currency), name: 'Processor fees', type: 'expense', currency });
  await createAccount(db, { code: chart.disputeFees(currency), name: 'Dispute fees', type: 'expense', currency });
  await createAccount(db, { code: chart.platformRevenue(currency), name: 'Platform fee revenue', type: 'revenue', currency });
}

/** Merchant balances MAY go negative (a chargeback after payout); payouts are guarded instead. */
export async function openMerchantAccount(db: Db, merchantId: string, currency: string) {
  return createAccount(db, { code: chart.merchant(merchantId, currency), name: `Payable to merchant ${merchantId}`, type: 'liability', currency });
}

/** A wallet can never go below zero. */
export async function openWallet(db: Db, userId: string, currency: string) {
  return createAccount(db, { code: chart.wallet(userId, currency), name: `Wallet of ${userId}`, type: 'liability', currency, allowNegative: false });
}

// ---------------------------------------------------------------------------
// Card payment lifecycle
// ---------------------------------------------------------------------------

export interface ChargeInput {
  chargeId: string;
  merchantId: string;
  currency: string;
  amount: number; // what the customer paid
  processorFee: number; // what the processor kept
  platformFee: number; // what we keep
  effectiveAt?: Date | string;
}

/**
 * Customer pays 100.00, processor keeps 3.20, we keep 5.00:
 *   Dr processor_receivable   96.80   (processor now owes us this)
 *   Dr processor_fees          3.20   (our cost)
 *   Cr merchant               95.00   (we owe the merchant)
 *   Cr platform_revenue        5.00   (our income)
 */
export async function recordCharge(db: Db, c: ChargeInput): Promise<PostResult> {
  money({ amount: c.amount, processorFee: c.processorFee, platformFee: c.platformFee });
  if (c.amount === 0) throw new ValidationError('amount must be positive');
  if (c.processorFee > c.amount || c.platformFee > c.amount) throw new ValidationError('fees cannot exceed the charge amount');
  return postTransaction(db, {
    idempotencyKey: `charge:${c.chargeId}`,
    description: `Card payment ${c.chargeId} for merchant ${c.merchantId}`,
    externalRef: c.chargeId,
    metadata: { kind: 'charge', merchantId: c.merchantId, amount: c.amount },
    effectiveAt: c.effectiveAt,
    entries: lines(
      dr(chart.processorReceivable(c.currency), c.amount - c.processorFee),
      dr(chart.processorFees(c.currency), c.processorFee),
      cr(chart.merchant(c.merchantId, c.currency), c.amount - c.platformFee),
      cr(chart.platformRevenue(c.currency), c.platformFee),
    ),
  });
}

export interface RefundInput {
  refundId: string;
  chargeId: string;
  merchantId: string;
  currency: string;
  amount: number;
  platformFeeRefunded: number; // our policy: give back our fee proportionally
  effectiveAt?: Date | string;
}

/** The processor keeps its original fee on refunds, so processor_fees is not touched. */
export async function recordRefund(db: Db, r: RefundInput): Promise<PostResult> {
  money({ amount: r.amount, platformFeeRefunded: r.platformFeeRefunded });
  if (r.platformFeeRefunded > r.amount) throw new ValidationError('platformFeeRefunded cannot exceed the refund');
  return postTransaction(db, {
    idempotencyKey: `refund:${r.refundId}`,
    description: `Refund ${r.refundId} of charge ${r.chargeId}`,
    externalRef: r.refundId,
    metadata: { kind: 'refund', chargeId: r.chargeId, merchantId: r.merchantId },
    effectiveAt: r.effectiveAt,
    entries: lines(
      dr(chart.merchant(r.merchantId, r.currency), r.amount - r.platformFeeRefunded),
      dr(chart.platformRevenue(r.currency), r.platformFeeRefunded),
      cr(chart.processorReceivable(r.currency), r.amount),
    ),
  });
}

export interface DisputeInput {
  disputeId: string;
  chargeId: string;
  merchantId: string;
  currency: string;
  amount: number; // amount pulled back by the card issuer
  disputeFee: number; // network/processor penalty (platform absorbs it in this policy)
  platformFee: number; // our original fee on that charge, which we also give up
  effectiveAt?: Date | string;
}

/**
 * Chargeback opened: the processor immediately takes amount + fee from us.
 * We claw the money back from the merchant. This can push the merchant
 * negative if they were already paid out, which is allowed: they now owe us.
 */
export async function recordDisputeOpened(db: Db, d: DisputeInput): Promise<PostResult> {
  money({ amount: d.amount, disputeFee: d.disputeFee, platformFee: d.platformFee });
  return postTransaction(db, {
    idempotencyKey: `dispute:${d.disputeId}:opened`,
    description: `Chargeback ${d.disputeId} opened on charge ${d.chargeId}`,
    externalRef: d.disputeId,
    metadata: { kind: 'dispute_opened', chargeId: d.chargeId, merchantId: d.merchantId },
    effectiveAt: d.effectiveAt,
    entries: lines(
      dr(chart.merchant(d.merchantId, d.currency), d.amount - d.platformFee),
      dr(chart.platformRevenue(d.currency), d.platformFee),
      dr(chart.disputeFees(d.currency), d.disputeFee),
      cr(chart.processorReceivable(d.currency), d.amount + d.disputeFee),
    ),
  });
}

/** We won the dispute (evidence accepted): the amount comes back; the fee usually doesn't. */
export async function recordDisputeWon(db: Db, d: Omit<DisputeInput, 'disputeFee'>): Promise<PostResult> {
  money({ amount: d.amount, platformFee: d.platformFee });
  return postTransaction(db, {
    idempotencyKey: `dispute:${d.disputeId}:won`,
    description: `Chargeback ${d.disputeId} won`,
    externalRef: d.disputeId,
    metadata: { kind: 'dispute_won', chargeId: d.chargeId, merchantId: d.merchantId },
    effectiveAt: d.effectiveAt,
    entries: lines(
      dr(chart.processorReceivable(d.currency), d.amount),
      cr(chart.merchant(d.merchantId, d.currency), d.amount - d.platformFee),
      cr(chart.platformRevenue(d.currency), d.platformFee),
    ),
  });
}

// ---------------------------------------------------------------------------
// Settlement: processor -> our bank -> merchant
// ---------------------------------------------------------------------------

/** Processor says "payout sent". Money leaves the processor but is not in our bank yet. */
export async function recordProcessorPayout(db: Db, p: { payoutId: string; currency: string; amount: number; effectiveAt?: Date | string }) {
  money({ amount: p.amount });
  return postTransaction(db, {
    idempotencyKey: `payout:${p.payoutId}:sent`,
    description: `Processor payout ${p.payoutId} sent`,
    externalRef: p.payoutId,
    metadata: { kind: 'payout_sent' },
    effectiveAt: p.effectiveAt,
    entries: [dr(chart.payoutsInTransit(p.currency), p.amount), cr(chart.processorReceivable(p.currency), p.amount)],
  });
}

/** Our bank statement shows the deposit. In-transit clears; a non-zero in-transit balance means money is stuck. */
export async function recordBankDeposit(db: Db, p: { payoutId: string; currency: string; amount: number; effectiveAt?: Date | string }) {
  money({ amount: p.amount });
  return postTransaction(db, {
    idempotencyKey: `payout:${p.payoutId}:arrived`,
    description: `Processor payout ${p.payoutId} arrived in bank`,
    externalRef: p.payoutId,
    metadata: { kind: 'payout_arrived' },
    effectiveAt: p.effectiveAt,
    entries: [dr(chart.bank(p.currency), p.amount), cr(chart.payoutsInTransit(p.currency), p.amount)],
  });
}

/** Pay a merchant from our bank. Guarded: never pay out more than we owe them. */
export async function payOutMerchant(db: Db, p: { merchantPayoutId: string; merchantId: string; currency: string; amount: number }) {
  money({ amount: p.amount });
  const merchant = chart.merchant(p.merchantId, p.currency);
  return postTransaction(db, {
    idempotencyKey: `merchant_payout:${p.merchantPayoutId}`,
    description: `Payout ${p.merchantPayoutId} to merchant ${p.merchantId}`,
    externalRef: p.merchantPayoutId,
    metadata: { kind: 'merchant_payout', merchantId: p.merchantId },
    guards: [merchant],
    entries: [dr(merchant, p.amount), cr(chart.bank(p.currency), p.amount)],
  });
}

// ---------------------------------------------------------------------------
// Wallets (the classic "design Venmo / Telebirr" interview question)
// ---------------------------------------------------------------------------

export async function topUpWallet(db: Db, t: { topUpId: string; userId: string; currency: string; amount: number }) {
  money({ amount: t.amount });
  return postTransaction(db, {
    idempotencyKey: `topup:${t.topUpId}`,
    description: `Wallet top-up ${t.topUpId} for ${t.userId}`,
    externalRef: t.topUpId,
    entries: [dr(chart.processorReceivable(t.currency), t.amount), cr(chart.wallet(t.userId, t.currency), t.amount)],
  });
}

export async function transfer(db: Db, t: { transferId: string; from: string; to: string; currency: string; amount: number }) {
  money({ amount: t.amount });
  if (t.amount === 0) throw new ValidationError('amount must be positive');
  if (t.from === t.to) throw new ValidationError('cannot transfer to the same wallet');
  return postTransaction(db, {
    idempotencyKey: `transfer:${t.transferId}`,
    description: `Transfer ${t.transferId} from ${t.from} to ${t.to}`,
    entries: [dr(chart.wallet(t.from, t.currency), t.amount), cr(chart.wallet(t.to, t.currency), t.amount)],
  });
}

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

/** A manual, reviewed correction (e.g. found by reconciliation). Always explained, never an edit. */
export async function postAdjustment(
  db: Db,
  a: { adjustmentId: string; reason: string; externalRef?: string; approvedBy: string; entries: EntryInput[] },
) {
  if (!a.reason.trim() || !a.approvedBy.trim()) throw new ValidationError('adjustments need a reason and an approver');
  return postTransaction(db, {
    idempotencyKey: `adjustment:${a.adjustmentId}`,
    description: `Adjustment: ${a.reason}`,
    externalRef: a.externalRef ?? null,
    metadata: { kind: 'adjustment', approvedBy: a.approvedBy },
    entries: a.entries,
  });
}
