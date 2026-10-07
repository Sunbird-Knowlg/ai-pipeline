import type { TriggerContext } from '@ai-pipeline/contracts/trigger';
import * as restate from '@restatedev/restate-sdk';
import { describe, expect, it } from 'vitest';
import { chunkingProblems, configProblems, extractPlan, planIngest } from './plan.js';
import { RagIngestConfig, RagIngestInput, type RagIngestInput as Input } from './schemas.js';
import { config } from './unit.js';

const trigger: TriggerContext = { type: 'rest', id: 'api', receivedAt: 1_700_000_000_000 };

const upsert = (overrides: Record<string, unknown> = {}): Input =>
  RagIngestInput.parse({
    operation: 'upsert',
    collection: 'docs',
    documents: [{ id: 'a', text: 'Alpha.' }],
    ...overrides,
  });

function refusal(input: Input): string {
  try {
    planIngest(input, config, trigger, 'run-1');
  } catch (error) {
    expect(error).toBeInstanceOf(restate.TerminalError);
    expect((error as restate.TerminalError).code).toBe(400);
    return (error as Error).message;
  }
  throw new Error('expected planIngest to refuse');
}

describe('planIngest', () => {
  it('fills the defaults and orders documents by version, else by when the run arrived', () => {
    const plan = planIngest(
      upsert({
        documents: [
          { id: 'a', text: 'Alpha.' },
          { id: 'b', text: 'Beta.', version: 7, metadata: { lang: 'en' } },
        ],
      }),
      config,
      trigger,
      'run-1',
    );
    expect(plan).toMatchObject({
      operation: 'upsert',
      settings: config.defaults.collection,
      explicit: false,
      embeddingBatchSize: config.defaults.embeddingBatchSize,
      force: false,
      documents: [
        {
          id: 'a',
          format: 'text',
          metadata: {},
          order: { seq: trigger.receivedAt, runId: 'run-1' },
        },
        { id: 'b', metadata: { lang: 'en' }, order: { seq: 7, runId: 'run-1' } },
      ],
    });
  });

  it('marks collection settings as explicit and merges them over the defaults', () => {
    const plan = planIngest(
      upsert({ collectionSettings: { index: { metric: 'dotproduct' } } }),
      config,
      trigger,
      'r',
    );
    expect(plan).toMatchObject({
      explicit: true,
      settings: { index: { ...config.defaults.collection.index, metric: 'dotproduct' } },
    });
  });

  it('keeps a separator position the caller chose', () => {
    const plan = planIngest(
      upsert({ options: { chunking: { strategy: 'character', separatorPosition: 'end' } } }),
      config,
      trigger,
      'r',
    );
    expect(plan).toMatchObject({
      documents: [{ chunking: { strategy: 'character', separatorPosition: 'end' } }],
    });
  });

  it('splits on a document’s structure by default, but applies requested options as given', () => {
    const documents = [
      { id: 't', text: 'x' },
      { id: 'm', text: '# x', format: 'markdown' },
      { id: 'h', text: '<p>x</p>', format: 'html' },
      { id: 'j', text: '{}', format: 'json' },
    ];
    const byDefault = planIngest(upsert({ documents }), config, trigger, 'r');
    expect(byDefault.operation === 'upsert' && byDefault.documents.map((d) => d.chunking)).toEqual([
      { ...config.defaults.chunking, separatorPosition: 'start' },
      { ...config.defaults.chunking, separatorPosition: 'start', language: 'markdown' },
      { ...config.defaults.chunking, separatorPosition: 'start', language: 'html' },
      { ...config.defaults.chunking, separatorPosition: 'start' },
    ]);
    const requested = planIngest(
      upsert({
        documents,
        options: { chunking: { strategy: 'recursive', maxSize: 500, overlap: 0 } },
      }),
      config,
      trigger,
      'r',
    );
    expect(
      requested.operation === 'upsert' &&
        requested.documents.every((d) => !('language' in d.chunking)),
    ).toBe(true);
  });

  it('refuses duplicate ids, reserved metadata keys and unusable settings, all at once', () => {
    const message = refusal(
      upsert({
        documents: [
          { id: 'a', text: 'x', metadata: { text: 'mine', chunkIndex: 1 } },
          { id: 'a', text: 'y' },
        ],
        collectionSettings: { embedding: { queryTemplate: 'no placeholder here' } },
      }),
    );
    expect(message).toMatch(/"a" appears twice/);
    expect(message).toMatch(/text, chunkIndex/);
    expect(message).toMatch(/\{query\}/);
  });

  it('plans deletes and drops without touching documents', () => {
    expect(
      planIngest(
        { operation: 'delete', collection: 'docs', documentIds: ['a', 'a', 'b'] },
        config,
        trigger,
        'r',
      ),
    ).toEqual({
      operation: 'delete',
      collection: 'docs',
      documentIds: ['a', 'b'],
      order: { seq: trigger.receivedAt, runId: 'r' },
    });
    expect(planIngest({ operation: 'drop', collection: 'docs' }, config, trigger, 'r')).toEqual({
      operation: 'drop',
      collection: 'docs',
    });
  });
});

describe('planIngest: ordering and bounds', () => {
  it('orders a delete by its version when it carries one, else by when the run arrived', () => {
    const versioned = planIngest(
      { operation: 'delete', collection: 'docs', documentIds: ['a'], version: 9 },
      config,
      trigger,
      'r',
    );
    expect(versioned).toMatchObject({ order: { seq: 9, runId: 'r' } });
    const timed = planIngest(
      { operation: 'delete', collection: 'docs', documentIds: ['a'] },
      config,
      trigger,
      'r',
    );
    expect(timed).toMatchObject({ order: { seq: trigger.receivedAt } });
  });

  it('refuses a run whose documents together carry more text than a run may', () => {
    const big = 'x'.repeat(1_000_000);
    const message = refusal(
      upsert({
        documents: [
          { id: 'a', text: big },
          { id: 'b', text: big },
          { id: 'c', text: 'one more' },
        ],
      }),
    );
    expect(message).toMatch(/2000008 characters; a run takes at most 2000000/);
  });
});

describe('configProblems', () => {
  it('passes the shipped configuration', () => {
    expect(configProblems(config)).toEqual([]);
  });

  it('finds, at boot, what would otherwise fail every run or every mapped event', () => {
    const broken = RagIngestConfig.parse({
      ...config,
      defaults: {
        ...config.defaults,
        chunking: { strategy: 'recursive', maxSize: 100, overlap: 100 },
      },
      eventMappings: {
        documentEvent: {
          ...config.eventMappings.documentEvent,
          metadata: { title: 'title', lang: 'lang' },
          collectionSettings: { embedding: { queryTemplate: 'no placeholder' } },
          options: { chunking: { strategy: 'html', maxSize: 500 } },
        },
      },
    });
    expect(configProblems(broken)).toEqual([
      'defaults.chunking: overlap (100) must be smaller than maxSize (100)',
      'eventMappings.documentEvent.metadata uses keys the pipeline writes itself: title',
      'eventMappings.documentEvent.collectionSettings: embedding.queryTemplate must contain {query}',
      'eventMappings.documentEvent.options.chunking: the html strategy needs exactly one of headers and sections',
    ]);
  });
});

describe('chunkingProblems', () => {
  it('catches an overlap that Mastra would refuse, including its default of 200', () => {
    expect(chunkingProblems({ strategy: 'recursive', maxSize: 100, overlap: 100 })).toHaveLength(1);
    expect(chunkingProblems({ strategy: 'recursive', maxSize: 150 })[0]).toMatch(/default/);
    expect(chunkingProblems({ strategy: 'recursive', maxSize: 150, overlap: 10 })).toEqual([]);
    // Header-only markdown and semantic-markdown do not use the sizes at all.
    expect(chunkingProblems({ strategy: 'markdown', maxSize: 10, headers: [['#', 'h1']] })).toEqual(
      [],
    );
    expect(chunkingProblems({ strategy: 'sentence', maxSize: 100 })).toEqual([]);
  });

  it('wants exactly one of headers and sections for html, and sizes that fit together', () => {
    expect(chunkingProblems({ strategy: 'html', maxSize: 1000, overlap: 0 })).toHaveLength(1);
    expect(
      chunkingProblems({ strategy: 'html', headers: [['h1', 'h1']], sections: [['h2', 's']] }),
    ).toHaveLength(1);
    expect(chunkingProblems({ strategy: 'html', headers: [['h1', 'h1']] })).toEqual([]);
    expect(
      chunkingProblems({ strategy: 'sentence', maxSize: 100, minSize: 200, targetSize: 300 }),
    ).toHaveLength(2);
  });
});

describe('extractPlan', () => {
  it('is nothing when nothing is asked for', () => {
    expect(extractPlan(undefined, 'chat')).toBeUndefined();
    expect(extractPlan({ title: false }, 'chat')).toBeUndefined();
  });

  it('fills Mastra’s defaults for each extractor that is on', () => {
    expect(
      extractPlan({ title: true, summary: { summaries: ['prev'] }, keywords: true }, 'chat'),
    ).toEqual({
      model: 'chat',
      batchSize: 4,
      title: { nodes: 5 },
      summary: { summaries: ['prev'] },
      keywords: { keywords: 5 },
    });
  });
});
