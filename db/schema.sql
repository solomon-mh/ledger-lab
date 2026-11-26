-- ledger-lab schema: an append-only, double-entry ledger.
--
-- Rules enforced by the DATABASE (not just the app), so a buggy script,
-- a bad migration or a future teammate cannot break them:
--   1. Every ledger transaction balances to zero per currency.
--   2. Entries and transactions are append-only (no UPDATE / DELETE / TRUNCATE).
--   3. An entry's currency must match its account's currency.
--   4. Amounts are integers in minor units (cents) and never zero.
--   5. A transaction can be reversed at most once.

CREATE TYPE account_type AS ENUM ('asset', 'liability', 'equity', 'revenue', 'expense');

CREATE TABLE accounts (
  id              bigserial    PRIMARY KEY,
  code            text         NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_.:-]+$'),
  name            text         NOT NULL,
  type            account_type NOT NULL,
  currency        char(3)      NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- false = the account's normal balance may never go below zero
  -- (e.g. a customer wallet, or our real bank account).
  allow_negative  boolean      NOT NULL DEFAULT true,
  created_at      timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (id, currency)        -- target for the composite FK on entries
);

CREATE TABLE ledger_transactions (
  id               bigserial   PRIMARY KEY,
  idempotency_key  text        NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  request_hash     text        NOT NULL,       -- detects the same key reused with a different body
  description      text        NOT NULL,
  external_ref     text,                       -- id at the processor / bank (ch_..., re_..., po_...)
  reverses_id      bigint      UNIQUE REFERENCES ledger_transactions (id),
  metadata         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  effective_at     timestamptz NOT NULL DEFAULT now(),  -- when it happened in the real world
  created_at       timestamptz NOT NULL DEFAULT now()   -- when we recorded it
);
CREATE INDEX ledger_transactions_external_ref_idx ON ledger_transactions (external_ref);
CREATE INDEX ledger_transactions_effective_at_idx ON ledger_transactions (effective_at);

-- Signed amounts: positive = debit, negative = credit.
-- With this convention "debits = credits" becomes simply "SUM(amount) = 0".
CREATE TABLE entries (
  id              bigserial   PRIMARY KEY,
  transaction_id  bigint      NOT NULL REFERENCES ledger_transactions (id),
  account_id      bigint      NOT NULL,
  amount          bigint      NOT NULL CHECK (amount <> 0),
  currency        char(3)     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, currency) REFERENCES accounts (id, currency)
);
CREATE INDEX entries_account_id_idx ON entries (account_id, id);
CREATE INDEX entries_transaction_id_idx ON entries (transaction_id);

-- Cached balance per account. It is DERIVED data: the entries are the
-- truth, and check_integrity() proves the cache still equals SUM(entries).
-- The row is also the lock we take before checking for overdrafts.
CREATE TABLE account_balances (
  account_id  bigint      PRIMARY KEY REFERENCES accounts (id),
  balance     bigint      NOT NULL DEFAULT 0,   -- signed: debits minus credits
  version     bigint      NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Rule 2: append-only ---------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER entries_no_update_delete BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER entries_no_truncate BEFORE TRUNCATE ON entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transactions_no_update_delete BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transactions_no_truncate BEFORE TRUNCATE ON ledger_transactions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Rule 1: every transaction balances ------------------------------------------
-- DEFERRABLE INITIALLY DEFERRED = checked at COMMIT, after all entries of the
-- transaction are inserted (checking after each row would always fail).
CREATE FUNCTION check_transaction_balanced() RETURNS trigger AS $$
DECLARE
  -- TG_ARGV[0] names the column holding the transaction id ('transaction_id' on entries, 'id' on ledger_transactions)
  tx_id     bigint := (to_jsonb(NEW) ->> TG_ARGV[0])::bigint;
  n_entries int;
  bad       record;
BEGIN
  SELECT count(*) INTO n_entries FROM entries WHERE transaction_id = tx_id;
  IF n_entries < 2 THEN
    RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 are required', tx_id, n_entries
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT currency, sum(amount) AS total INTO bad
  FROM entries WHERE transaction_id = tx_id
  GROUP BY currency HAVING sum(amount) <> 0
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'ledger transaction % is unbalanced: % off by %', tx_id, bad.currency, bad.total
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER entries_must_balance
  AFTER INSERT ON entries DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_balanced('transaction_id');

CREATE CONSTRAINT TRIGGER transactions_must_have_entries
  AFTER INSERT ON ledger_transactions DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_transaction_balanced('id');
