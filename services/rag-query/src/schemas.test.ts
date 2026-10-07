import { readFileSync } from 'node:fs';
import { contractSchemas } from '@ai-pipeline/contracts/schemas';
import { encodeCursor } from '@ai-pipeline/rag/store';
import { RE2JS } from 're2js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from './contract.js';
import {
  AnswerRequest,
  AnswerResponse,
  CollectionView,
  CollectionsResponse,
  DocumentResponse,
  DocumentsResponse,
  GetCollectionRequest,
  GetDocumentRequest,
  ListCollectionsRequest,
  ListDocumentsRequest,
  RagQueryConfig,
  SearchRequest,
  SearchResponse,
  configProblems,
} from './schemas.js';

const HANDLERS = {
  search: [SearchRequest, SearchResponse],
  answer: [AnswerRequest, AnswerResponse],
  listCollections: [ListCollectionsRequest, CollectionsResponse],
  getCollection: [GetCollectionRequest, CollectionView],
  listDocuments: [ListDocumentsRequest, DocumentsResponse],
  getDocument: [GetDocumentRequest, DocumentResponse],
} as const;

describe('the RagQuery contract', () => {
  it('uses only patterns core-api’s RE2 engine compiles (it refuses the contract otherwise)', () => {
    const patterns = (node: unknown): string[] =>
      Array.isArray(node)
        ? node.flatMap(patterns)
        : node && typeof node === 'object'
          ? Object.entries(node).flatMap(([key, value]) =>
              key === 'pattern' && typeof value === 'string' ? [value] : patterns(value),
            )
          : [];
    const found = patterns(contractSchemas(contract));
    expect(found.length).toBeGreaterThan(0);
    for (const pattern of found) expect(() => RE2JS.compile(pattern), pattern).not.toThrow();
  });

  it('converts to JSON Schema for the catalogue', () => {
    expect(() => contractSchemas(contract)).not.toThrow();
    expect(contract.handler).toBe('search');
  });

  it('has no refinement in any handler, catalogued or not', () => {
    // The catalogue lists `search` only, but every handler is meant to be expressible: a hidden
    // `.refine()` would make the published schema weaker than what the handler enforces.
    for (const [handler, [input, output]] of Object.entries(HANDLERS)) {
      expect(() => contractSchemas({ ...contract, handler, input, output }), handler).not.toThrow();
      expect(
        () => z.toJSONSchema(input, { target: 'draft-07', io: 'input' }),
        handler,
      ).not.toThrow();
    }
  });

  it('is what metadata.json configures, consistently', () => {
    const metadata = JSON.parse(
      readFileSync(new URL('../metadata.json', import.meta.url), 'utf8'),
    ) as { config: unknown; visibility: string };
    expect(metadata.visibility).toBe('public');
    const config = RagQueryConfig.parse(metadata.config);
    expect(config).toEqual({
      answerModel: 'chat-default',
      rerankModel: 'chat-default',
      defaults: { topK: 5 },
      limits: { maxTopK: 50, maxCandidates: 20, maxContextChars: 12_000, maxOutputTokens: 2048 },
    });
    expect(configProblems(config)).toEqual([]);
    expect(configProblems({ ...config, defaults: { topK: 51 } })).toEqual([
      'defaults.topK (51) exceeds limits.maxTopK (50)',
      'defaults.topK (51) exceeds limits.maxCandidates (20)',
    ]);
    // A bare `rerank: {}` keeps topK hits, so a default above the candidates would always fail.
    expect(configProblems({ ...config, defaults: { topK: 21 } })).toEqual([
      'defaults.topK (21) exceeds limits.maxCandidates (20)',
    ]);
  });
});

describe('SearchRequest', () => {
  const valid = { collection: 'docs', query: 'how do roots drink?' };

  it('needs a collection name and a query, and takes every knob as optional', () => {
    expect(SearchRequest.safeParse(valid).success).toBe(true);
    expect(
      SearchRequest.safeParse({
        ...valid,
        topK: 50,
        filter: { lang: 'en', year: { $gte: 2020 } },
        minScore: -0.5,
        includeVector: true,
        ef: 1000,
        probes: 1,
        rerank: {
          model: 'm',
          candidates: 20,
          topK: 20,
          weights: { semantic: 1, vector: 0, position: 0 },
        },
      }).success,
    ).toBe(true);
    expect(SearchRequest.safeParse({ collection: 'docs' }).success).toBe(false);
    expect(SearchRequest.safeParse({ query: 'q' }).success).toBe(false);
  });

  it('holds every field to its range', () => {
    for (const bad of [
      { collection: 'Docs' },
      { collection: '1docs' },
      { query: '' },
      { query: 'x'.repeat(4001) },
      { topK: 0 },
      { topK: 51 },
      { topK: 1.5 },
      { ef: 1001 },
      { probes: 0 },
      { filter: 'lang = en' },
      { rerank: { candidates: 21 } },
      { rerank: { topK: 0 } },
      { rerank: { weights: { semantic: 1.5, vector: 0, position: 0 } } },
      { rerank: { weights: { semantic: 1 } } },
    ])
      expect(SearchRequest.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
  });

  it('refuses unknown keys, here and in the rerank options', () => {
    expect(SearchRequest.safeParse({ ...valid, question: 'q' }).success).toBe(false);
    expect(SearchRequest.safeParse({ ...valid, rerank: { k: 1 } }).success).toBe(false);
  });
});

describe('AnswerRequest', () => {
  const valid = { collection: 'docs', question: 'What absorbs light?' };

  it('asks a question, with the retrieval knobs and the generation ones', () => {
    expect(AnswerRequest.safeParse(valid).success).toBe(true);
    expect(
      AnswerRequest.safeParse({
        ...valid,
        topK: 8,
        filter: { lang: 'en' },
        rerank: { candidates: 16 },
        model: 'chat-big',
        temperature: 0.2,
        maxOutputTokens: 512,
        maxContextChars: 8000,
        instructions: 'Answer in two sentences.',
      }).success,
    ).toBe(true);
  });

  it('holds the generation knobs to their ranges, and has no query or vectors', () => {
    for (const bad of [
      { question: '' },
      { temperature: 2.1 },
      { maxOutputTokens: 63 },
      { maxOutputTokens: 4097 },
      { maxContextChars: 499 },
      { maxContextChars: 50_001 },
      { instructions: 'x'.repeat(2001) },
      { includeVector: true },
      { query: 'q' },
    ])
      expect(AnswerRequest.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(
        false,
      );
  });
});

describe('the listing requests', () => {
  it('take an empty object to list collections', () => {
    expect(ListCollectionsRequest.safeParse({}).success).toBe(true);
    expect(ListCollectionsRequest.safeParse({ collection: 'docs' }).success).toBe(false);
  });

  it('page through documents with an optional limit and cursor', () => {
    expect(ListDocumentsRequest.safeParse({ collection: 'docs' }).success).toBe(true);
    expect(
      ListDocumentsRequest.safeParse({ collection: 'docs', limit: 200, cursor: 'abc' }).success,
    ).toBe(true);
    expect(ListDocumentsRequest.safeParse({ collection: 'docs', limit: 201 }).success).toBe(false);
    expect(
      ListDocumentsRequest.safeParse({ collection: 'docs', cursor: 'x'.repeat(2049) }).success,
    ).toBe(false);
  });

  it('take back the cursor of the longest id there can be', () => {
    // 512 characters of three UTF-8 bytes each: the longest cursor the store can hand out.
    const cursor = encodeCursor('क'.repeat(512));
    expect(cursor).toHaveLength(2048);
    expect(ListDocumentsRequest.safeParse({ collection: 'docs', cursor }).success).toBe(true);
  });

  it('name a document by an id without control characters', () => {
    expect(GetDocumentRequest.safeParse({ collection: 'docs', documentId: 'a/b c' }).success).toBe(
      true,
    );
    expect(
      GetDocumentRequest.safeParse({ collection: 'docs', documentId: 'a\nb', chunks: true })
        .success,
    ).toBe(false);
  });
});
