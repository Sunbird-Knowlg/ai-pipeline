import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerate } from './generate.js';

/**
 * Drives `createGenerate` through a stubbed `fetch`, not a stubbed `Generate` -- these cases are
 * exactly the ones where the real `ai` SDK throws instead of returning data (`NoObjectGeneratedError`,
 * `NoOutputGeneratedError`), which every test that stubs `Generate` above the SDK cannot catch.
 */

const TRANSLATIONS_SCHEMA = {
  type: 'object',
  additionalProperties: { type: 'string' },
};

function chatCompletion(content: string, finishReason: string) {
  return {
    id: 'chatcmpl-1',
    model: 'chat-default',
    choices: [{ message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
}

function stubFetch(body: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createGenerate', () => {
  it('returns truncated JSON as data instead of throwing NoObjectGeneratedError', async () => {
    // Cut off mid-object: valid JSON prefix, no closing brace -- generateText's own JSON.parse
    // fails, which the SDK surfaces as a thrown NoObjectGeneratedError, not a return value.
    stubFetch(chatCompletion('{"1": "hola", "2": "mu', 'length'));
    const generate = createGenerate({ baseUrl: 'http://litellm.local' });

    const result = await generate({
      model: 'chat-default',
      prompt: 'translate',
      schema: TRANSLATIONS_SCHEMA,
      schemaName: 'translations',
    });

    expect(result.finishReason).toBe('length');
    expect(result.object).toBeUndefined();
  });

  it('returns an empty, non-stop reply as data instead of throwing NoOutputGeneratedError (with schema)', async () => {
    // Empty content *and* a non-'stop' finish: the SDK never attempts to parse an output at all,
    // so later reading `.output` is what throws -- not the call to generateText itself.
    stubFetch(chatCompletion('', 'length'));
    const generate = createGenerate({ baseUrl: 'http://litellm.local' });

    const result = await generate({
      model: 'chat-default',
      prompt: 'translate',
      schema: TRANSLATIONS_SCHEMA,
      schemaName: 'translations',
    });

    expect(result.finishReason).toBe('length');
    expect(result.object).toBeUndefined();
  });

  it('never touches the throwing .output getter when no schema was requested', async () => {
    // Same empty/non-stop shape as above, but with no schema -- a caller that never asked for
    // structured output must not be able to crash on a getter it never reads.
    stubFetch(chatCompletion('', 'content_filter'));
    const generate = createGenerate({ baseUrl: 'http://litellm.local' });

    const result = await generate({ model: 'chat-default', prompt: 'summarize' });

    expect(result.finishReason).toBe('content-filter');
    expect(result).not.toHaveProperty('object');
  });
});
