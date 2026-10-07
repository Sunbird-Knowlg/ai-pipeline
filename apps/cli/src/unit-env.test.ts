import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { scopedUnitEnv } from './unit-env.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-pipeline-env-'));
  roots.push(root);
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - workflows/*\n');
  const pkg = (dir: string, name: string, dependencies: Record<string, string> = {}) => {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'package.json'), JSON.stringify({ name, dependencies }));
  };
  pkg('packages/rag', '@ai-pipeline/rag');
  pkg('packages/runtime', '@ai-pipeline/runtime');
  pkg('workflows/rag-ingest', '@ai-pipeline/wf-rag-ingest', { '@ai-pipeline/rag': 'workspace:*' });
  pkg('workflows/summary', '@ai-pipeline/wf-summary', { '@ai-pipeline/runtime': 'workspace:*' });
  return root;
}

describe('scopedUnitEnv', () => {
  it('gives the RAG store only to units built on it', () => {
    const root = workspace();
    const lookup = (key: string) => ({ POSTGRES_PASSWORD: 'p@ss' })[key];
    expect(scopedUnitEnv(root, '@ai-pipeline/wf-rag-ingest', lookup)).toEqual({
      RAG_DATABASE_URL: 'postgres://pipeline:p%40ss@postgres:5432/rag',
      MASTRA_TELEMETRY_DISABLED: '1',
    });
    expect(scopedUnitEnv(root, '@ai-pipeline/wf-summary', lookup)).toEqual({});
  });

  it('prefers an explicit database URL, and fails loudly when there is neither', () => {
    const root = workspace();
    expect(
      scopedUnitEnv(root, '@ai-pipeline/wf-rag-ingest', (key) =>
        key === 'UNIT_RAG_DATABASE_URL' ? 'postgres://elsewhere/rag' : undefined,
      ).RAG_DATABASE_URL,
    ).toBe('postgres://elsewhere/rag');
    expect(() => scopedUnitEnv(root, '@ai-pipeline/wf-rag-ingest', () => undefined)).toThrow(
      /POSTGRES_PASSWORD/,
    );
  });

  it('reads a blank variable as unset, never as an empty URL', () => {
    const root = workspace();
    const blank = (key: string) => ({ UNIT_RAG_DATABASE_URL: ' ', POSTGRES_PASSWORD: ' p ' })[key];
    expect(scopedUnitEnv(root, '@ai-pipeline/wf-rag-ingest', blank).RAG_DATABASE_URL).toBe(
      'postgres://pipeline:%20p%20@postgres:5432/rag',
    );
    expect(() =>
      scopedUnitEnv(root, '@ai-pipeline/wf-rag-ingest', (key) =>
        key === 'UNIT_RAG_DATABASE_URL' || key === 'POSTGRES_PASSWORD' ? '' : undefined,
      ),
    ).toThrow(/POSTGRES_PASSWORD/);
  });
});
