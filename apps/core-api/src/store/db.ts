import { readFile } from 'node:fs/promises';
import pg from 'pg';

/**
 * The Postgres connection and the two primitives the control plane needs on top of it. Nothing
 * above `store/` imports `pg`: repositories take a `Queryable`, and the domain takes a `Store`.
 */
export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = Db | Tx;

export function createDb(
  connectionString: string,
  onIdleError: (error: Error) => void = () => undefined,
): Db {
  const pool = new pg.Pool({
    connectionString,
    max: 8,
    statement_timeout: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // Without a listener, an idle client dropped by Postgres (restart, failover) crashes the process.
  pool.on('error', onIdleError);
  return pool;
}

/** The schema file is idempotent (`IF NOT EXISTS`); core-api is its only writer. */
export async function applySchema(db: Db): Promise<void> {
  await db.query(await readFile(new URL('../../schema.sql', import.meta.url), 'utf8'));
}

export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    const result = await fn(tx);
    await tx.query('COMMIT');
    return result;
  } catch (error) {
    await tx.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}

/**
 * Serialises control-plane work on one key across requests (session-level advisory lock on a
 * dedicated connection). Use distinct keys for nested sections — the lock is per session.
 */
export async function withLock<T>(db: Db, key: string, fn: () => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
    return await fn();
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
    client.release();
  }
}
