import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sourceDigest } from './artifact.js';

/**
 * Artifact identity.
 *
 * Deployments are immutable, and this digest is what "the same build" means: if it fails to change
 * when the image would, the control plane serves stale code under a version that promises otherwise.
 * So the tests here are mostly "does changing X change the digest" — and one "does it stay stable".
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Pkg {
  name: string;
  dir: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  files?: Record<string, string>;
  metadata?: string;
}

/** A miniature workspace: `pnpm-workspace.yaml`, the build recipe, and the given packages. */
function workspace(packages: Pkg[]): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-pipeline-digest-'));
  roots.push(root);
  writeFileSync(
    join(root, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\n  - services/*\n  - workflows/*\n',
  );
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'repo' }));
  writeFileSync(join(root, 'Dockerfile'), 'FROM node\n');
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  writeFileSync(join(root, 'turbo.json'), '{}\n');

  mkdirSync(join(root, 'packages/typescript-config'), { recursive: true });
  writeFileSync(
    join(root, 'packages/typescript-config/base.json'),
    JSON.stringify({ compilerOptions: { strict: true } }),
  );

  for (const pkg of packages) {
    const dir = join(root, pkg.dir);
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        name: pkg.name,
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
      }),
    );
    writeFileSync(join(dir, 'tsconfig.json'), '{}\n');
    if (pkg.metadata !== undefined) writeFileSync(join(dir, 'metadata.json'), pkg.metadata);
    for (const [path, content] of Object.entries(pkg.files ?? { 'src/main.ts': 'export {};\n' })) {
      const full = join(dir, path);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, content);
    }
  }
  return root;
}

const unit = (overrides: Partial<Pkg> = {}): Pkg => ({
  name: '@ai-pipeline/wf-example',
  dir: 'workflows/example',
  metadata: JSON.stringify({ version: '1.0.0' }),
  ...overrides,
});

describe('sourceDigest', () => {
  it('is stable across calls and starts with the hash algorithm', () => {
    const root = workspace([unit()]);
    const first = sourceDigest(root, '@ai-pipeline/wf-example');
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(sourceDigest(root, '@ai-pipeline/wf-example')).toBe(first);
  });

  it('changes when the unit’s own source changes', () => {
    const before = workspace([unit()]);
    const after = workspace([unit({ files: { 'src/main.ts': 'export const x = 1;\n' } })]);
    expect(sourceDigest(after, '@ai-pipeline/wf-example')).not.toBe(
      sourceDigest(before, '@ai-pipeline/wf-example'),
    );
  });

  it('changes when a workspace dependency’s source changes', () => {
    const dep = (body: string): Pkg[] => [
      unit({ dependencies: { '@ai-pipeline/runtime': 'workspace:*' } }),
      { name: '@ai-pipeline/runtime', dir: 'packages/runtime', files: { 'src/serve.ts': body } },
    ];
    const before = workspace(dep('export const a = 1;\n'));
    const after = workspace(dep('export const a = 2;\n'));
    expect(sourceDigest(after, '@ai-pipeline/wf-example')).not.toBe(
      sourceDigest(before, '@ai-pipeline/wf-example'),
    );
  });

  it('changes when the shared compiler config changes, though it is only a devDependency', () => {
    const root = workspace([unit()]);
    const before = sourceDigest(root, '@ai-pipeline/wf-example');
    writeFileSync(
      join(root, 'packages/typescript-config/base.json'),
      JSON.stringify({ compilerOptions: { strict: true, target: 'ES2021' } }),
    );
    expect(sourceDigest(root, '@ai-pipeline/wf-example')).not.toBe(before);
  });

  it('changes when the build recipe or the lockfile changes', () => {
    for (const [file, content] of [
      ['Dockerfile', 'FROM node:24\n'],
      ['pnpm-lock.yaml', 'lockfileVersion: 9.1\n'],
      ['turbo.json', '{"tasks":{}}\n'],
    ] as const) {
      const root = workspace([unit()]);
      const before = sourceDigest(root, '@ai-pipeline/wf-example');
      writeFileSync(join(root, file), content);
      expect(sourceDigest(root, '@ai-pipeline/wf-example'), file).not.toBe(before);
    }
  });

  it('changes when metadata.json changes, since it ships in the image', () => {
    const before = workspace([unit()]);
    const after = workspace([unit({ metadata: JSON.stringify({ version: '1.0.1' }) })]);
    expect(sourceDigest(after, '@ai-pipeline/wf-example')).not.toBe(
      sourceDigest(before, '@ai-pipeline/wf-example'),
    );
  });

  it('ignores test code, which never reaches the image', () => {
    const before = workspace([unit()]);
    const after = workspace([
      unit({
        files: {
          'src/main.ts': 'export {};\n',
          'src/main.test.ts': 'it("x", () => {});\n',
          'src/testing/stubs.ts': 'export const stub = 1;\n',
        },
      }),
    ]);
    expect(sourceDigest(after, '@ai-pipeline/wf-example')).toBe(
      sourceDigest(before, '@ai-pipeline/wf-example'),
    );
  });

  it('ignores the source of a devDependency, which is test-only wiring', () => {
    // A devDependency is how the replay test reaches another unit; it never enters the image. Only
    // the dependency's *source* varies here — the unit's own manifest is identical in both trees,
    // since that manifest is part of the digest in its own right.
    const trees = (body: string) =>
      workspace([
        unit({ devDependencies: { '@ai-pipeline/other': 'workspace:*' } }),
        { name: '@ai-pipeline/other', dir: 'packages/other', files: { 'src/a.ts': body } },
      ]);
    expect(sourceDigest(trees('export const a = 2;\n'), '@ai-pipeline/wf-example')).toBe(
      sourceDigest(trees('export const a = 1;\n'), '@ai-pipeline/wf-example'),
    );
  });

  it('includes the unit’s own manifest, so declaring a dependency is itself a new artifact', () => {
    const before = workspace([unit()]);
    const after = workspace([unit({ devDependencies: { '@ai-pipeline/other': 'workspace:*' } })]);
    expect(sourceDigest(after, '@ai-pipeline/wf-example')).not.toBe(
      sourceDigest(before, '@ai-pipeline/wf-example'),
    );
  });

  it('ignores dotfiles', () => {
    const root = workspace([unit()]);
    const before = sourceDigest(root, '@ai-pipeline/wf-example');
    writeFileSync(join(root, 'workflows/example/src/.DS_Store'), 'junk');
    expect(sourceDigest(root, '@ai-pipeline/wf-example')).toBe(before);
  });

  it('distinguishes moving a file from renaming its content', () => {
    const before = workspace([unit({ files: { 'src/a.ts': 'export const x = 1;\n' } })]);
    const after = workspace([unit({ files: { 'src/b.ts': 'export const x = 1;\n' } })]);
    // The path is part of the hash, so the same bytes at a different path is a different artifact.
    expect(sourceDigest(after, '@ai-pipeline/wf-example')).not.toBe(
      sourceDigest(before, '@ai-pipeline/wf-example'),
    );
  });
});
