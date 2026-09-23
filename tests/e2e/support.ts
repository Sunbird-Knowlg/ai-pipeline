import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import type { RunView } from '@ai-pipeline/api-contract/runs';
import { expect, vi } from 'vitest';

/**
 * E2E helpers. Preconditions: `docker compose up -d --build` is running, host Ollama serves
 * `qwen3.5:4b`, and `pnpm build` has produced the CLI (`apps/cli/dist`).
 *
 * The response types come from `@ai-pipeline/api-contract`, so a change to the wire shape shows up
 * here as a type error instead of an assertion that quietly stops checking anything.
 */
export const API = process.env.CORE_API_URL ?? 'http://127.0.0.1:3000';
export const ADMIN = process.env.RESTATE_ADMIN_URL ?? 'http://127.0.0.1:9070';

/** `T` is the body this call expects — `ErrorEnvelope` when the test asserts a refusal. */
export async function api<T>(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(new URL(path, API), {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text ? JSON.parse(text) : undefined) as T,
    headers: response.headers,
  };
}

/** Restate's introspection SQL (DataFusion) over the admin API. */
export async function restateSql<T = Record<string, string>>(query: string): Promise<T[]> {
  const response = await fetch(new URL('/query', ADMIN), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  return ((await response.json()) as { rows: T[] }).rows;
}

/** Runs the built CLI and parses its JSON output. Throws (with stderr) on a non-zero exit. */
export function cli<T = unknown>(...args: string[]): T {
  const out = execFileSync('node', ['apps/cli/dist/main.js', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return (out.trim() ? JSON.parse(out) : undefined) as T;
}

export function compose(...args: string[]): string {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

export function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export function publish(topic: string, value: unknown): void {
  execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'kafka',
      '/opt/kafka/bin/kafka-console-producer.sh',
      '--bootstrap-server',
      'localhost:9092',
      '--topic',
      topic,
    ],
    { input: `${JSON.stringify(value)}\n`, stdio: ['pipe', 'ignore', 'pipe'] },
  );
}

export async function waitForRun(
  workflow: string,
  runId: string,
  timeout = 240_000,
): Promise<RunView> {
  let run: RunView | undefined;
  await vi.waitFor(
    async () => {
      run = (await api<RunView>('GET', `/v1/runs/${workflow}/${runId}`)).body;
      expect(['completed', 'failed', 'cancelled']).toContain(run?.status);
    },
    { timeout, interval: 1000 },
  );
  return run!;
}

/**
 * Temporarily rewrites a unit's `metadata.json` (restored by the returned function). The callback
 * mutates the raw JSON, so it is deliberately loosely typed.
 */
export function patchMetadata(path: string, patch: (metadata: any) => void): () => void {
  const original = readFileSync(path, 'utf8');
  const next = JSON.parse(original);
  patch(next);
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return () => writeFileSync(path, original);
}

export const uniq = () =>
  `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
