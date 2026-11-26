import { describe, expect, it } from 'vitest';
import { InsufficientFundsError, ValidationError } from '../src/errors.js';
import * as f from '../src/flows.js';
import { checkIntegrity, getBalance } from '../src/ledger.js';
import { db, useFreshDatabase } from './helpers.js';

useFreshDatabase();

const CUR = 'USD';
const M = 'm1';
const bal = async (code: string) => (await getBalance(db, code)).balance;

async function setup() {
  await f.setupPlatformAccounts(db, CUR);
  await f.openMerchantAccount(db, M, CUR);
}

const charge = (id: string, amount = 10000) =>
  f.recordCharge(db, { chargeId: id, merchantId: M, currency: CUR, amount, processorFee: 320, platformFee: 500 });

describe('card payment lifecycle', () => {
  it('a charge splits money between processor, fees, merchant and us', async () => {
    await setup();
    await charge('ch_1');
    expect(await bal(f.chart.processorReceivable(CUR))).toBe(9680);
    expect(await bal(f.chart.processorFees(CUR))).toBe(320);
    expect(await bal(f.chart.merchant(M, CUR))).toBe(9500);
    expect(await bal(f.chart.platformRevenue(CUR))).toBe(500);
  });

  it('a retried webhook does not double-count the charge', async () => {
    await setup();
    await charge('ch_1');
    const again = await charge('ch_1');
    expect(again.replayed).toBe(true);
    expect(await bal(f.chart.merchant(M, CUR))).toBe(9500);
  });

  it('a full refund: processor keeps its fee, so the platform eats it', async () => {
    await setup();
    await charge('ch_1');
    await f.recordRefund(db, { refundId: 're_1', chargeId: 'ch_1', merchantId: M, currency: CUR, amount: 10000, platformFeeRefunded: 500 });
    expect(await bal(f.chart.merchant(M, CUR))).toBe(0);
    expect(await bal(f.chart.platformRevenue(CUR))).toBe(0);
    expect(await bal(f.chart.processorReceivable(CUR))).toBe(-320); // we owe the processor the fee it kept
  });

  it('a chargeback after the merchant was paid leaves the merchant owing us', async () => {
    await setup();
    await charge('ch_1');
    await f.recordProcessorPayout(db, { payoutId: 'po_1', currency: CUR, amount: 9680 });
    await f.recordBankDeposit(db, { payoutId: 'po_1', currency: CUR, amount: 9680 });
    await f.payOutMerchant(db, { merchantPayoutId: 'mp_1', merchantId: M, currency: CUR, amount: 9500 });

    await f.recordDisputeOpened(db, { disputeId: 'dp_1', chargeId: 'ch_1', merchantId: M, currency: CUR, amount: 10000, disputeFee: 1500, platformFee: 500 });

    expect(await bal(f.chart.merchant(M, CUR))).toBe(-9500); // negative = merchant owes the platform
    expect(await bal(f.chart.disputeFees(CUR))).toBe(1500);
    expect(await bal(f.chart.processorReceivable(CUR))).toBe(-11500);

    // ...and no further payouts are possible while they owe us
    await expect(f.payOutMerchant(db, { merchantPayoutId: 'mp_2', merchantId: M, currency: CUR, amount: 1 })).rejects.toThrow(
      InsufficientFundsError,
    );
  });

  it('winning the dispute restores the merchant balance (dispute fee is not returned)', async () => {
    await setup();
    await charge('ch_1');
    const d = { disputeId: 'dp_1', chargeId: 'ch_1', merchantId: M, currency: CUR, amount: 10000, platformFee: 500 };
    await f.recordDisputeOpened(db, { ...d, disputeFee: 1500 });
    await f.recordDisputeWon(db, d);
    expect(await bal(f.chart.merchant(M, CUR))).toBe(9500);
    expect(await bal(f.chart.platformRevenue(CUR))).toBe(500);
    expect(await bal(f.chart.disputeFees(CUR))).toBe(1500);
  });

  it('money in transit clears when the bank deposit is recorded', async () => {
    await setup();
    await charge('ch_1');
    await f.recordProcessorPayout(db, { payoutId: 'po_1', currency: CUR, amount: 9680 });
    expect(await bal(f.chart.payoutsInTransit(CUR))).toBe(9680);
    await f.recordBankDeposit(db, { payoutId: 'po_1', currency: CUR, amount: 9680 });
    expect(await bal(f.chart.payoutsInTransit(CUR))).toBe(0);
    expect(await bal(f.chart.bank(CUR))).toBe(9680);
    expect((await checkIntegrity(db)).ok).toBe(true);
  });

  it('cannot pay out more than the bank holds, even if the merchant is owed it', async () => {
    await setup();
    await charge('ch_1'); // merchant owed 95.00, but nothing has reached the bank yet
    await expect(f.payOutMerchant(db, { merchantPayoutId: 'mp_1', merchantId: M, currency: CUR, amount: 9500 })).rejects.toThrow(
      /assets:bank:usd/,
    );
  });

  it('validates flow inputs', async () => {
    await setup();
    await expect(charge('ch_x', -100)).rejects.toThrow(ValidationError);
    await expect(
      f.recordCharge(db, { chargeId: 'c', merchantId: M, currency: CUR, amount: 100, processorFee: 200, platformFee: 0 }),
    ).rejects.toThrow(/fees cannot exceed/);
    await expect(f.transfer(db, { transferId: 't', from: 'a', to: 'a', currency: CUR, amount: 1 })).rejects.toThrow(/same wallet/);
  });
});
