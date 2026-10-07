import type { DocumentMetadata, Format } from '@ai-pipeline/rag/schemas';
import { MDocument } from '@mastra/rag';
import type { ChunkingOptions } from './schemas.js';

/** A chunk of a document: its text, and the metadata Mastra derived for it (headers, offsets…). */
export interface Chunk {
  text: string;
  metadata: Record<string, unknown>;
}

/** The `MDocument` factory for a format, so each format gets its own parser and default splitter. */
function mdocument(text: string, format: Format, metadata: DocumentMetadata): MDocument {
  switch (format) {
    case 'markdown':
      return MDocument.fromMarkdown(text, metadata);
    case 'html':
      return MDocument.fromHTML(text, metadata);
    case 'json':
      return MDocument.fromJSON(text, metadata);
    case 'latex':
      return new MDocument({ docs: [{ text, metadata }], type: 'latex' });
    case 'text':
      return MDocument.fromText(text, metadata);
  }
}

/** Our options as Mastra's `chunk()` takes them: token lists become the Sets it expects. */
function chunkParams(options: ChunkingOptions): Parameters<MDocument['chunk']>[0] {
  if (options.strategy !== 'token' && options.strategy !== 'semantic-markdown')
    return options as Parameters<MDocument['chunk']>[0];
  const { allowedSpecial, disallowedSpecial, ...rest } = options;
  const set = (value: 'all' | string[] | undefined) =>
    value === undefined ? undefined : value === 'all' ? 'all' : new Set(value);
  return {
    ...rest,
    ...(allowedSpecial !== undefined ? { allowedSpecial: set(allowedSpecial) } : {}),
    ...(disallowedSpecial !== undefined ? { disallowedSpecial: set(disallowedSpecial) } : {}),
  } as Parameters<MDocument['chunk']>[0];
}

/**
 * Splits one document with Mastra. Deterministic for a given input and Mastra version — the run's
 * deployment pins both — so a retried step produces the same chunks. Chunks with no text are
 * dropped: they would only embed noise.
 */
export async function chunkDocument(
  document: { text: string; format: Format; metadata: DocumentMetadata },
  options: ChunkingOptions,
): Promise<Chunk[]> {
  const chunks = await mdocument(document.text, document.format, document.metadata).chunk(
    chunkParams(options),
  );
  return chunks
    .filter((chunk) => chunk.text.trim() !== '')
    .map((chunk) => ({ text: chunk.text, metadata: { ...chunk.metadata } }));
}
