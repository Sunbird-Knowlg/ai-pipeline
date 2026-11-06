import type { BlobDownloader, BlobUploader } from '@ai-pipeline/blob-storage/upload';
import { whisperApi } from '@ai-pipeline/contract-whisper/api';
import type { KnowlgClient } from '@ai-pipeline/knowlg-client/client';
import type * as restate from '@restatedev/restate-sdk';
import * as restateSdk from '@restatedev/restate-sdk';
import * as clients from '@restatedev/restate-sdk-clients';
import { RestateContainer, RestateTestEnvironment } from '@restatedev/restate-sdk-testcontainers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Generate, GenerateResult } from '@ai-pipeline/ai/generate';
import type { TranscriptOutput, TranscriptRequest } from './schemas.js';
import { createTranscript } from './workflow.js';

// By-name clients are typed with the handler map (callers outside Restate need no implementation).
type TranscriptWf = {
  run: (ctx: restate.WorkflowContext, request: TranscriptRequest) => Promise<TranscriptOutput>;
};

/**
 * Runs the real handler against a Restate server with always-replay on, so any non-determinism
 * (reading outside ctx.run, native Promise combinators, Date.now, ...) fails here instead of on
 * a production retry.
 */
describe('Transcript (always replay)', () => {
  const sourceSegments = [
    { id: 0, start: 0, end: 5, text: 'Hello world' },
    { id: 1, start: 5, end: 10, text: 'Goodbye world' },
  ];

  const createEnrichmentObject = vi.fn(async (body: Record<string, unknown>) => {
    if (body.sourceLanguage) return { identifier: 'src-1', status: 'Draft' };
    return { identifier: `lang-${body.languageCode as string}`, status: 'Draft' };
  });
  const approveEnrichmentObject = vi.fn(async (identifier: string) => ({
    identifier,
    status: 'Live',
  }));
  const knowlg: KnowlgClient = {
    readContent: vi.fn(async () => ({ artifactUrl: 'https://example.com/video.mp4' })),
    createEnrichmentObject,
    updateEnrichmentObject: vi.fn(async () => ({})),
    approveEnrichmentObject,
    rejectEnrichmentObject: vi.fn(async () => ({})),
  };
  const uploadBlob = vi.fn<BlobUploader>(async ({ path }) => ({
    url: `https://blob.local/${path}`,
  }));
  const downloadBlob = vi.fn<BlobDownloader>(async () => {
    throw new Error('source is never already-Live in this test');
  });
  // Mirrors each chunk's requested segment ids back as "translated" text -- translateChunk only
  // cares that every requested id comes back, not what the text actually says.
  const generate = vi.fn<Generate>(async ({ prompt }): Promise<GenerateResult> => {
    const requested: { id: number }[] = JSON.parse(prompt.split('\n').at(-1)!);
    const object = Object.fromEntries(requested.map((s) => [String(s.id), `[tr] ${s.id}`]));
    return {
      text: '',
      model: 'chat-default',
      usage: { outputTokens: 10 },
      finishReason: 'stop',
      object,
    };
  });

  let env: RestateTestEnvironment;
  let ingress: clients.Ingress;
  let runExecutions = 0;

  beforeAll(async () => {
    const transcript = createTranscript({
      knowlg,
      uploadBlob,
      downloadBlob,
      generate,
      log: {
        info: () => undefined,
        debug: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      } as never,
    });
    const whisper = restateSdk.implement(whisperApi, {
      handlers: {
        transcribe: async () => ({
          language: 'en',
          languageProbability: 0.99,
          duration: 10,
          segments: sourceSegments,
        }),
      },
    });
    const definitions = [transcript, whisper];
    // Service-level options override server defaults, so always-replay must be forced per service:
    // suspend at every await (replay), and fail fast on a journal mismatch.
    for (const d of definitions as unknown as { options?: object }[])
      d.options = {
        ...d.options,
        inactivityTimeout: 0,
        retryPolicy: { maxAttempts: 3, onMaxAttempts: 'kill' },
      };
    // Count executions of the workflow body to prove it really replays.
    // (The SDK keeps the function on the HandlerWrapper behind Symbol(Handler).)
    type Fn = (...args: unknown[]) => Promise<unknown>;
    const run = (transcript as unknown as { workflow: { run: Record<symbol, unknown> } }).workflow
      .run;
    const handlerSymbol = Object.getOwnPropertySymbols(run).find(
      (s) => s.description === 'Handler',
    );
    const wrapper = run[handlerSymbol!] as { handler: Fn };
    const body = wrapper.handler;
    wrapper.handler = (...args) => {
      runExecutions++;
      return body(...args);
    };
    // Must match compose.yaml's pinned restate image -- see restate-version.test.ts.
    env = await RestateTestEnvironment.start({ services: definitions }, () =>
      new RestateContainer('1.7.10').alwaysReplay(),
    );
    ingress = clients.connect({ url: env.baseUrl() });
  });

  afterAll(async () => env?.stop());

  it('runs once per run id, transcribes once and translates into every other target language', async () => {
    const request: TranscriptRequest = {
      input: { identifier: 'c-1', objectType: 'Content', mimeType: 'video/mp4', channel: 'all' },
      trigger: { type: 'rest', id: 'api', receivedAt: 1_700_000_000_000 },
    };
    const client = ingress.workflowClient<TranscriptWf>({ name: 'Transcript' }, 'api_run_1');
    const first = await client.workflowSubmit(request);
    const again = await client.workflowSubmit(request);
    expect(first.status).toBe('Accepted');
    expect(again.status).toBe('PreviouslyAccepted');

    const output = await client.workflowAttach();
    expect(output).toMatchObject({
      parentId: 'c-1',
      source: { identifier: 'src-1', languageCode: 'en', status: 'Live' },
    });
    // en is the detected source language -- not translated again -- so ar/pt/fr remain.
    expect(output.translations.map((t) => t.languageCode).sort()).toEqual(['ar', 'fr', 'pt']);
    expect(output.translations.every((t) => t.status === 'Live')).toBe(true);

    // The body replayed many times over the run's many awaits, yet every durable side effect
    // (behind ctx.run or a service call) ran exactly once.
    expect(runExecutions).toBeGreaterThan(1);
    expect(createEnrichmentObject).toHaveBeenCalledTimes(4); // source + 3 languages
    expect(approveEnrichmentObject).toHaveBeenCalledTimes(4);
    expect(uploadBlob).toHaveBeenCalledTimes(8); // (transcript.json + captions.vtt) * 4
    expect(generate).toHaveBeenCalledTimes(3); // one translation call per target language
  });
});
