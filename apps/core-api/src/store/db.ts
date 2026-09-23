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

export async function transaction<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const tx = await db.connect();
  try {
    return await transactionOn(tx, () => fn(tx));
  } finally {
    tx.release();
  }
}

/** BEGIN/COMMIT on a client the caller already holds — e.g. the one holding an advisory lock. */
export async function transactionOn<T>(client: Tx, fn: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await fn();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

/**
 * Serialises control-plane work across requests, on session-level advisory locks.
 *
 * The locked client is handed to `fn` and the section must do its work **on that client**. Holding
 * a pooled connection while the body asks the same pool for another one is a self-deadlock, not
 * contention: with `max: 8`, eight concurrent lock holders leave nothing for any of them to work
 * with, and every one fails after `connectionTimeoutMillis` — with entirely distinct keys.
 *
 * All the keys a section needs are taken here, in order, on the one session. That is why this takes
 * a list: advisory locks are per session, so a nested `withLock` would need a second connection and
 * reintroduce exactly the problem.
 */
export async function withLock<T>(
  db: Db,
  keys: readonly string[],
  fn: (client: Tx) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  const taken: string[] = [];
  try {
    for (const key of keys) {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [key]);
      taken.push(key);
    }
    return await fn(client);
  } finally {
    for (const key of taken.reverse())
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [key]).catch(() => undefined);
    client.release();
  }
}
