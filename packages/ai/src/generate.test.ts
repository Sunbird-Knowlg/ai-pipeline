import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenerate } from './generate.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A LiteLLM `/v1/chat/completions` stand-in that stops for the given reason. */
function gateway(finishReason: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        id: 'c-1',
        object: 'chat.completion',
        created: 0,
        model: 'chat-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Leaves are' },
            finish_reason: finishReason,
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      }),
    ),
  );
}

describe('createGenerate', () => {
  const generate = createGenerate({ baseUrl: 'http://litellm:4000', apiKey: 'k' });

  it('says when the model ran out of output tokens, so a cut-off answer can be told apart', async () => {
    gateway('length');
    await expect(generate({ model: 'chat-test', prompt: 'Why green?' })).resolves.toMatchObject({
      text: 'Leaves are',
      finishReason: 'length',
    });
    gateway('stop');
    await expect(generate({ model: 'chat-test', prompt: 'Why green?' })).resolves.toMatchObject({
      finishReason: 'stop',
    });
  });
});
