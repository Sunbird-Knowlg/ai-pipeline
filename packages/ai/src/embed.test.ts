import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEmbed, InvalidEmbeddingError } from './embed.js';
import { isRetryableModelError } from './errors.js';

/** A LiteLLM `/v1/embeddings` stand-in: one vector per input, `[length of input, index, 1, …]`. */
function gateway(dimension: (input: string, index: number) => number = () => 3) {
  const bodies: { input: string[]; dimensions?: number }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string) as { input: string[]; dimensions?: number };
      bodies.push(body);
      return Response.json({
        object: 'list',
        model: 'embed-test',
        data: body.input.map((text, index) => ({
          object: 'embedding',
          index,
          embedding: Array.from({ length: dimension(text, index) }, (_, i) =>
            i === 0 ? text.length : i === 1 ? index : 1,
          ),
        })),
        usage: { prompt_tokens: body.input.length, total_tokens: body.input.length },
      });
    }),
  );
  return bodies;
}

const embed = createEmbed({ baseUrl: 'http://litellm:4000', apiKey: 'k' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createEmbed', () => {
  it('sends batches one at a time and returns the vectors in input order', async () => {
    const bodies = gateway();
    const result = await embed({ model: 'embed-test', values: ['a', 'bb', 'ccc'], batchSize: 2 });
    expect(bodies.map((b) => b.input)).toEqual([['a', 'bb'], ['ccc']]);
    expect(result.embeddings.map((v) => v[0])).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ model: 'embed-test', dimension: 3, usage: { tokens: 3 } });
  });

  it('asks for the requested dimensions, and refuses vectors of any other size', async () => {
    const bodies = gateway(() => 4);
    await expect(
      embed({ model: 'embed-test', values: ['a'], dimensions: 3 }),
    ).rejects.toBeInstanceOf(InvalidEmbeddingError);
    expect(bodies[0]?.dimensions).toBe(3);
  });

  it('refuses vectors whose sizes disagree, and says not to retry', async () => {
    gateway((_text, index) => (index === 0 ? 3 : 2));
    const error = await embed({ model: 'embed-test', values: ['a', 'b'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidEmbeddingError);
    expect(isRetryableModelError(error)).toBe(false);
  });

  it('returns nothing for nothing, without a model call', async () => {
    const bodies = gateway();
    await expect(embed({ model: 'embed-test', values: [] })).resolves.toMatchObject({
      embeddings: [],
    });
    expect(bodies).toHaveLength(0);
  });
});
