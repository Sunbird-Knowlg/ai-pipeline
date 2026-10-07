import { z } from 'zod';

/**
 * The shapes both RAG units share: names, collection settings and document metadata. zod only —
 * a unit's contract imports these, so this module must not pull in Mastra or Postgres.
 */

/** A collection's name. It is never a SQL identifier (tables are named by incarnation), only a key. */
export const CollectionName = z
  .string()
  .regex(
    /^[a-z][a-z0-9_-]{0,62}$/,
    'lower-case letters, digits, "_" and "-", starting with a letter',
  );
export type CollectionName = z.infer<typeof CollectionName>;

/** A document's identifier within its collection: the producer's own id, kept opaque. */
export const DocumentId = z
  .string()
  .min(1)
  .max(512)
  // `\x` escapes, not `\u`: core-api compiles catalogued patterns with RE2, which has no `\u`.
  // eslint-disable-next-line no-control-regex -- the point is to refuse control characters
  .regex(/^[^\x00-\x1f\x7f]+$/, 'no control characters');
export type DocumentId = z.infer<typeof DocumentId>;

/** At most 63 characters: Mastra refuses a longer field key in a filter, so it could never match. */
export const MetadataKey = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'an identifier');

/**
 * Chunk metadata keys the pipeline writes itself. A document's own metadata may not use them —
 * checked in the handler, because a catalogued contract cannot carry a `.refine()`.
 */
export const RESERVED_METADATA = [
  'documentId',
  'chunkIndex',
  'chunkCount',
  'text',
  'title',
  'format',
  'fingerprint',
  'seq',
] as const;

/** Flat, filterable metadata: scalars, or short arrays of them (matched by `$in`/`$all`). */
const Scalar = z.union([z.string().max(4096), z.number(), z.boolean()]);
export const MetadataValue = z.union([
  Scalar,
  z.array(z.union([z.string().max(1024), z.number(), z.boolean()])).max(64),
]);
export const DocumentMetadata = z.record(MetadataKey, MetadataValue);
export type DocumentMetadata = z.infer<typeof DocumentMetadata>;

/** How a document's text is read: it decides Mastra's `MDocument` factory and default chunker. */
export const Format = z.enum(['text', 'markdown', 'html', 'json', 'latex']);
export type Format = z.infer<typeof Format>;

export const EmbeddingSettings = z.strictObject({
  /**
   * LiteLLM `model_name` of the embedding model. A collection is bound to it for life: vectors from
   * two models are not comparable. Name an immutable alias (`embed-qwen3-0p6b`), never a "default".
   */
  model: z.string().min(1).max(200),
  /** Requested output dimensions, for models that can truncate (Matryoshka). Else probed. */
  dimensions: z.number().int().min(1).max(4000).optional(),
  /**
   * What is embedded for a query; must contain `{query}`. Instruction-tuned embedders want a task
   * prefix here (qwen3-embedding: `Instruct: …\nQuery: {query}`).
   */
  queryTemplate: z.string().min(7).max(2000),
  /**
   * What is embedded for a chunk; must contain `{text}`. Also offers `{title}` and any chunk metadata
   * key, e.g. an extracted `{documentTitle}` or `{excerptKeywords}`.
   */
  documentTemplate: z.string().min(6).max(2000),
});
export type EmbeddingSettings = z.infer<typeof EmbeddingSettings>;

export const IndexSettings = z.strictObject({
  metric: z.enum(['cosine', 'euclidean', 'dotproduct']),
  /**
   * `hnsw` is the approximate index; `flat` builds none (every query is an exact scan — fine for a
   * small collection). IVFFlat is deliberately absent: built on an empty table it is untrained.
   */
  type: z.enum(['hnsw', 'flat']),
  hnsw: z.strictObject({
    m: z.number().int().min(2).max(100),
    efConstruction: z.number().int().min(4).max(1000),
  }),
  /** `halfvec` halves storage and allows indexes up to 4000 dimensions (`vector`: 2000). */
  vectorType: z.enum(['vector', 'halfvec']),
  /** Chunk metadata keys to give a b-tree index, which speeds up equality filters on them. */
  metadataIndexes: z.array(MetadataKey).max(16),
});
export type IndexSettings = z.infer<typeof IndexSettings>;

/** Everything fixed when a collection is created. Changing any of it means a new collection. */
export const CollectionSettings = z.strictObject({
  description: z.string().max(2000),
  embedding: EmbeddingSettings,
  index: IndexSettings,
});
export type CollectionSettings = z.infer<typeof CollectionSettings>;

/** The caller's say over a new collection's settings; whatever is left out comes from defaults. */
export const CollectionSettingsInput = z.strictObject({
  description: z.string().max(2000).optional(),
  embedding: EmbeddingSettings.partial().optional(),
  index: IndexSettings.extend({ hnsw: IndexSettings.shape.hnsw.partial() }).partial().optional(),
});
export type CollectionSettingsInput = z.infer<typeof CollectionSettingsInput>;

/** The defaults filled in by `input`, without validating the cross-field rules (`settingsProblems`). */
export function resolveSettings(
  defaults: CollectionSettings,
  input: CollectionSettingsInput = {},
): CollectionSettings {
  return {
    description: input.description ?? defaults.description,
    embedding: { ...defaults.embedding, ...input.embedding },
    index: {
      ...defaults.index,
      ...input.index,
      hnsw: { ...defaults.index.hnsw, ...input.index?.hnsw },
    },
  };
}

/** The rules a JSON Schema cannot state. Empty when the settings are usable. */
export function settingsProblems(settings: CollectionSettings): string[] {
  const problems: string[] = [];
  if (!settings.embedding.queryTemplate.includes('{query}'))
    problems.push('embedding.queryTemplate must contain {query}');
  if (!settings.embedding.documentTemplate.includes('{text}'))
    problems.push('embedding.documentTemplate must contain {text}');
  const reserved = new Set<string>(['documentId']);
  for (const key of settings.index.metadataIndexes)
    if (reserved.has(key)) problems.push(`index.metadataIndexes: ${key} is always indexed`);
  // PgVector reads a collection's metric back from its vector index, and `flat` builds none: it
  // would rank and score by cosine whatever the settings said.
  if (settings.index.type === 'flat' && settings.index.metric !== 'cosine')
    problems.push(
      `index.metric: a flat collection is searched by cosine; use hnsw for ${settings.index.metric}`,
    );
  return problems;
}

/**
 * Settings as stored, read by a unit that may be older than the one that wrote them. Keys this
 * version does not know are dropped rather than refused, so upgrading one RAG unit does not break
 * the other's reads of every collection. Anything else that does not parse still throws.
 */
export function readSettings(stored: unknown): CollectionSettings {
  const value: unknown = structuredClone(stored);
  // One pass reports every unknown key at every depth; the loop only guards against surprises.
  for (let pass = 0; pass < 4; pass++) {
    const result = CollectionSettings.safeParse(value);
    if (result.success) return result.data;
    const unknown = result.error.issues.filter((issue) => issue.code === 'unrecognized_keys');
    if (unknown.length < result.error.issues.length) throw result.error;
    for (const issue of unknown) {
      const holder = issue.path.reduce<unknown>(
        (node, key) => (node as Record<PropertyKey, unknown>)[key],
        value,
      ) as Record<string, unknown>;
      for (const key of issue.keys) delete holder[key];
    }
  }
  return CollectionSettings.parse(value);
}

/** Index size limits of pgvector, by storage type, when an approximate index is built. */
export const MAX_INDEXED_DIMENSIONS = { vector: 2000, halfvec: 4000 } as const;

/**
 * Why a collection cannot be built for the dimension its model was probed at, if it cannot: a
 * model that answers with empty vectors, one that ignores the dimensions asked for, or one too wide
 * for the index.
 */
export function dimensionProblem(
  settings: CollectionSettings,
  dimension: number,
): string | undefined {
  const model = settings.embedding.model;
  if (!Number.isInteger(dimension) || dimension < 1)
    return `${model} returned vectors of ${dimension} dimensions; is it an embedding model?`;
  if (settings.embedding.dimensions && dimension !== settings.embedding.dimensions)
    return `${model} returned ${dimension} dimensions, not the ${settings.embedding.dimensions} asked for`;
  const limit = MAX_INDEXED_DIMENSIONS[settings.index.vectorType];
  if (settings.index.type === 'hnsw' && dimension > limit)
    return `${model} has ${dimension} dimensions; an HNSW index on ${settings.index.vectorType} supports ${limit}`;
  return undefined;
}
