import { opaqueJson } from '@ai-pipeline/api-contract/params';
import { runView } from '@ai-pipeline/api-contract/runs';
import { responseSchema } from '@ai-pipeline/api-contract/serialization';
import { workflowDetail } from '@ai-pipeline/api-contract/workflows';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

/**
 * The guardrail for response schemas.
 *
 * Fastify serialises a described response with `fast-json-stringify`, which drops anything the
 * schema does not mention. That is the point — a route cannot quietly return a field the contract
 * never promised — but it also means a mistake in a schema silently truncates a response. These
 * tests pin the two properties the API depends on: fields the contract declares survive (including
 * arbitrarily nested opaque JSON), and fields it does not are removed.
 */
function serve(schema: Record<string, unknown>, body: unknown) {
  const app = Fastify();
  app.get('/', { schema: { response: { 200: schema } } }, async () => body);
  return app.inject({ url: '/' }).then((res) => JSON.parse(res.body) as Record<string, unknown>);
}

describe('run view', () => {
  const base = {
    runId: 'kf_1',
    invocationId: 'inv_1',
    workflow: 'content-enrichment',
    status: 'completed',
    restateStatus: 'completed',
    createdAt: '2026-01-01T00:00:00.000Z',
  };

  it('passes a unit’s own JSON through untouched, however deeply nested', async () => {
    const trigger = {
      type: 'kafka',
      id: 'content-published',
      partition: 2,
      offset: 41,
      nested: { list: [1, 2, { deep: true }] },
    };
    const output = {
      contentId: 'c-1',
      summary: 'a summary',
      metadata: { wordCount: 4, readingTimeMinutes: 0.1, model: 'chat-default' },
    };

    const body = await serve(responseSchema(runView), { ...base, trigger, output });
    expect(body.trigger).toEqual(trigger);
    expect(body.output).toEqual(output);
  });

  it('drops a field the contract does not declare', async () => {
    const body = await serve(responseSchema(runView), { ...base, secret: 'internal detail' });
    expect(body).not.toHaveProperty('secret');
    expect(body.runId).toBe('kf_1');
  });

  it('omits optional fields that are absent rather than emitting null', async () => {
    const body = await serve(responseSchema(runView), base);
    expect(Object.keys(body).sort()).toEqual(
      ['createdAt', 'invocationId', 'restateStatus', 'runId', 'status', 'workflow'].sort(),
    );
  });
});

describe('RAG responses', () => {
  // The RAG routes answer with `RagQuery`'s own JSON, which core-api deliberately does not describe
  // (it never imports a unit's contract). An opaque schema must therefore drop nothing.
  it('pass the service’s JSON through untouched, whatever its shape', async () => {
    const answer = {
      status: 'answered',
      answer: 'Restate journals every step [S1], so a crash replays it [S2].',
      citations: [
        { id: 'S1', documentId: 'guides/intro.md', chunkIndex: 0, score: 0.8125 },
        { id: 'S2', documentId: 'guides/replay.md', chunkIndex: 3, score: 0.5 },
      ],
      hits: [{ metadata: { tags: ['a', 'b'], lang: 'en', version: null, nested: { deep: [1] } } }],
      nextCursor: null,
      unicode: 'naïve — ✓',
    };
    expect(await serve(responseSchema(opaqueJson), answer)).toEqual(answer);
  });

  it('pass a top-level array through too', async () => {
    const collections = [{ name: 'docs', documents: 2 }, { name: 'notes' }];
    expect(await serve(responseSchema(opaqueJson), collections)).toEqual(collections);
  });
});

describe('workflow detail', () => {
  it('keeps the generated JSON Schemas and the declared config intact', async () => {
    const schemas = {
      input: {
        type: 'object',
        properties: { contentId: { type: 'string' }, text: { type: 'string' } },
        required: ['contentId', 'text'],
        additionalProperties: false,
      },
      output: { type: 'object', properties: { summary: { type: 'string' } } },
      config: { type: 'object', properties: { summaryMaxWords: { type: 'integer' } } },
    };

    const body = await serve(responseSchema(workflowDetail), {
      name: 'content-enrichment',
      kind: 'workflow',
      version: '1.0.0',
      restateName: 'ContentEnrichment',
      visibility: 'public',
      description: 'Summarises published content',
      config: { summaryMaxWords: 120 },
      schemas,
      contractHash: `sha256:${'a'.repeat(64)}`,
      triggers: [{ id: 'api', type: 'rest', desiredEnabled: true, observedStatus: 'active' }],
      dependencies: [{ name: 'summary', kind: 'service' }],
      versions: [
        {
          version: '1.0.0',
          contractHash: `sha256:${'a'.repeat(64)}`,
          registeredAt: '2026-01-01T00:00:00.000Z',
        },
      ],
      deployments: [],
    });

    expect(body.schemas).toEqual(schemas);
    expect(body.config).toEqual({ summaryMaxWords: 120 });
    expect(body.triggers).toEqual([
      { id: 'api', type: 'rest', desiredEnabled: true, observedStatus: 'active' },
    ]);
  });
});
