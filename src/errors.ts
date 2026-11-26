/** Every error the ledger throws on purpose. The API maps `status` to HTTP. */
export class LedgerError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends LedgerError {
  constructor(message: string, details?: unknown) {
    super('validation_error', message, 400, details);
  }
}

export class AccountNotFoundError extends LedgerError {
  constructor(codes: string[]) {
    super('account_not_found', `unknown account(s): ${codes.join(', ')}`, 404, { codes });
  }
}

export class TransactionNotFoundError extends LedgerError {
  constructor(id: number) {
    super('transaction_not_found', `ledger transaction ${id} does not exist`, 404, { id });
  }
}

export class IdempotencyConflictError extends LedgerError {
  constructor(key: string) {
    super('idempotency_conflict', `idempotency key "${key}" was already used with a different request`, 409, { key });
  }
}

export class InsufficientFundsError extends LedgerError {
  constructor(account: string, available: number, requested: number) {
    super('insufficient_funds', `account ${account} has ${available} available but ${requested} was requested`, 422, {
      account,
      available,
      requested,
    });
  }
}

export class AlreadyReversedError extends LedgerError {
  constructor(id: number) {
    super('already_reversed', `ledger transaction ${id} has already been reversed`, 409, { id });
  }
}
