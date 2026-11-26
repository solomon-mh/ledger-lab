import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * Postgres returns BIGINT (type 20) as a string, because JS numbers lose
 * precision above 2^53. We parse it into a number but refuse anything that
 * is not exactly representable. 2^53 cents is about 90 trillion dollars,
 * so this is a safe trade-off for this project. A system holding larger
 * amounts would switch to BigInt end to end.
 */
pg.types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`bigint ${value} is outside the JS safe integer range`);
  return n;
});

export type Db = pg.Pool;
export type Tx = pg.PoolClient;

export function createPool(connectionString = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5432/ledger'): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

// 40001 = serialization_failure, 40P01 = deadlock_detected.
// Both mean "nothing was written, try the whole transaction again".
const RETRYABLE = new Set(['40001', '40P01']);

/**
 * Run fn inside BEGIN/COMMIT. Any thrown error rolls back everything,
 * which is what makes a multi-entry posting all-or-nothing.
 */
export async function withTransaction<T>(db: Db, fn: (tx: Tx) => Promise<T>, maxRetries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE.has(code) && attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.random() * 10)); // backoff + jitter
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}

const SCHEMA_URL = new URL('../db/schema.sql', import.meta.url);

/** Drops everything and recreates the schema. For tests and the demo only. */
export async function resetDatabase(db: Db): Promise<void> {
  const schema = await readFile(SCHEMA_URL, 'utf8');
  await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await db.query(schema);
}
