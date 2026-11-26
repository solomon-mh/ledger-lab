# ledger-lab

A production-style **double-entry payment ledger** for a marketplace, with
**idempotent webhooks**, **overdraft protection under concurrency**, and
**three-way reconciliation** (ledger ↔ processor report ↔ bank statement).

Built with TypeScript, Node.js, Express 5, PostgreSQL 16 and Vitest.

```
npm run demo
```

```
== 2. Reconcile: ledger vs processor report vs bank statement ==
  checked 7 references: 5 matched, 3 break(s)
  ✗ amount_mismatch            ch_2: processor net 24245, ledger net 24250
  ✗ missing_in_ledger          processor reports ch_4 (net 7738) but the ledger has no entry for it
  ✗ unexpected_bank_deposit    bank line "INTEREST CREDIT, NOV" (12) on 2026-11-21 matches no payout or ledger entry

== 3. Resolve each break with an append-only correction ==
  checked 7 references: 8 matched, 0 break(s)
  ✓ ledger, processor and bank all agree

== 4. Pay the merchant ==
  ✗ insufficient_funds account liabilities:merchant:m_42:usd has 36100 available but 50000 was requested
  ✓ paid 361.00 USD, exactly what we owed
```

## What it guarantees

| Guarantee | Enforced by |
|---|---|
| Every transaction balances (debits = credits, per currency) | App validation **and** a deferred Postgres constraint trigger checked at `COMMIT` |
| History can't be edited or deleted | `BEFORE UPDATE/DELETE/TRUNCATE` triggers; corrections are reversals or adjustments |
| Money is exact | Integer minor units (`bigint` cents), never floats |
| A retried request never posts twice | Unique idempotency key + request hash (same key + different body → `409`) |
| No overdraft, even with 20 simultaneous withdrawals | `SELECT … FOR UPDATE` on balance rows, always locked in id order (no deadlocks) |
| Entries can't use the wrong currency | Composite foreign key `(account_id, currency)` |
| Cached balances are trustworthy | `checkIntegrity()` recomputes from raw entries and reports drift |
| The books match the outside world | Three-way reconciliation producing typed "breaks" |

## Quick start

You need Node 20+ and PostgreSQL 14+.

```bash
# Postgres via Docker or Podman (or use a local install)
docker compose up -d

npm install
cp .env.example .env            # adjust if your DB URL differs
export $(cat .env | xargs)

npm test                         # 52 tests, runs against ledger_test
npm run demo                     # the end-to-end story above
npm run db:reset && npm run dev  # API on http://localhost:3000
```

## How money flows (chart of accounts)

```
customer pays 100.00
      │
      ▼
assets:processor_receivable   ← processor owes us (net of its fee)
expenses:processor_fees       ← what the processor kept
liabilities:merchant:{id}     ← what we owe the merchant
revenue:platform_fees         ← what we keep

processor payout  → assets:payouts_in_transit → assets:bank
merchant payout   → liabilities:merchant      → assets:bank (guarded)
chargeback        → claws back from merchant, dispute fee to expenses:dispute_fees
```

A charge of 100.00 with a 3.20 processor fee and a 5.00 platform fee posts:

| Account | Debit | Credit |
|---|---:|---:|
| assets:processor_receivable:usd | 96.80 | |
| expenses:processor_fees:usd | 3.20 | |
| liabilities:merchant:m_42:usd | | 95.00 |
| revenue:platform_fees:usd | | 5.00 |
| **Total** | **100.00** | **100.00** |

## API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/accounts` | idempotent by `code` |
| `GET` | `/accounts/:code?limit=&before=` | balance + cursor-paginated entries |
| `POST` | `/transactions` | header `Idempotency-Key` required; `201` new, `200` replay, `409` key reuse, `422` insufficient funds |
| `GET` | `/transactions/:id` | |
| `POST` | `/transactions/:id/reverse` | header `Idempotency-Key`; body `{ reason }`; `409` if already reversed |
| `POST` | `/webhooks/processor` | `charge.succeeded`, `charge.refunded`, `dispute.created`, `dispute.won`, `payout.sent`, `payout.arrived` |
| `POST` | `/merchants/:id/payouts` | header `Idempotency-Key`; body `{ currency, amount }` |
| `GET` | `/reports/trial-balance` | |
| `GET` | `/reports/integrity` | `500` if any invariant is broken (for alerting) |
| `POST` | `/reconciliations` | body `{ currency, processorCsv, bankCsv, from?, to? }` |

```bash
curl -X POST localhost:3000/webhooks/processor -H 'content-type: application/json' -d '{
  "type": "charge.succeeded",
  "data": { "chargeId": "ch_1", "merchantId": "m_42", "currency": "USD",
            "amount": 10000, "processorFee": 320, "platformFee": 500 } }'
```

(Create the merchant account first: `POST /accounts` with `code: "liabilities:merchant:m_42:usd"`, `type: "liability"`.)

## Project layout

```
db/schema.sql          tables, append-only triggers, zero-sum constraint trigger
src/ledger.ts          posting, idempotency, locking, reversals, reports, integrity
src/flows.ts           business events → entries (charge, refund, dispute, payouts, wallets)
src/reconcile.ts       CSV parsing + three-way matching
src/app.ts             Express API
src/money.ts           minor-unit parsing/formatting without floats
scripts/demo.ts        end-to-end story
test/                  ledger, concurrency (incl. a naive version that overdraws), flows, reconciliation, API
fixtures/              a processor payout report and a bank statement
docs/INTERVIEW.md      design decisions, question bank, whiteboard drills
```

## Deliberately out of scope

Authentication, webhook signature verification, authorization holds (pending
vs. available balances), FX conversion, and partitioning for very large
volumes.
# ledger-lab
