import { runRequest } from '@ai-pipeline/contracts/trigger';
import {
  CollectionName,
  CollectionSettings,
  CollectionSettingsInput,
  DocumentId,
  DocumentMetadata,
  Format,
  MetadataKey,
} from '@ai-pipeline/rag/schemas';
import { z } from 'zod';

/**
 * This workflow's data shapes. Kept apart from `./api.ts` so the catalogue side needs no SDK.
 *
 * Nothing here uses `.refine()`: a catalogued contract must convert to JSON Schema without losing a
 * rule. The rules JSON Schema cannot state (overlap below maxSize, no reserved metadata keys, …) are
 * checked by `planIngest`, which fails the run with a 400.
 */

export const MAX_DOCUMENTS = 100;
export const MAX_TEXT = 1_000_000;
/**
 * A run's total text. The whole input is journaled as the invocation's input, so it is bounded well
 * below Restate's message limits; core-api's 1 MiB body limit and Kafka's 1 MB records stay under it.
 */
export const MAX_RUN_TEXT = 2_000_000;

/** A document's order key: a non-negative integer that grows with every change. */
const Version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------------------------
// Chunking: every Mastra strategy, with the options Mastra 2.6.5 validates for it (`MDocument.chunk`
// rejects unknown keys per strategy, so this mirrors its schemas). `lengthFunction` is left out: a
// function cannot travel in JSON.
// ---------------------------------------------------------------------------------------------

const size = z.number().int().positive().max(100_000);
const base = {
  /** Characters (tokens for `token`; ignored by `semantic-markdown` and header-only `markdown`). */
  maxSize: size.optional(),
  /** Mastra's default is 200, which must stay below `maxSize`. */
  overlap: z.number().int().min(0).max(50_000).optional(),
  /** Where a separator goes at a split. `start` keeps it with the next chunk (the default here). */
  separatorPosition: z.enum(['start', 'end']).optional(),
  /** Adds `metadata.startIndex`: the chunk's offset in the source text. */
  addStartIndex: z.boolean().optional(),
  stripWhitespace: z.boolean().optional(),
};
const encodingName = z.enum([
  'gpt2',
  'r50k_base',
  'p50k_base',
  'p50k_edit',
  'cl100k_base',
  'o200k_base',
]);
const tiktoken = {
  encodingName: encodingName.optional(),
  /** A tiktoken model name; overrides `encodingName`. */
  modelName: z.string().min(1).max(100).optional(),
  /** `'all'` or a list of special tokens (sent to Mastra as a Set). */
  allowedSpecial: z.union([z.literal('all'), z.array(z.string().max(100)).max(100)]).optional(),
  disallowedSpecial: z.union([z.literal('all'), z.array(z.string().max(100)).max(100)]).optional(),
};
/** `[marker, metadataKey]` pairs: `['#', 'h1']`, or `['h2', 'section']` for HTML. */
const headerPairs = z
  .array(z.tuple([z.string().min(1).max(20), MetadataKey]))
  .min(1)
  .max(12);
const LANGUAGES = [
  'cpp',
  'go',
  'java',
  'kotlin',
  'js',
  'ts',
  'php',
  'proto',
  'python',
  'rst',
  'ruby',
  'rust',
  'scala',
  'swift',
  'markdown',
  'latex',
  'html',
  'sol',
  'csharp',
  'cobol',
  'c',
  'lua',
  'perl',
  'haskell',
  'elixir',
  'powershell',
] as const;

export const ChunkingOptions = z.discriminatedUnion('strategy', [
  z.strictObject({
    strategy: z.literal('recursive'),
    ...base,
    separators: z.array(z.string().max(100)).min(1).max(32).optional(),
    isSeparatorRegex: z.boolean().optional(),
    /** Language-aware separators; replaces `separators`. */
    language: z.enum(LANGUAGES).optional(),
  }),
  z.strictObject({
    strategy: z.literal('character'),
    ...base,
    separator: z.string().max(100).optional(),
    isSeparatorRegex: z.boolean().optional(),
  }),
  z.strictObject({ strategy: z.literal('token'), ...base, ...tiktoken }),
  z.strictObject({
    strategy: z.literal('markdown'),
    ...base,
    /** With headers, splits on them only (and `maxSize`/`overlap` are not used). */
    headers: headerPairs.optional(),
    returnEachLine: z.boolean().optional(),
    stripHeaders: z.boolean().optional(),
  }),
  z.strictObject({
    strategy: z.literal('semantic-markdown'),
    ...base,
    /** Sections are merged while their token count stays below this. */
    joinThreshold: z.number().int().positive().max(100_000).optional(),
    ...tiktoken,
  }),
  z.strictObject({
    strategy: z.literal('html'),
    ...base,
    /** Exactly one of `headers` and `sections`. */
    headers: headerPairs.optional(),
    sections: headerPairs.optional(),
    returnEachLine: z.boolean().optional(),
  }),
  z.strictObject({
    strategy: z.literal('json'),
    ...base,
    maxSize: size,
    minSize: size.optional(),
    ensureAscii: z.boolean().optional(),
    convertLists: z.boolean().optional(),
  }),
  z.strictObject({ strategy: z.literal('latex'), ...base }),
  z.strictObject({
    strategy: z.literal('sentence'),
    ...base,
    maxSize: size,
    minSize: size.optional(),
    targetSize: size.optional(),
    sentenceEnders: z.array(z.string().min(1).max(10)).min(1).max(20).optional(),
    fallbackToWords: z.boolean().optional(),
    fallbackToCharacters: z.boolean().optional(),
  }),
]);
export type ChunkingOptions = z.infer<typeof ChunkingOptions>;

// ---------------------------------------------------------------------------------------------
// Metadata extraction: Mastra's extractors, each an LLM call per chunk. Opt-in and capped
// (`limits.maxExtractChunks`), because it multiplies the cost of indexing.
// ---------------------------------------------------------------------------------------------

const template = z.string().min(1).max(4000);
export const ExtractOptions = z.strictObject({
  /** LiteLLM `model_name`; defaults to `defaults.extractModel`. */
  model: z.string().min(1).max(200).optional(),
  /** Chunks per extraction call batch — the most LLM calls in flight at once. Default 4. */
  batchSize: z.number().int().min(1).max(16).optional(),
  /** `documentTitle`, inferred from the first `nodes` chunks (default 5). */
  title: z
    .union([
      z.boolean(),
      z.strictObject({
        nodes: z.number().int().min(1).max(20).optional(),
        nodeTemplate: template.optional(),
        combineTemplate: template.optional(),
      }),
    ])
    .optional(),
  /** `sectionSummary` (self), `prevSectionSummary`, `nextSectionSummary`. */
  summary: z
    .union([
      z.boolean(),
      z.strictObject({
        summaries: z
          .array(z.enum(['self', 'prev', 'next']))
          .min(1)
          .max(3)
          .optional(),
        promptTemplate: template.optional(),
      }),
    ])
    .optional(),
  /** `questionsThisExcerptCanAnswer`. */
  questions: z
    .union([
      z.boolean(),
      z.strictObject({
        questions: z.number().int().min(1).max(10).optional(),
        promptTemplate: template.optional(),
      }),
    ])
    .optional(),
  /** `excerptKeywords`. */
  keywords: z
    .union([
      z.boolean(),
      z.strictObject({
        keywords: z.number().int().min(1).max(20).optional(),
        promptTemplate: template.optional(),
      }),
    ])
    .optional(),
});
export type ExtractOptions = z.infer<typeof ExtractOptions>;

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

export const DocumentInput = z.strictObject({
  /** The producer's id for the document, unique within the collection. */
  id: DocumentId,
  text: z.string().min(1).max(MAX_TEXT),
  format: Format.default('text'),
  title: z.string().min(1).max(1000).optional(),
  /** Stored on every chunk, so searches can filter on it. Keys must not be pipeline-owned. */
  metadata: DocumentMetadata.optional(),
  /**
   * The document's own version: a non-negative integer that grows with every change. The newest
   * version wins however the writes land. Without one, the time the run was received decides — so
   * per collection, send it always or never.
   */
  version: Version.optional(),
});
export type DocumentInput = z.infer<typeof DocumentInput>;

export const IngestOptions = z.strictObject({
  chunking: ChunkingOptions.optional(),
  extract: ExtractOptions.optional(),
  embedding: z.strictObject({ batchSize: z.number().int().min(1).max(256).optional() }).optional(),
  /** Re-index even when a document's content and options are unchanged. */
  force: z.boolean().optional(),
});
export type IngestOptions = z.infer<typeof IngestOptions>;

export const RagIngestInput = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('upsert'),
    collection: CollectionName,
    /** Used only when this run creates the collection; must match an existing one if given. */
    collectionSettings: CollectionSettingsInput.optional(),
    documents: z.array(DocumentInput).min(1).max(MAX_DOCUMENTS),
    options: IngestOptions.optional(),
  }),
  z.strictObject({
    operation: z.literal('delete'),
    collection: CollectionName,
    documentIds: z.array(DocumentId).min(1).max(MAX_DOCUMENTS),
    /**
     * The order key of the delete, for producers that version their documents: without it, the
     * time the run was received decides — a scale a small version can never catch up with, so the
     * document could not be added again.
     */
    version: Version.optional(),
  }),
  z.strictObject({ operation: z.literal('drop'), collection: CollectionName }),
]);
export type RagIngestInput = z.infer<typeof RagIngestInput>;

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

export const DocumentStatus = z.enum([
  'written',
  'unchanged',
  'superseded',
  'deleted',
  'absent',
  'failed',
]);
export type DocumentStatus = z.infer<typeof DocumentStatus>;

export const RagIngestOutput = z.strictObject({
  operation: z.enum(['upsert', 'delete', 'drop']),
  collection: z.strictObject({
    name: z.string(),
    /** This run created the collection. */
    created: z.boolean(),
    /** For `drop`: whether there was anything to drop. */
    dropped: z.boolean().optional(),
    embeddingModel: z.string().optional(),
    dimension: z.number().int().optional(),
  }),
  documents: z.array(
    z.strictObject({
      documentId: z.string(),
      status: DocumentStatus,
      /** Chunks written, when this run wrote the document. */
      chunks: z.number().int().nonnegative().optional(),
      error: z.string().optional(),
    }),
  ),
  totals: z.strictObject({
    written: z.number().int(),
    unchanged: z.number().int(),
    superseded: z.number().int(),
    deleted: z.number().int(),
    absent: z.number().int(),
    failed: z.number().int(),
    chunks: z.number().int(),
  }),
  provenance: z.strictObject({
    trigger: z.enum(['rest', 'kafka']),
    version: z.string(),
    extractModel: z.string().optional(),
  }),
});
export type RagIngestOutput = z.infer<typeof RagIngestOutput>;

// ---------------------------------------------------------------------------------------------
// Config: defaults, limits and the Kafka event mappings (`metadata.json`)
// ---------------------------------------------------------------------------------------------

/** A dot path into an event, with `[n]` for array elements: `edata.name`, `tags[0]`. */
export const Path = z
  .string()
  .max(200)
  .regex(
    /^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*|\[\d+\])*$/,
    'a dot path, e.g. edata.name or tags[0]',
  );
const Scalar = z.union([z.string().max(1024), z.number(), z.boolean()]);
export const Condition = z.union([
  z.strictObject({ path: Path, equals: Scalar }),
  z.strictObject({ path: Path, in: z.array(Scalar).min(1).max(64) }),
  z.strictObject({ path: Path, exists: z.boolean() }),
]);
export type Condition = z.infer<typeof Condition>;

/**
 * How a Kafka trigger's events become runs. Every Kafka trigger with `"adapter": "<name>"` in
 * `metadata.json` names one of these, so a new source is configuration: a topic, an event shape and
 * a target collection.
 */
export const EventMapping = z.strictObject({
  collection: CollectionName,
  /** All must hold, or the event is not this mapping's business: skipped, no run. */
  when: z.array(Condition).max(16).default([]),
  /** All hold → the document is deleted instead of indexed. */
  deleteWhen: z.array(Condition).min(1).max(16).optional(),
  documentId: Path,
  /** One path, or several joined with blank lines (missing ones skipped). */
  text: z.union([Path, z.array(Path).min(1).max(16)]),
  title: Path.optional(),
  /** A non-negative integer or an ISO date (epoch milliseconds then). */
  version: Path.optional(),
  format: Format.default('text'),
  /** Chunk metadata key → path. Scalars and arrays of scalars are kept; anything else is skipped. */
  metadata: z.record(MetadataKey, Path).default({}),
  options: IngestOptions.optional(),
  collectionSettings: CollectionSettingsInput.optional(),
});
export type EventMapping = z.infer<typeof EventMapping>;

export const RagIngestConfig = z.strictObject({
  defaults: z.strictObject({
    /** Settings a collection gets when a run creates it without asking for others. */
    collection: CollectionSettings,
    chunking: ChunkingOptions,
    extractModel: z.string().min(1).max(200),
    embeddingBatchSize: z.number().int().min(1).max(256),
  }),
  limits: z.strictObject({
    /** Documents processed at once: each one embeds and writes in its own durable step. */
    documentConcurrency: z.number().int().min(1).max(32),
    /** Bounds one document's step, so it finishes well inside Restate's abort window. */
    maxChunksPerDocument: z.number().int().min(1).max(20_000),
    /** Extraction is an LLM call per chunk; above this, a document fails instead. */
    maxExtractChunks: z.number().int().min(1).max(1000),
  }),
  eventMappings: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9]*$/), EventMapping).default({}),
});
export type RagIngestConfig = z.infer<typeof RagIngestConfig>;

/** The `run` request: canonical input plus the trigger context the control plane attaches. */
export const RagIngestRequest = runRequest(RagIngestInput);
export type RagIngestRequest = z.infer<typeof RagIngestRequest>;
