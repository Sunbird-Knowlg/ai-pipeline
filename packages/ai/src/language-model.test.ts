import { generateText } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLanguageModels } from './language-model.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createLanguageModels', () => {
  it('bounds each request by the timeout, since the library driving the model sets none', async () => {
    // A gateway that never answers: only the request's own signal can end the call.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal!.reason as Error);
            });
          }),
      ),
    );
    const models = createLanguageModels({
      baseUrl: 'http://litellm:4000',
      apiKey: 'k',
      timeoutMs: 50,
    });
    const started = Date.now();
    await expect(
      generateText({ model: models('chat-test'), prompt: 'hi', maxRetries: 0 }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
