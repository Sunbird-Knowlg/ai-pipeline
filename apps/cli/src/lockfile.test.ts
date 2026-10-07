import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '@ai-pipeline/contracts/schemas';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { workspaceClosure } from './artifact.js';
import { lockfileClosure, LockfileError, refToRelative, removeSuffix } from './lockfile.js';

const lock = (overrides: Record<string, unknown> = {}) => ({
  lockfileVersion: '9.0',
  settings: { autoInstallPeers: true },
  importers: {
    '.': { devDependencies: { turbo: { specifier: '2.11.2', version: '2.11.2' } } },
    'workflows/a': {
      dependencies: {
        '@ai-pipeline/runtime': {
          specifier: 'workspace:*',
          version: 'link:../../packages/runtime',
        },
        'string-width-cjs': { specifier: 'npm:string-width@^4.2.0', version: 'string-width@4.2.3' },
        vitest: {
          specifier: '4.1.11',
          version: '4.1.11(vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1))',
        },
      },
    },
    'workflows/b': { dependencies: { pg: { specifier: '8.23.0', version: '8.23.0' } } },
  },
  packages: {
    'turbo@2.11.2': { resolution: { integrity: 'sha512-t' } },
    'string-width@4.2.3': { resolution: { integrity: 'sha512-s' } },
    'vitest@4.1.11': { resolution: { integrity: 'sha512-v' } },
    'vite@8.3.0': { resolution: { integrity: 'sha512-vi' } },
    '@scope/peer@1.0.0': { resolution: { integrity: 'sha512-p' } },
    'pg@8.23.0': { resolution: { integrity: 'sha512-pg' } },
  },
  snapshots: {
    'turbo@2.11.2': {},
    'string-width@4.2.3': {},
    'vitest@4.1.11(vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1))': {
      dependencies: { vite: '8.3.0(@types/node@24.13.5)(yaml@2.9.1)' },
      optionalDependencies: { '@scope/peer': '@scope/peer@1.0.0' },
      transitivePeerDependencies: ['jiti'],
    },
    'vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1)': {},
    '@scope/peer@1.0.0': {},
    'pg@8.23.0': {},
  },
  ...overrides,
});

describe('refToRelative', () => {
  it('skips workspace links', () => {
    expect(refToRelative('link:../../packages/runtime', '@ai-pipeline/runtime')).toBeNull();
  });

  it('prefixes a plain version, peer suffix included', () => {
    expect(refToRelative('8.23.0', 'pg')).toBe('pg@8.23.0');
    expect(refToRelative('4.1.11(@types/node@24.13.5)', 'vitest')).toBe(
      'vitest@4.1.11(@types/node@24.13.5)',
    );
  });

  it('keeps an alias or a scoped reference as the key itself', () => {
    expect(refToRelative('string-width@4.2.3', 'string-width-cjs')).toBe('string-width@4.2.3');
    expect(refToRelative('@ai-sdk/provider@2.0.3', '@ai-sdk/provider-v5')).toBe(
      '@ai-sdk/provider@2.0.3',
    );
  });

  it('prefixes a reference whose @ only appears after a colon', () => {
    expect(refToRelative('file:../x@1', 'x')).toBe('x@file:../x@1');
  });
});

describe('removeSuffix', () => {
  it('strips nested peer groups and patch hashes, balancing parentheses', () => {
    expect(
      removeSuffix(
        'vitest@4.1.11(@opentelemetry/api@1.9.1)(@types/node@24.13.5)(vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1))',
      ),
    ).toBe('vitest@4.1.11');
    expect(removeSuffix('zod@4.6.5(patch_hash=abc123)')).toBe('zod@4.6.5');
    expect(removeSuffix('pg@8.23.0')).toBe('pg@8.23.0');
  });

  it('refuses unbalanced parentheses', () => {
    expect(() => removeSuffix('broken@1.0.0)')).toThrow(LockfileError);
  });
});

describe('lockfileClosure', () => {
  it('walks the closure importers and the root, through aliases, peers and optional edges', () => {
    const closure = lockfileClosure(lock(), ['workflows/a']) as {
      importers: Record<string, unknown>;
      snapshots: Record<string, unknown>;
      packages: Record<string, unknown>;
    };
    expect(Object.keys(closure.importers)).toEqual(['.', 'workflows/a']);
    expect(Object.keys(closure.snapshots).sort()).toEqual(
      [
        '@scope/peer@1.0.0',
        'string-width@4.2.3',
        'turbo@2.11.2',
        'vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1)',
        'vitest@4.1.11(vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1))',
      ].sort(),
    );
    expect(Object.keys(closure.packages)).toContain('vite@8.3.0');
    // workflows/b's resolution is not this closure's business.
    expect(Object.keys(closure.packages)).not.toContain('pg@8.23.0');
  });

  it('does not depend on key order', () => {
    const a = lock();
    const b = { ...lock(), snapshots: Object.fromEntries(Object.entries(a.snapshots).reverse()) };
    expect(canonicalJson(lockfileClosure(b, ['workflows/a']))).toBe(
      canonicalJson(lockfileClosure(a, ['workflows/a'])),
    );
  });

  it('ignores catalogs and time, but fails closed on anything unknown', () => {
    const base = canonicalJson(lockfileClosure(lock(), ['workflows/a']));
    const withCatalog = lock({ catalogs: { default: { pg: { specifier: '8', version: '8' } } } });
    expect(canonicalJson(lockfileClosure(withCatalog, ['workflows/a']))).toBe(base);
    expect(() => lockfileClosure(lock({ mystery: {} }), ['workflows/a'])).toThrow(/mystery/);
  });

  it('fails closed on a wrong version, a missing importer, a dangling reference or package', () => {
    expect(() => lockfileClosure(lock({ lockfileVersion: '6.0' }), [])).toThrow(/lockfileVersion/);
    expect(() => lockfileClosure(lock(), ['workflows/missing'])).toThrow(/no importer/);
    const dangling = lock();
    delete (dangling.snapshots as Record<string, unknown>)['@scope/peer@1.0.0'];
    expect(() => lockfileClosure(dangling, ['workflows/a'])).toThrow(/no snapshot/);
    const unpackaged = lock();
    delete (unpackaged.packages as Record<string, unknown>)['vite@8.3.0'];
    expect(() => lockfileClosure(unpackaged, ['workflows/a'])).toThrow(/no packages entry/);
  });

  it('scopes the real lockfile: svc-summary reaches the AI SDK but not the lint toolchain', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const closure = workspaceClosure(root, '@ai-pipeline/svc-summary');
    const dirs = [...closure.values()].map((dir) => dir.slice(root.length).replace(/\/$/, ''));
    const scoped = lockfileClosure(parse(readFileSync(`${root}pnpm-lock.yaml`, 'utf8')), dirs) as {
      snapshots: Record<string, unknown>;
    };
    const keys = Object.keys(scoped.snapshots);
    expect(keys).toContain('ai@7.0.109(zod@4.6.5)');
    expect(keys.some((key) => key.includes('typescript-eslint'))).toBe(false);
  });
});
