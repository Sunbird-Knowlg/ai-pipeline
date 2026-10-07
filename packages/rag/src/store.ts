import { canonicalJson } from '@ai-pipeline/contracts/schemas';
import { PgVector } from '@mastra/pg';
import * as restate from '@restatedev/restate-sdk';
import pg from 'pg';
import { tableName } from './ids.js';
import {
  type CollectionSettings,
  dimensionProblem,
  DocumentId,
  type DocumentMetadata,
  type Format,
  readSettings,
} from './schemas.js';

/**
 * The RAG store: a collection registry and a document ledger in Postgres, and one Mastra PgVector
 * table per collection incarnation.
 *
 * Every function here is I/O meant to run inside one `ctx.run`; none of it is durable on its own.
 *
 * **The write protocol.** A document's vectors and its ledger row change in one transaction, on one
 * connection, under a per-document advisory lock — so concurrent or out-of-order runs converge on
 * the newest content (by `Order`), never interleave two versions' chunks, and never leave vectors
 * without a ledger row (or the reverse) if a process dies half-way. Mastra's `PgVector.upsert` cannot
 * join that transaction, so the rows are written with plain SQL against the table layout PgVector
 * creates (`vector_id`, `embedding`, `metadata`, `namespace`) — which `store.pg.test.ts` pins.
 * PgVector still creates and drops the tables and answers every query.
 */

/** Rows written in one INSERT statement: 4 parameters each, far below Postgres' 65535. */
const INSERT_BATCH = 500;
const NAMESPACE = 'default';

export interface RagStoreOptions {
  connectionString: string;
  /** Connections per pool (the protocol pool and PgVector's own). */
  poolMax?: number;
  /** Where vector tables live; created by provisioning. */
  schema?: string;
}

/** A collection as the units work with it. `id` is the incarnation. */
export interface CollectionRef {
  id: string;
  name: string;
  tableName: string;
  embeddingModel: string;
  dimension: number;
  settings: CollectionSettings;
}

export interface CollectionView extends CollectionRef {
  documents: number;
  chunks: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * The order of writes to one document: a producer `version` when it sends one, else the time the
 * trigger received the run, with the run id breaking ties. Newer wins; equal means "this same run".
 */
export interface Order {
  seq: number;
  runId: string;
}

export interface DocumentRecord {
  documentId: string;
  status: 'ready' | 'deleted';
  fingerprint: string | null;
  chunkCount: number;
  title: string | null;
  format: Format | null;
  metadata: DocumentMetadata;
  seq: number;
  runId: string;
  updatedAt: string;
}

export interface ChunkRecord {
  id: string;
  chunkIndex: number;
  text: string;
  metadata: Record<string, unknown>;
}

export interface WriteDocument {
  documentId: string;
  fingerprint: string;
  title?: string;
  format: Format;
  metadata: DocumentMetadata;
  chunks: { id: string; vector: number[]; metadata: Record<string, unknown> }[];
}

export interface Hit {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  vector?: number[];
}

export interface SearchOptions {
  topK: number;
  filter?: Record<string, unknown>;
  includeVector?: boolean;
  ef?: number;
  probes?: number;
}

export interface EnsureCollection {
  name: string;
  /** The settings this run wants, already resolved against defaults. */
  settings: CollectionSettings;
  /** Whether the caller asked for these settings explicitly (then they must match an existing collection). */
  explicit: boolean;
  /** A fresh uuid, recorded if this call creates the collection. Stable across retries. */
  incarnation: string;
  /** Embeds a probe and returns its dimension; called only when the collection is created. */
  probeDimension: () => Promise<number>;
}

/** `written` by this call, `unchanged` content, or `superseded` by a newer write. */
export type WriteOutcome = 'written' | 'unchanged' | 'superseded';
/** As `WriteOutcome`, or `changed`: the content differs and the caller should write it. */
export type TouchOutcome = WriteOutcome | 'changed';
export type DeleteOutcome = 'deleted' | 'absent' | 'superseded';

export interface DocumentPage {
  documents: DocumentRecord[];
  nextCursor?: string;
}

export interface RagStore {
  ensureCollection(request: EnsureCollection): Promise<CollectionRef & { created: boolean }>;
  /** The active collection of that name, or undefined. */
  getCollection(name: string): Promise<CollectionRef | undefined>;
  describeCollection(name: string): Promise<CollectionView | undefined>;
  listCollections(): Promise<CollectionView[]>;
  /** Settles a document whose content is unchanged without re-embedding it. */
  touchDocument(
    ref: CollectionRef,
    documentId: string,
    fingerprint: string,
    order: Order,
  ): Promise<TouchOutcome>;
  writeDocument(
    ref: CollectionRef,
    document: WriteDocument,
    order: Order,
    force: boolean,
  ): Promise<WriteOutcome>;
  deleteDocument(ref: CollectionRef, documentId: string, order: Order): Promise<DeleteOutcome>;
  dropCollection(name: string): Promise<'dropped' | 'absent'>;
  search(ref: CollectionRef, vector: number[], options: SearchOptions): Promise<Hit[]>;
  listDocuments(
    ref: CollectionRef,
    page: { limit: number; cursor?: string },
  ): Promise<DocumentPage>;
  getDocument(ref: CollectionRef, documentId: string): Promise<DocumentRecord | undefined>;
  documentChunks(ref: CollectionRef, documentId: string): Promise<ChunkRecord[]>;
  close(): Promise<void>;
}

const terminal = (message: string, errorCode: number) =>
  new restate.TerminalError(message, { errorCode });

/** An unpaired UTF-16 surrogate: a JavaScript string can hold one, valid UTF-8 cannot. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `value` with every string made storable. Postgres refuses a NUL character in `text` and `jsonb`,
 * and an unpaired surrogate in `jsonb` — so a document carrying either would fail its write on every
 * retry. NULs are dropped and unpaired surrogates become U+FFFD, which is also what Node's UTF-8
 * encoder does to a `text` parameter: a document id is cleaned the same way wherever it is used.
 */
export function storable<T>(value: T): T {
  if (typeof value === 'string')
    return value.replaceAll('\u0000', '').replace(LONE_SURROGATE, '\uFFFD') as T;
  if (Array.isArray(value)) return value.map(storable) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [storable(key), storable(item)]),
    ) as T;
  return value;
}

/**
 * A Postgres data exception (SQLSTATE 22) or constraint violation (23) is about the data, and the
 * same write will fail the same way on every retry: fail it for good instead of looping on it.
 * Anything else — a dropped connection, a deadlock, a restart — is left to Restate to retry.
 */
function refused(error: unknown): unknown {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return error;
  if (code.startsWith('22'))
    return terminal(`the RAG store refused the data: ${(error as Error).message}`, 400);
  if (code.startsWith('23'))
    return terminal(`the RAG store refused the write: ${(error as Error).message}`, 409);
  return error;
}

/** `a` is newer than `b`. */
export const newer = (a: Order, b: Order): boolean =>
  a.seq !== b.seq ? a.seq > b.seq : a.runId > b.runId;

const sameOrder = (a: Order, b: Order): boolean => a.seq === b.seq && a.runId === b.runId;

interface CollectionRow {
  id: string;
  name: string;
  table_name: string;
  status: 'creating' | 'active' | 'dropping';
  embedding_model: string;
  dimension: number;
  settings: unknown;
  created_at: Date;
  updated_at: Date;
  documents?: string;
  chunks?: string;
}

interface DocumentRow {
  document_id: string;
  status: 'ready' | 'deleted';
  fingerprint: string | null;
  chunk_count: number;
  title: string | null;
  format: Format | null;
  metadata: DocumentMetadata;
  seq: string;
  run_id: string;
  updated_at: Date;
}

const toRef = (row: CollectionRow): CollectionRef => ({
  id: row.id,
  name: row.name,
  tableName: row.table_name,
  embeddingModel: row.embedding_model,
  dimension: row.dimension,
  settings: readSettings(row.settings),
});

const toView = (row: CollectionRow): CollectionView => ({
  ...toRef(row),
  documents: Number(row.documents ?? 0),
  chunks: Number(row.chunks ?? 0),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});

const toDocument = (row: DocumentRow): DocumentRecord => ({
  documentId: row.document_id,
  status: row.status,
  fingerprint: row.fingerprint,
  chunkCount: row.chunk_count,
  title: row.title,
  format: row.format,
  metadata: row.metadata,
  // bigint arrives as a string; order keys are epoch milliseconds or small versions, < 2^53.
  seq: Number(row.seq),
  runId: row.run_id,
  updatedAt: row.updated_at.toISOString(),
});

const orderOf = (row: DocumentRow): Order => ({ seq: Number(row.seq), runId: row.run_id });

const COLLECTION_WITH_COUNTS = `
  SELECT c.*,
         COALESCE(d.documents, 0) AS documents,
         COALESCE(d.chunks, 0) AS chunks
  FROM rag_collections c
  LEFT JOIN (
    SELECT collection_id,
           count(*) FILTER (WHERE status = 'ready') AS documents,
           COALESCE(sum(chunk_count) FILTER (WHERE status = 'ready'), 0) AS chunks
    FROM rag_documents
    GROUP BY collection_id
  ) d ON d.collection_id = c.id`;

/** A keyset cursor: the last document id of a page, opaque to callers. */
export const encodeCursor = (documentId: string): string =>
  Buffer.from(documentId, 'utf8').toString('base64url');

/**
 * The document id a cursor stands for. A cursor this store did not hand out is the caller's
 * mistake, a 400 — not text to send Postgres, which refuses some of what base64 decodes to (NUL).
 */
export function decodeCursor(cursor: string): string {
  const documentId = Buffer.from(cursor, 'base64url').toString('utf8');
  if (encodeCursor(documentId) !== cursor || !DocumentId.safeParse(documentId).success)
    throw terminal('invalid cursor: pass back a nextCursor exactly as it was returned', 400);
  return documentId;
}

/** How long one statement through PgVector (a search, an index built or dropped) may run. */
export const SEARCH_TIMEOUT_MS = 25_000;

export function createRagStore({
  connectionString,
  poolMax = 10,
  schema = 'vectors',
}: RagStoreOptions): RagStore {
  const pool = new pg.Pool({
    connectionString,
    max: poolMax,
    // Writers queue for a connection under load rather than failing fast: a write holds exactly
    // one, so waiting always ends.
    connectionTimeoutMillis: 30_000,
    statement_timeout: 120_000,
  });
  // Without a listener, an idle client dropped by Postgres (restart, failover) crashes the process.
  pool.on('error', () => undefined);
  const vectors = new PgVector({
    id: 'rag',
    connectionString,
    schemaName: schema,
    // A filtered search scans every matching chunk exactly (the vector index serves unfiltered
    // queries only), so it is bounded here: a query that cannot finish fails instead of holding a
    // connection, and a caller, for as long as it runs.
    pgPoolOptions: {
      max: poolMax,
      connectionTimeoutMillis: 30_000,
      statement_timeout: SEARCH_TIMEOUT_MS,
    },
  });
  const qualified = (table: string) => `"${schema}"."${table}"`;

  async function inTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw refused(error);
    } finally {
      client.release();
    }
  }

  /**
   * Holds the collection row (`FOR SHARE`, so a drop waits for this write to finish) and the
   * document's advisory lock for the rest of the transaction, then reads the ledger row.
   */
  async function lockDocument(
    client: pg.PoolClient,
    ref: CollectionRef,
    documentId: string,
  ): Promise<DocumentRow | undefined> {
    const { rows } = await client.query<Pick<CollectionRow, 'status'>>(
      'SELECT status FROM rag_collections WHERE id = $1 FOR SHARE',
      [ref.id],
    );
    if (rows[0]?.status !== 'active')
      throw terminal(
        `collection ${ref.name} was dropped (or re-created) while this run was writing to it`,
        409,
      );
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
      `rag:${ref.id}/${documentId}`,
    ]);
    const ledger = await client.query<DocumentRow>(
      'SELECT * FROM rag_documents WHERE collection_id = $1 AND document_id = $2',
      [ref.id, documentId],
    );
    return ledger.rows[0];
  }

  async function createIndex(row: CollectionRow, settings: CollectionSettings): Promise<void> {
    await vectors.createIndex({
      indexName: row.table_name,
      dimension: row.dimension,
      metric: settings.index.metric,
      indexConfig:
        settings.index.type === 'hnsw'
          ? { type: 'hnsw', hnsw: settings.index.hnsw }
          : { type: 'flat' },
      buildIndex: true,
      vectorType: settings.index.vectorType,
      metadataIndexes: ['documentId', ...settings.index.metadataIndexes],
    });
    const activated = await pool.query(
      "UPDATE rag_collections SET status = 'active', updated_at = now() WHERE id = $1 AND status = 'creating'",
      [row.id],
    );
    if (activated.rowCount === 0) {
      // A drop took the row while the table was being made: take the table with it, or it is left
      // behind with nothing pointing at it.
      await vectors.deleteIndex({ indexName: row.table_name });
      throw terminal(`collection ${row.name} was dropped while it was being created`, 409);
    }
  }

  /** `ensureCollection`, once its request is storable; its errors are mapped by the caller. */
  async function ensure({
    name,
    settings,
    explicit,
    incarnation,
    probeDimension,
  }: EnsureCollection): Promise<CollectionRef & { created: boolean }> {
    for (;;) {
      const existing = await pool.query<CollectionRow>(
        'SELECT * FROM rag_collections WHERE name = $1',
        [name],
      );
      const row = existing.rows[0];
      if (row) {
        if (row.status === 'creating' && row.id === incarnation) {
          // This run created the row and died before the table was ready: finish the job.
          await createIndex(row, settings);
          return { ...toRef({ ...row, status: 'active' }), created: true };
        }
        // Another run is creating or dropping it: retryable, so this run waits its turn.
        if (row.status !== 'active')
          throw new Error(
            `collection ${name} is being ${row.status === 'creating' ? 'created' : 'dropped'} by another run`,
          );
        const ref = toRef(row);
        // jsonb does not keep key order, so compare canonically.
        if (explicit && canonicalJson(ref.settings) !== canonicalJson(settings))
          throw terminal(
            `collection ${name} exists with different settings (${JSON.stringify(ref.settings)}); ` +
              'a collection keeps its settings for life — drop it, or use another name',
            409,
          );
        return { ...ref, created: false };
      }

      const dimension = await probeDimension();
      const problem = dimensionProblem(settings, dimension);
      if (problem) throw terminal(problem, 400);
      const inserted = await pool.query<CollectionRow>(
        `INSERT INTO rag_collections (id, name, table_name, status, embedding_model, dimension, settings)
         VALUES ($1, $2, $3, 'creating', $4, $5, $6)
         ON CONFLICT (name) DO NOTHING
         RETURNING *`,
        [
          incarnation,
          name,
          tableName(incarnation),
          settings.embedding.model,
          dimension,
          JSON.stringify(settings),
        ],
      );
      // Lost a race with another run creating the same collection: read theirs.
      if (!inserted.rows[0]) continue;
      await createIndex(inserted.rows[0], settings);
      return { ...toRef({ ...inserted.rows[0], status: 'active' }), created: true };
    }
  }

  return {
    async ensureCollection(request) {
      try {
        return await ensure({ ...request, settings: storable(request.settings) });
      } catch (error) {
        throw refused(error);
      }
    },

    async getCollection(name) {
      const { rows } = await pool.query<CollectionRow>(
        "SELECT * FROM rag_collections WHERE name = $1 AND status = 'active'",
        [name],
      );
      return rows[0] && toRef(rows[0]);
    },

    async describeCollection(name) {
      const { rows } = await pool.query<CollectionRow>(
        `${COLLECTION_WITH_COUNTS} WHERE c.name = $1 AND c.status = 'active'`,
        [name],
      );
      return rows[0] && toView(rows[0]);
    },

    async listCollections() {
      const { rows } = await pool.query<CollectionRow>(
        `${COLLECTION_WITH_COUNTS} WHERE c.status = 'active' ORDER BY c.name`,
      );
      return rows.map(toView);
    },

    async touchDocument(ref, rawId, fingerprint, order) {
      const documentId = storable(rawId);
      return inTransaction(async (client) => {
        const row = await lockDocument(client, ref, documentId);
        if (!row) return 'changed';
        const current = orderOf(row);
        if (newer(current, order)) return 'superseded';
        if (row.status !== 'ready' || row.fingerprint !== fingerprint) return 'changed';
        // The same content: this run wrote it already (a retry after the commit), or it is settled
        // without re-embedding — but its order moves forward, so an older write arriving later loses.
        if (sameOrder(current, order)) return 'written';
        await client.query(
          `UPDATE rag_documents SET seq = $3, run_id = $4, updated_at = now()
           WHERE collection_id = $1 AND document_id = $2`,
          [ref.id, documentId, order.seq, order.runId],
        );
        return 'unchanged';
      });
    },

    async writeDocument(ref, raw, order, force) {
      const document = storable(raw);
      return inTransaction(async (client) => {
        const row = await lockDocument(client, ref, document.documentId);
        if (row) {
          const current = orderOf(row);
          if (newer(current, order)) return 'superseded';
          const same = row.status === 'ready' && row.fingerprint === document.fingerprint;
          if (same && sameOrder(current, order)) return 'written';
          if (same && !force) {
            await client.query(
              `UPDATE rag_documents SET seq = $3, run_id = $4, updated_at = now()
               WHERE collection_id = $1 AND document_id = $2`,
              [ref.id, document.documentId, order.seq, order.runId],
            );
            return 'unchanged';
          }
        }

        const table = qualified(ref.tableName);
        await client.query(
          `DELETE FROM ${table} WHERE namespace = $1 AND metadata->>'documentId' = $2`,
          [NAMESPACE, document.documentId],
        );
        const cast = ref.settings.index.vectorType;
        for (let start = 0; start < document.chunks.length; start += INSERT_BATCH) {
          const batch = document.chunks.slice(start, start + INSERT_BATCH);
          const params: unknown[] = [];
          const values = batch.map((chunk, i) => {
            params.push(chunk.id, `[${chunk.vector.join(',')}]`, JSON.stringify(chunk.metadata));
            const p = i * 3;
            return `($${p + 1}, $${p + 2}::${cast}, $${p + 3}::jsonb, '${NAMESPACE}')`;
          });
          await client.query(
            `INSERT INTO ${table} (vector_id, embedding, metadata, namespace) VALUES ${values.join(', ')}`,
            params,
          );
        }
        await client.query(
          `INSERT INTO rag_documents
             (collection_id, document_id, status, fingerprint, chunk_count, title, format, metadata, seq, run_id)
           VALUES ($1, $2, 'ready', $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (collection_id, document_id) DO UPDATE SET
             status = 'ready', fingerprint = EXCLUDED.fingerprint, chunk_count = EXCLUDED.chunk_count,
             title = EXCLUDED.title, format = EXCLUDED.format, metadata = EXCLUDED.metadata,
             seq = EXCLUDED.seq, run_id = EXCLUDED.run_id, updated_at = now()`,
          [
            ref.id,
            document.documentId,
            document.fingerprint,
            document.chunks.length,
            document.title ?? null,
            document.format,
            JSON.stringify(document.metadata),
            order.seq,
            order.runId,
          ],
        );
        return 'written';
      });
    },

    async deleteDocument(ref, rawId, order) {
      const documentId = storable(rawId);
      return inTransaction(async (client) => {
        const row = await lockDocument(client, ref, documentId);
        if (row && newer(orderOf(row), order)) return 'superseded';
        const had = row?.status === 'ready';
        if (had)
          await client.query(
            `DELETE FROM ${qualified(ref.tableName)} WHERE namespace = $1 AND metadata->>'documentId' = $2`,
            [NAMESPACE, documentId],
          );
        // A tombstone even for a document never seen: its write may still be on the way, older.
        await client.query(
          `INSERT INTO rag_documents (collection_id, document_id, status, chunk_count, seq, run_id)
           VALUES ($1, $2, 'deleted', 0, $3, $4)
           ON CONFLICT (collection_id, document_id) DO UPDATE SET
             status = 'deleted', fingerprint = NULL, chunk_count = 0,
             seq = EXCLUDED.seq, run_id = EXCLUDED.run_id, updated_at = now()`,
          [ref.id, documentId, order.seq, order.runId],
        );
        return had ? 'deleted' : 'absent';
      });
    },

    async dropCollection(name) {
      const row = await inTransaction(async (client) => {
        // FOR UPDATE waits for every in-flight write (they hold FOR SHARE); once `dropping` is
        // committed, no new write starts.
        const { rows } = await client.query<CollectionRow>(
          'SELECT * FROM rag_collections WHERE name = $1 FOR UPDATE',
          [name],
        );
        if (!rows[0]) return undefined;
        await client.query(
          "UPDATE rag_collections SET status = 'dropping', updated_at = now() WHERE id = $1",
          [rows[0].id],
        );
        return rows[0];
      });
      if (!row) return 'absent';
      await vectors.deleteIndex({ indexName: row.table_name });
      // The ledger goes with it (ON DELETE CASCADE).
      await pool.query('DELETE FROM rag_collections WHERE id = $1', [row.id]);
      return 'dropped';
    },

    async search(ref, vector, { topK, filter, includeVector, ef, probes }) {
      const results = await vectors.query({
        indexName: ref.tableName,
        queryVector: vector,
        topK,
        ...(filter && Object.keys(filter).length > 0 ? { filter: filter as never } : {}),
        includeVector: includeVector ?? false,
        ...(ef ? { ef } : {}),
        ...(probes ? { probes } : {}),
      });
      return results.map((result) => ({
        id: result.id,
        score: result.score,
        metadata: result.metadata ?? {},
        ...(result.vector ? { vector: result.vector } : {}),
      }));
    },

    async listDocuments(ref, { limit, cursor }) {
      const after = cursor === undefined ? null : decodeCursor(cursor);
      const { rows } = await pool.query<DocumentRow>(
        `SELECT * FROM rag_documents
         WHERE collection_id = $1 AND status = 'ready' AND ($2::text IS NULL OR document_id > $2)
         ORDER BY document_id
         LIMIT $3`,
        [ref.id, after, limit + 1],
      );
      const page = rows.slice(0, limit).map(toDocument);
      return {
        documents: page,
        ...(rows.length > limit
          ? { nextCursor: encodeCursor(page[page.length - 1]!.documentId) }
          : {}),
      };
    },

    async getDocument(ref, documentId) {
      const { rows } = await pool.query<DocumentRow>(
        "SELECT * FROM rag_documents WHERE collection_id = $1 AND document_id = $2 AND status = 'ready'",
        [ref.id, documentId],
      );
      return rows[0] && toDocument(rows[0]);
    },

    async documentChunks(ref, documentId) {
      const { rows } = await pool.query<{ vector_id: string; metadata: Record<string, unknown> }>(
        `SELECT vector_id, metadata FROM ${qualified(ref.tableName)}
         WHERE namespace = $1 AND metadata->>'documentId' = $2
         ORDER BY (metadata->>'chunkIndex')::int`,
        [NAMESPACE, documentId],
      );
      return rows.map(({ vector_id, metadata }) => ({
        id: vector_id,
        chunkIndex: Number(metadata.chunkIndex),
        text: typeof metadata.text === 'string' ? metadata.text : '',
        metadata,
      }));
    },

    async close() {
      await Promise.all([pool.end(), vectors.disconnect()]);
    },
  };
}

export function ragStoreFromEnv(env: NodeJS.ProcessEnv = process.env): RagStore {
  const connectionString = env.RAG_DATABASE_URL;
  if (!connectionString) throw new Error('RAG_DATABASE_URL is required');
  return createRagStore({ connectionString });
}
