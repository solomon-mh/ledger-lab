import express, { type NextFunction, type Request, type Response } from 'express';
import type { Db } from './db.js';
import { LedgerError, ValidationError } from './errors.js';
import * as flows from './flows.js';
import {
  checkIntegrity,
  createAccount,
  getBalance,
  listEntries,
  loadTransaction,
  postTransaction,
  reverseTransaction,
  trialBalance,
} from './ledger.js';
import { parseBankCsv, parseProcessorCsv, reconcile } from './reconcile.js';

function idempotencyKey(req: Request): string {
  const key = req.header('Idempotency-Key');
  if (!key) throw new ValidationError('the Idempotency-Key header is required for this endpoint');
  return key;
}

function positiveInt(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ValidationError(`${name} must be a positive integer`);
  return n;
}

/** Processor webhook event types we understand, mapped to ledger flows. */
const webhookHandlers: Record<string, (db: Db, data: any) => Promise<unknown>> = {
  'charge.succeeded': flows.recordCharge,
  'charge.refunded': flows.recordRefund,
  'dispute.created': flows.recordDisputeOpened,
  'dispute.won': flows.recordDisputeWon,
  'payout.sent': flows.recordProcessorPayout,
  'payout.arrived': flows.recordBankDeposit,
};

export function createApp(db: Db) {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true });
  });

  // --- Accounts -------------------------------------------------------------
  app.post('/accounts', async (req, res) => {
    res.status(201).json(await createAccount(db, req.body));
  });

  app.get('/accounts/:code', async (req, res) => {
    const limit = positiveInt(req.query.limit, 'limit');
    const beforeId = positiveInt(req.query.before, 'before');
    const [balance, entries] = await Promise.all([getBalance(db, req.params.code), listEntries(db, req.params.code, { limit, beforeId })]);
    const last = entries.at(-1);
    res.json({ ...balance, entries, nextCursor: entries.length && last ? last.entryId : null });
  });

  // --- Transactions ---------------------------------------------------------
  app.post('/transactions', async (req, res) => {
    const result = await postTransaction(db, { ...req.body, idempotencyKey: idempotencyKey(req) });
    res.status(result.replayed ? 200 : 201).set('Idempotent-Replayed', String(result.replayed)).json(result.transaction);
  });

  app.get('/transactions/:id', async (req, res) => {
    res.json(await loadTransaction(db, positiveInt(req.params.id, 'id')!));
  });

  app.post('/transactions/:id/reverse', async (req, res) => {
    const reason = String(req.body?.reason ?? '').trim();
    if (!reason) throw new ValidationError('reason is required');
    const result = await reverseTransaction(db, positiveInt(req.params.id, 'id')!, { idempotencyKey: idempotencyKey(req), reason });
    res.status(result.replayed ? 200 : 201).json(result.transaction);
  });

  // --- Processor webhooks ---------------------------------------------------
  // Real processors sign webhooks; verify the signature before trusting the body.
  // Idempotency comes from the flows (keyed by processor object id), so a
  // retried or duplicated delivery is acknowledged without double-posting.
  app.post('/webhooks/processor', async (req, res) => {
    const { type, data } = req.body ?? {};
    const handler = webhookHandlers[type];
    if (!handler) {
      res.status(200).json({ received: true, ignored: true }); // 2xx so the processor stops retrying
      return;
    }
    if (!data || typeof data !== 'object') throw new ValidationError('webhook data is required');
    const result = (await handler(db, data)) as { transaction: { id: number }; replayed: boolean };
    res.json({ received: true, transactionId: result.transaction.id, replayed: result.replayed });
  });

  // --- Payouts --------------------------------------------------------------
  app.post('/merchants/:id/payouts', async (req, res) => {
    const result = await flows.payOutMerchant(db, {
      merchantPayoutId: idempotencyKey(req),
      merchantId: req.params.id,
      currency: String(req.body?.currency ?? ''),
      amount: req.body?.amount,
    });
    res.status(result.replayed ? 200 : 201).json(result.transaction);
  });

  // --- Reports --------------------------------------------------------------
  app.get('/reports/trial-balance', async (_req, res) => res.json(await trialBalance(db)));
  app.get('/reports/integrity', async (_req, res) => {
    const report = await checkIntegrity(db);
    res.status(report.ok ? 200 : 500).json(report);
  });

  app.post('/reconciliations', async (req, res) => {
    const { currency, processorCsv, bankCsv, from, to } = req.body ?? {};
    if (typeof currency !== 'string' || typeof processorCsv !== 'string' || typeof bankCsv !== 'string') {
      throw new ValidationError('currency, processorCsv and bankCsv are required strings');
    }
    res.json(await reconcile(db, { currency, processorRows: parseProcessorCsv(processorCsv), bankRows: parseBankCsv(bankCsv), from, to }));
  });

  // --- Errors ---------------------------------------------------------------
  // Express 5 forwards rejected promises from async handlers here.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof LedgerError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(400).json({ error: { code: 'invalid_json', message: 'request body is not valid JSON' } });
      return;
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: 'something went wrong' } });
  });

  return app;
}
