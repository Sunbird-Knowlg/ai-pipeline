import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { parseMetadata } from '@ai-pipeline/metadata/metadata';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  InvalidRegistration,
  outcomeOf,
  register,
  RegistrationFailed,
  RegistrationRefused,
  registrationTarget,
  type RegistrationTarget,
} from './register.js';

/**
 * Self-registration: what the runtime refuses to send, and which answers from core-api it retries.
 * A wrong call here either registers a build that should have been refused or leaves a healthy one
 * crash-looping, so both halves are pinned down.
 */

const metadata = parseMetadata({
  apiVersion: 'ai-pipeline/v1alpha1',
  kind: 'workflow',
  name: 'order-fulfilment',
  restateName: 'OrderFulfilment',
  version: '1.2.3',
});

const contract: ContractEntry = {
  restateName: 'OrderFulfilment',
  handler: 'run',
  input: z.strictObject({ id: z.string() }),
  output: z.strictObject({ ok: z.boolean() }),
  config: z.strictObject({}),
};

const env = {
  CORE_API_URL: 'http://core-api:3000',
  ADVERTISED_ENDPOINT: 'http://order-fulfilment-abc:9080',
  ARTIFACT_DIGEST: 'sha256:abc',
};

describe('registrationTarget', () => {
  it('builds the request core-api expects from the unit and its environment', () => {
    const { coreApiUrl, request } = registrationTarget({ metadata, contract }, env);
    expect(coreApiUrl).toBe('http://core-api:3000');
    expect(request).toMatchObject({
      metadata,
      artifactDigest: 'sha256:abc',
      endpoint: 'http://order-fulfilment-abc:9080',
      mode: 'immutable',
    });
    expect(request.contractHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.keys(request.schemas).sort()).toEqual(['config', 'input', 'output']);
  });

  it('honours dev mode', () => {
    const { request } = registrationTarget(
      { metadata, contract },
      { ...env, DEPLOYMENT_MODE: 'dev' },
    );
    expect(request.mode).toBe('dev');
  });

  it('refuses to register without knowing where it runs, or which artifact it is', () => {
    for (const missing of ['CORE_API_URL', 'ADVERTISED_ENDPOINT', 'ARTIFACT_DIGEST'] as const) {
      const partial: Record<string, string> = { ...env };
      delete partial[missing];
      expect(() => registrationTarget({ metadata, contract }, partial)).toThrow(
        InvalidRegistration,
      );
    }
    // An image built without `--build-arg ARTIFACT_DIGEST` has it set, but empty.
    expect(() =>
      registrationTarget({ metadata, contract }, { ...env, ARTIFACT_DIGEST: '' }),
    ).toThrow(/ARTIFACT_DIGEST/);
  });

  it('refuses a contract that names a different Restate service', () => {
    expect(() =>
      registrationTarget({ metadata, contract: { ...contract, restateName: 'Other' } }, env),
    ).toThrow(/restateName Other ≠ metadata restateName OrderFulfilment/);
  });

  it('refuses a workflow whose entry handler is not `run`', () => {
    expect(() =>
      registrationTarget({ metadata, contract: { ...contract, handler: 'start' } }, env),
    ).toThrow(/must be "run"/);
  });
});

const target: RegistrationTarget = registrationTarget({ metadata, contract }, env);

const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const envelope = (code: string) => ({ error: { code, message: 'nope' } });
const accepted = {
  name: 'order-fulfilment',
  version: '1.2.3',
  deploymentId: 'dp_1',
  active: true,
  alreadyRegistered: false,
  triggers: [],
};

const noSleep = async () => undefined;

describe('register', () => {
  it('posts the request to core-api and returns its reply', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(reply(201, accepted));
    await expect(register(target, { fetch, sleep: noSleep })).resolves.toEqual(accepted);

    const [url, init] = fetch.mock.calls[0]!;
    expect((url as URL).href).toBe('http://core-api:3000/v1/deployments');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual(target.request);
  });

  it('retries 502/503 and an unreachable core-api, then succeeds', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(reply(502, envelope('RESTATE_UNAVAILABLE')))
      .mockResolvedValueOnce(reply(503, envelope('CATALOGUE_SYNC_FAILED')))
      .mockResolvedValueOnce(reply(201, accepted));
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(register(target, { fetch, sleep })).resolves.toEqual(accepted);
    expect(fetch).toHaveBeenCalledTimes(4);
    // Backs off, capped, rather than hammering a core-api that is still starting.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 2000, 4000]);
  });

  it('does not retry a refusal that will not change', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(reply(409, envelope('DEPENDENCY_NOT_DEPLOYED')));
    const error = await register(target, { fetch, sleep: noSleep }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RegistrationRefused);
    expect(error).toMatchObject({ status: 409, code: 'DEPENDENCY_NOT_DEPLOYED' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('gives up after the attempt limit rather than spinning forever', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation(async () => reply(502, envelope('RESTATE_UNAVAILABLE')));
    await expect(register(target, { fetch, sleep: noSleep, maxAttempts: 5 })).rejects.toThrow(
      RegistrationFailed,
    );
    expect(fetch).toHaveBeenCalledTimes(5);
  });
});

describe('outcomeOf', () => {
  it('maps each result onto the logged outcome the deploy CLI reads', () => {
    expect(outcomeOf(accepted)).toEqual({ outcome: 'registered', result: accepted });
    expect(outcomeOf(new RegistrationRefused(409, 'X', 'X: nope'))).toEqual({
      outcome: 'refused',
      status: 409,
      code: 'X',
      message: 'X: nope',
    });
    expect(outcomeOf(new InvalidRegistration('bad'))).toEqual({
      outcome: 'invalid',
      message: 'bad',
    });
    expect(outcomeOf(new RegistrationFailed('down'))).toEqual({
      outcome: 'failed',
      message: 'down',
    });
  });
});
