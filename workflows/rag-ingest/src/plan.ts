import type { TriggerContext } from '@ai-pipeline/contracts/trigger';
import {
  type CollectionSettings,
  RESERVED_METADATA,
  resolveSettings,
  settingsProblems,
} from '@ai-pipeline/rag/schemas';
import type { Order } from '@ai-pipeline/rag/store';
import * as restate from '@restatedev/restate-sdk';
import {
  type ChunkingOptions,
  type DocumentInput,
  type ExtractOptions,
  MAX_RUN_TEXT,
  type RagIngestConfig,
  type RagIngestInput,
} from './schemas.js';

/**
 * Turning a run's input into what the steps execute: defaults filled in, and every rule a JSON
 * Schema cannot state checked up front. Pure and deterministic — it runs again on every replay.
 */

/** Mastra's own defaults, for the size arithmetic its splitters check when they are built. */
const MASTRA_MAX_SIZE = 4000;
const MASTRA_OVERLAP = 200;

/** What extraction does, with every default resolved. */
export interface ExtractPlan {
  model: string;
  batchSize: number;
  title?: { nodes: number; nodeTemplate?: string; combineTemplate?: string };
  summary?: { summaries: ('self' | 'prev' | 'next')[]; promptTemplate?: string };
  questions?: { questions: number; promptTemplate?: string };
  keywords?: { keywords: number; promptTemplate?: string };
}

export interface PlannedDocument {
  id: string;
  text: string;
  format: DocumentInput['format'];
  title?: string;
  metadata: NonNullable<DocumentInput['metadata']>;
  order: Order;
  /** The run's chunking options, or the format-aware default (`chunkingFor`). */
  chunking: ChunkingOptions;
}

export interface UpsertPlan {
  operation: 'upsert';
  collection: string;
  settings: CollectionSettings;
  /** The run asked for settings, so an existing collection must have exactly these. */
  explicit: boolean;
  documents: PlannedDocument[];
  extract?: ExtractPlan;
  embeddingBatchSize: number;
  force: boolean;
}

export interface DeletePlan {
  operation: 'delete';
  collection: string;
  documentIds: string[];
  order: Order;
}

export interface DropPlan {
  operation: 'drop';
  collection: string;
}

export type Plan = UpsertPlan | DeletePlan | DropPlan;

const reserved = new Set<string>(RESERVED_METADATA);

/** The rules on chunking options that their JSON Schema cannot state. */
export function chunkingProblems(options: ChunkingOptions): string[] {
  const problems: string[] = [];
  const maxSize = options.maxSize ?? MASTRA_MAX_SIZE;
  const overlap = options.overlap ?? (options.strategy === 'sentence' ? 0 : MASTRA_OVERLAP);
  const sizeMatters = !(
    options.strategy === 'semantic-markdown' ||
    (options.strategy === 'markdown' && options.headers)
  );
  if (sizeMatters && overlap >= maxSize)
    problems.push(
      `chunking: overlap (${overlap}${options.overlap === undefined ? ', Mastra’s default' : ''}) must be smaller than maxSize (${maxSize})`,
    );
  if (options.strategy === 'html' && !options.headers === !options.sections)
    problems.push('chunking: the html strategy needs exactly one of headers and sections');
  if (
    (options.strategy === 'json' || options.strategy === 'sentence') &&
    options.minSize !== undefined &&
    options.minSize > options.maxSize
  )
    problems.push(`chunking: minSize (${options.minSize}) is above maxSize (${options.maxSize})`);
  if (
    options.strategy === 'sentence' &&
    options.targetSize !== undefined &&
    options.targetSize > options.maxSize
  )
    problems.push(
      `chunking: targetSize (${options.targetSize}) is above maxSize (${options.maxSize})`,
    );
  return problems;
}

/** Recursive chunking's separators for each format that has structure worth splitting on. */
const FORMAT_LANGUAGE = { markdown: 'markdown', html: 'html', latex: 'latex' } as const;

/**
 * The chunking a document gets. Options the run gives apply as they are, to every document. Without
 * them, the configured default applies — and when that is the recursive splitter with no separators
 * of its own, it splits on the document's structure: Markdown headings, HTML blocks, LaTeX sections.
 * (Recursive over the format's separators rather than Mastra's markdown strategy, which rewrites
 * text and ignores `maxSize`.) A split's separator stays with the chunk it starts, unless the
 * options say otherwise.
 */
export function chunkingFor(
  format: DocumentInput['format'],
  requested: ChunkingOptions | undefined,
  defaults: ChunkingOptions,
): ChunkingOptions {
  const options = requested ?? defaults;
  const language =
    !requested &&
    options.strategy === 'recursive' &&
    !options.separators &&
    !options.language &&
    format !== 'text' &&
    format !== 'json'
      ? FORMAT_LANGUAGE[format]
      : undefined;
  return {
    separatorPosition: 'start',
    ...options,
    ...(language ? { language } : {}),
  };
}

/** Extraction with every default filled in, or `undefined` when nothing is asked for. */
export function extractPlan(
  options: ExtractOptions | undefined,
  defaultModel: string,
): ExtractPlan | undefined {
  if (!options) return undefined;
  const pick = <T extends object>(value: boolean | T | undefined): T | undefined =>
    value === true ? ({} as T) : value === false || value === undefined ? undefined : value;
  const title = pick(options.title);
  const summary = pick(options.summary);
  const questions = pick(options.questions);
  const keywords = pick(options.keywords);
  if (!title && !summary && !questions && !keywords) return undefined;
  return {
    model: options.model ?? defaultModel,
    batchSize: options.batchSize ?? 4,
    ...(title ? { title: { ...title, nodes: title.nodes ?? 5 } } : {}),
    ...(summary ? { summary: { ...summary, summaries: summary.summaries ?? ['self'] } } : {}),
    ...(questions ? { questions: { ...questions, questions: questions.questions ?? 5 } } : {}),
    ...(keywords ? { keywords: { ...keywords, keywords: keywords.keywords ?? 5 } } : {}),
  };
}

/**
 * The rules on the unit's own configuration that its schema cannot state (a catalogued contract
 * carries no `.refine()`): the ones `planIngest` would otherwise find on every run, or on every
 * event of a mapping. Checked at boot, so a misconfigured unit fails to start instead.
 */
export function configProblems(config: RagIngestConfig): string[] {
  const { defaults } = config;
  const problems = [
    ...settingsProblems(defaults.collection).map((p) => `defaults.collection: ${p}`),
    ...chunkingProblems(defaults.chunking).map((p) => `defaults.${p}`),
  ];
  for (const [name, mapping] of Object.entries(config.eventMappings)) {
    const at = `eventMappings.${name}`;
    const clash = Object.keys(mapping.metadata).filter((key) => reserved.has(key));
    if (clash.length > 0)
      problems.push(`${at}.metadata uses keys the pipeline writes itself: ${clash.join(', ')}`);
    if (mapping.collectionSettings)
      problems.push(
        ...settingsProblems(resolveSettings(defaults.collection, mapping.collectionSettings)).map(
          (p) => `${at}.collectionSettings: ${p}`,
        ),
      );
    if (mapping.options?.chunking)
      problems.push(...chunkingProblems(mapping.options.chunking).map((p) => `${at}.options.${p}`));
  }
  return problems;
}

/**
 * The run's order key for one document: its own version when it has one, else when the run was
 * received. The run id breaks ties, so two runs never claim the same order.
 */
export const orderOf = (version: number | undefined, trigger: TriggerContext, runId: string) => ({
  seq: version ?? trigger.receivedAt,
  runId,
});

export function planIngest(
  input: RagIngestInput,
  config: RagIngestConfig,
  trigger: TriggerContext,
  runId: string,
): Plan {
  if (input.operation === 'drop') return { operation: 'drop', collection: input.collection };
  if (input.operation === 'delete')
    return {
      operation: 'delete',
      collection: input.collection,
      documentIds: [...new Set(input.documentIds)],
      order: orderOf(input.version, trigger, runId),
    };

  const problems: string[] = [];
  const settings = resolveSettings(config.defaults.collection, input.collectionSettings);
  problems.push(...settingsProblems(settings).map((p) => `collectionSettings: ${p}`));

  problems.push(
    ...chunkingProblems(chunkingFor('text', input.options?.chunking, config.defaults.chunking)),
  );

  const total = input.documents.reduce((sum, document) => sum + document.text.length, 0);
  if (total > MAX_RUN_TEXT)
    problems.push(
      `documents carry ${total} characters; a run takes at most ${MAX_RUN_TEXT} — split it into several`,
    );

  const seen = new Set<string>();
  for (const document of input.documents) {
    if (seen.has(document.id)) problems.push(`documents: "${document.id}" appears twice`);
    seen.add(document.id);
    const clash = Object.keys(document.metadata ?? {}).filter((key) => reserved.has(key));
    if (clash.length > 0)
      problems.push(
        `documents["${document.id}"].metadata uses keys the pipeline writes itself: ${clash.join(', ')}`,
      );
  }

  if (problems.length > 0)
    throw new restate.TerminalError(`invalid rag-ingest input: ${problems.join('; ')}`, {
      errorCode: 400,
    });

  const extract = extractPlan(input.options?.extract, config.defaults.extractModel);
  return {
    operation: 'upsert',
    collection: input.collection,
    settings,
    explicit: input.collectionSettings !== undefined,
    documents: input.documents.map((document) => ({
      id: document.id,
      text: document.text,
      format: document.format,
      ...(document.title ? { title: document.title } : {}),
      metadata: document.metadata ?? {},
      order: orderOf(document.version, trigger, runId),
      chunking: chunkingFor(document.format, input.options?.chunking, config.defaults.chunking),
    })),
    ...(extract ? { extract } : {}),
    embeddingBatchSize: input.options?.embedding?.batchSize ?? config.defaults.embeddingBatchSize,
    force: input.options?.force ?? false,
  };
}
