import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { setupPlatformAccounts } from '../src/flows.js';
import { db, useFreshDatabase } from './helpers.js';

useFreshDatabase();

const app = createApp(db);

const charge = {
  type: 'charge.succeeded',
  data: { chargeId: 'ch_1', merchantId: 'm1', currency: 'USD', amount: 10000, processorFee: 320, platformFee: 500 },
};

async function setup() {
  await setupPlatformAccounts(db, 'USD');
  await request(app).post('/accounts').send({ code: 'liabilities:merchant:m1:usd', name: 'm1', type: 'liability', currency: 'USD' }).expect(201);
}

describe('HTTP API', () => {
  it('POST /transactions needs an Idempotency-Key header', async () => {
    await setup();
    const res = await request(app).post('/transactions').send({ description: 'x', entries: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('validation_error');
  });

  it('201 on first post, 200 + Idempotent-Replayed on retry, 409 on key reuse', async () => {
    await setup();
    const body = {
      description: 'manual',
      entries: [
        { account: 'assets:processor_receivable:usd', direction: 'debit', amount: 100 },
        { account: 'revenue:platform_fees:usd', direction: 'credit', amount: 100 },
      ],
    };
    const first = await request(app).post('/transactions').set('Idempotency-Key', 'k1').send(body).expect(201);
    const retry = await request(app).post('/transactions').set('Idempotency-Key', 'k1').send(body).expect(200);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body.id).toBe(first.body.id);
    const conflict = await request(app).post('/transactions').set('Idempotency-Key', 'k1').send({ ...body, description: 'other' });
    expect(conflict.status).toBe(409);
  });

  it('webhooks are idempotent and unknown event types are acknowledged', async () => {
    await setup();
    const a = await request(app).post('/webhooks/processor').send(charge).expect(200);
    const b = await request(app).post('/webhooks/processor').send(charge).expect(200);
    expect(b.body).toMatchObject({ replayed: true, transactionId: a.body.transactionId });
    await request(app).post('/webhooks/processor').send({ type: 'customer.updated', data: {} }).expect(200, { received: true, ignored: true });
  });

  it('merchant payout returns 422 when it would overpay', async () => {
    await setup();
    await request(app).post('/webhooks/processor').send(charge);
    const res = await request(app).post('/merchants/m1/payouts').set('Idempotency-Key', 'mp1').send({ currency: 'USD', amount: 999999 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('insufficient_funds');
  });

  it('GET /accounts/:code returns balance and a page of entries', async () => {
    await setup();
    await request(app).post('/webhooks/processor').send(charge);
    const res = await request(app).get('/accounts/liabilities:merchant:m1:usd').expect(200);
    expect(res.body.balance).toBe(9500);
    expect(res.body.entries).toHaveLength(1);
  });

  it('reports: trial balance and integrity', async () => {
    await setup();
    await request(app).post('/webhooks/processor').send(charge);
    expect((await request(app).get('/reports/trial-balance').expect(200)).body.balanced).toBe(true);
    expect((await request(app).get('/reports/integrity').expect(200)).body.ok).toBe(true);
  });

  it('reverses a transaction once, then 409', async () => {
    await setup();
    const { body } = await request(app).post('/webhooks/processor').send(charge);
    await request(app).post(`/transactions/${body.transactionId}/reverse`).set('Idempotency-Key', 'r1').send({ reason: 'test' }).expect(201);
    const again = await request(app).post(`/transactions/${body.transactionId}/reverse`).set('Idempotency-Key', 'r2').send({ reason: 'test' });
    expect(again.status).toBe(409);
  });
});
