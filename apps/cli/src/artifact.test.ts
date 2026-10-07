import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { sourceDigest } from './artifact.js';
import { removeSuffix } from './lockfile.js';

/**
 * Artifact identity.
 *
 * Deployments are immutable, and this digest is what "the same build" means: if it fails to change
 * when the image would, the control plane serves stale code under a version that promises otherwise
 * (invariant 5). If it changes when the image could not, adding one unit forces a version bump of
 * every other one (invariant 17). So the tests here come in pairs: "does changing X change the
 * digest", and "does changing Y leave it alone".
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Pkg {
  name: string;
  dir: string;
  /** `workspace:*` for a workspace package, else an external version (peer suffix allowed). */
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  /** Files relative to the package directory. */
  files?: Record<string, string>;
  metadata?: string;
}

interface World {
  /** The root package's devDependencies, external only. */
  rootDevDependencies?: Record<string, string>;
  rootScripts?: Record<string, string>;
  /** Snapshot edges: snapshot key → its dependencies (name → version). */
  graph?: Record<string, Record<string, string>>;
  /** `pnpm-workspace.yaml` catalog, mirrored into the lockfile's `catalogs:`. */
  catalog?: Record<string, string>;
  turbo?: string;
  /** Other files at the workspace root (`.npmrc`, `patches/…`). */
  rootFiles?: Record<string, string>;
}

const GROUPS = ['packages', 'services', 'workflows'];

/**
 * A miniature workspace, with a lockfile pnpm could have written for it: an importer per package
 * (and `.`), plus the snapshot and package entries every external dependency reaches.
 */
function workspace(packages: Pkg[], world: World = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-pipeline-digest-'));
  roots.push(root);
  const write = (path: string, content: string) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };

  write(
    'pnpm-workspace.yaml',
    stringify({
      packages: GROUPS.map((g) => `${g}/*`),
      ...(world.catalog ? { catalog: world.catalog } : {}),
    }),
  );
  write(
    'package.json',
    JSON.stringify({
      name: 'repo',
      scripts: world.rootScripts ?? { build: 'turbo run build' },
      devDependencies: world.rootDevDependencies ?? { turbo: '2.11.2' },
    }),
  );
  write('Dockerfile', 'FROM node\n');
  write('turbo.json', world.turbo ?? '{}\n');
  write(
    'packages/typescript-config/base.json',
    JSON.stringify({ compilerOptions: { strict: true } }),
  );
  for (const [path, content] of Object.entries(world.rootFiles ?? {})) write(path, content);

  const dirOf = new Map(packages.map((pkg) => [pkg.name, pkg.dir]));
  const importer = (from: string, deps: Record<string, string> = {}) =>
    Object.fromEntries(
      Object.entries(deps).map(([name, spec]) => [
        name,
        spec.startsWith('workspace:')
          ? { specifier: spec, version: `link:${relative(from, dirOf.get(name) ?? name)}` }
          : { specifier: removeSuffix(`${name}@${spec}`).slice(name.length + 1), version: spec },
      ]),
    );
  const blocks = (from: string, pkg: Partial<Pkg>) =>
    Object.fromEntries(
      (['dependencies', 'devDependencies', 'optionalDependencies'] as const)
        .filter((kind) => pkg[kind] && Object.keys(pkg[kind]).length > 0)
        .map((kind) => [kind, importer(from, pkg[kind])]),
    );

  const importers: Record<string, unknown> = {
    '.': blocks('.', { devDependencies: world.rootDevDependencies ?? { turbo: '2.11.2' } }),
  };
  const externals: string[] = [];
  const collect = (deps: Record<string, string> = {}) => {
    for (const [name, spec] of Object.entries(deps))
      if (!spec.startsWith('workspace:')) externals.push(`${name}@${spec}`);
  };
  collect(world.rootDevDependencies ?? { turbo: '2.11.2' });
  for (const pkg of packages) {
    importers[pkg.dir] = blocks(pkg.dir, pkg);
    collect(pkg.dependencies);
    collect(pkg.devDependencies);
    collect(pkg.optionalDependencies);
  }
  const snapshots: Record<string, unknown> = {};
  const lockPackages: Record<string, unknown> = {};
  while (externals.length) {
    const key = externals.pop()!;
    if (key in snapshots) continue;
    const edges = world.graph?.[key];
    snapshots[key] = edges ? { dependencies: edges } : {};
    lockPackages[removeSuffix(key)] = { resolution: { integrity: `sha512-${removeSuffix(key)}` } };
    for (const [name, version] of Object.entries(edges ?? {})) externals.push(`${name}@${version}`);
  }
  write(
    'pnpm-lock.yaml',
    stringify({
      lockfileVersion: '9.0',
      settings: { autoInstallPeers: true },
      ...(world.catalog
        ? {
            catalogs: {
              default: Object.fromEntries(
                Object.entries(world.catalog).map(([n, v]) => [n, { specifier: v, version: v }]),
              ),
            },
          }
        : {}),
      importers,
      packages: lockPackages,
      snapshots,
    }),
  );

  for (const pkg of packages) {
    write(
      join(pkg.dir, 'package.json'),
      JSON.stringify({
        name: pkg.name,
        dependencies: pkg.dependencies ?? {},
        devDependencies: pkg.devDependencies ?? {},
        ...(pkg.optionalDependencies ? { optionalDependencies: pkg.optionalDependencies } : {}),
      }),
    );
    write(join(pkg.dir, 'tsconfig.json'), '{}\n');
    if (pkg.metadata !== undefined) write(join(pkg.dir, 'metadata.json'), pkg.metadata);
    for (const [path, content] of Object.entries(pkg.files ?? { 'src/main.ts': 'export {};\n' }))
      write(join(pkg.dir, path), content);
  }
  return root;
}

const UNIT = '@ai-pipeline/wf-example';

const unit = (overrides: Partial<Pkg> = {}): Pkg => ({
  name: UNIT,
  dir: 'workflows/example',
  metadata: JSON.stringify({ version: '1.0.0' }),
  dependencies: { zod: '4.6.5' },
  ...overrides,
});

const digest = (root: string) => sourceDigest(root, UNIT);

/** Asserts the digest of the unit differs (or not) between two worlds. */
function compare(before: string, after: string, changes: boolean, label?: string) {
  if (changes) expect(digest(after), label).not.toBe(digest(before));
  else expect(digest(after), label).toBe(digest(before));
}

describe('sourceDigest', () => {
  it('is stable across calls and starts with the hash algorithm', () => {
    const root = workspace([unit()]);
    const first = digest(root);
    expect(first).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest(root)).toBe(first);
  });

  describe('sources', () => {
    it('changes when the unit’s own source changes', () => {
      compare(
        workspace([unit()]),
        workspace([unit({ files: { 'src/main.ts': 'export const x = 1;\n' } })]),
        true,
      );
    });

    it('changes when a workspace dependency’s source changes', () => {
      const tree = (body: string) =>
        workspace([
          unit({ dependencies: { zod: '4.6.5', '@ai-pipeline/runtime': 'workspace:*' } }),
          {
            name: '@ai-pipeline/runtime',
            dir: 'packages/runtime',
            files: { 'src/serve.ts': body },
          },
        ]);
      compare(tree('export const a = 1;\n'), tree('export const a = 2;\n'), true);
    });

    it('follows workspace optionalDependencies', () => {
      const tree = (body: string) =>
        workspace([
          unit({ optionalDependencies: { '@ai-pipeline/extra': 'workspace:*' } }),
          { name: '@ai-pipeline/extra', dir: 'packages/extra', files: { 'src/a.ts': body } },
        ]);
      compare(tree('export const a = 1;\n'), tree('export const a = 2;\n'), true);
    });

    it('ignores the source of a devDependency, which is test-only wiring', () => {
      // A devDependency is how the replay test reaches another unit; it never enters the image. Only
      // the dependency's *source* varies here — the unit's own manifest is identical in both trees.
      const tree = (body: string) =>
        workspace([
          unit({ devDependencies: { '@ai-pipeline/other': 'workspace:*' } }),
          { name: '@ai-pipeline/other', dir: 'packages/other', files: { 'src/a.ts': body } },
        ]);
      compare(tree('export const a = 1;\n'), tree('export const a = 2;\n'), false);
    });

    it('includes the unit’s own manifest, so declaring a dependency is itself a new artifact', () => {
      compare(
        workspace([unit()]),
        workspace([unit({ dependencies: { zod: '4.6.5', other: '1.0.0' } })]),
        true,
      );
    });

    it('changes when metadata.json changes, since it ships in the image', () => {
      compare(
        workspace([unit()]),
        workspace([unit({ metadata: JSON.stringify({ version: '1.0.1' }) })]),
        true,
      );
    });

    it('changes when a package-root README or LICENSE changes, which pnpm deploy packs', () => {
      const tree = (readme: string) =>
        workspace([unit({ files: { 'src/main.ts': 'export {};\n', 'README.md': readme } })]);
      compare(tree('# one\n'), tree('# two\n'), true);
    });

    it('ignores test code, which never reaches the image', () => {
      compare(
        workspace([unit()]),
        workspace([
          unit({
            files: {
              'src/main.ts': 'export {};\n',
              'src/main.test.ts': 'it("x", () => {});\n',
              'src/testing/stubs.ts': 'export const stub = 1;\n',
            },
          }),
        ]),
        false,
      );
    });

    it('ignores dotfiles', () => {
      const root = workspace([unit()]);
      const before = digest(root);
      writeFileSync(join(root, 'workflows/example/src/.DS_Store'), 'junk');
      expect(digest(root)).toBe(before);
    });

    it('distinguishes moving a file from renaming its content', () => {
      // The path is part of the hash, so the same bytes at a different path is a different artifact.
      compare(
        workspace([unit({ files: { 'src/a.ts': 'export const x = 1;\n' } })]),
        workspace([unit({ files: { 'src/b.ts': 'export const x = 1;\n' } })]),
        true,
      );
    });
  });

  describe('the build recipe', () => {
    it('changes when the shared compiler config changes, though it is only a devDependency', () => {
      const root = workspace([unit()]);
      const before = digest(root);
      writeFileSync(
        join(root, 'packages/typescript-config/base.json'),
        JSON.stringify({ compilerOptions: { strict: true, target: 'ES2021' } }),
      );
      expect(digest(root)).not.toBe(before);
    });

    it('changes with the Dockerfile, .npmrc and patches', () => {
      compare(workspace([unit()]), workspace([unit()], { rootFiles: { '.npmrc': 'x=1\n' } }), true);
      compare(
        workspace([unit()]),
        workspace([unit()], { rootFiles: { 'patches/zod.patch': 'diff\n' } }),
        true,
      );
      const root = workspace([unit()]);
      const before = digest(root);
      writeFileSync(join(root, 'Dockerfile'), 'FROM node:24\n');
      expect(digest(root)).not.toBe(before);
    });

    it('changes when pnpm-workspace.yaml changes outside its catalog', () => {
      const root = workspace([unit()]);
      const before = digest(root);
      writeFileSync(
        join(root, 'pnpm-workspace.yaml'),
        stringify({ packages: GROUPS.map((g) => `${g}/*`), injectWorkspacePackages: true }),
      );
      expect(digest(root)).not.toBe(before);
    });

    it('ignores a catalog entry the unit does not use', () => {
      compare(
        workspace([unit()], { catalog: { zod: '4.6.5' } }),
        workspace([unit()], { catalog: { zod: '4.6.5', '@mastra/core': '1.72.0' } }),
        false,
      );
    });

    describe('the root package.json', () => {
      it('ignores non-lifecycle scripts', () => {
        compare(
          workspace([unit()], { rootScripts: { build: 'turbo run build' } }),
          workspace([unit()], { rootScripts: { build: 'turbo run build', check: 'x' } }),
          false,
        );
      });

      it('changes with an install lifecycle script, which runs in the image build', () => {
        compare(
          workspace([unit()], { rootScripts: {} }),
          workspace([unit()], { rootScripts: { postinstall: 'node setup.js' } }),
          true,
        );
      });

      it('changes with the root turbo version, which runs the image build', () => {
        compare(
          workspace([unit()], { rootDevDependencies: { turbo: '2.11.2' } }),
          workspace([unit()], { rootDevDependencies: { turbo: '2.11.3' } }),
          true,
        );
      });
    });

    describe('turbo.json', () => {
      const BUILD = {
        $schema: 'https://turborepo.dev/schema.json',
        globalPassThroughEnv: ['A'],
        tasks: {
          build: { dependsOn: ['^build', 'codegen'], outputs: ['dist/**'] },
          codegen: {},
          lint: { dependsOn: ['^build'] },
          '//#test:unit': { inputs: ['src/**'] },
        },
        boundaries: { tags: { unit: { dependencies: { deny: ['app'] } } } },
      };
      const withTurbo = (config: unknown) =>
        workspace([unit()], {
          turbo: `// a comment, and a $schema value with // in it\n${JSON.stringify(config, null, 2)}\n`,
        });
      const edit = (fn: (c: typeof BUILD & Record<string, unknown>) => void) => {
        const copy = structuredClone(BUILD) as typeof BUILD & Record<string, unknown>;
        fn(copy);
        return withTurbo(copy);
      };

      it('ignores pass-through env, boundaries, $schema and tasks the build never runs', () => {
        const before = withTurbo(BUILD);
        compare(
          before,
          edit((c) => (c.globalPassThroughEnv = ['A', 'RAG_DATABASE_URL'])),
          false,
        );
        compare(
          before,
          edit((c) => (c.boundaries.tags.unit.dependencies.deny = [])),
          false,
        );
        compare(
          before,
          edit((c) => (c.$schema = 'https://example.com/schema.json')),
          false,
        );
        compare(
          before,
          edit((c) => (c.tasks.lint.dependsOn = [])),
          false,
        );
        compare(
          before,
          edit((c) => (c.tasks['//#test:unit'].inputs = ['x/**'])),
          false,
        );
      });

      it('changes with the build task, a task it depends on, globalEnv or an unknown key', () => {
        const before = withTurbo(BUILD);
        compare(
          before,
          edit((c) => (c.tasks.build.outputs = ['out/**'])),
          true,
          'tasks.build',
        );
        compare(
          before,
          edit((c) => (c.tasks.codegen = { cache: false })),
          true,
          'dependsOn',
        );
        compare(
          before,
          edit((c) => (c.globalEnv = ['CI'])),
          true,
          'globalEnv',
        );
        compare(
          before,
          edit((c) => (c.futureFlags = { x: true })),
          true,
          'unknown key',
        );
      });

      it('changes with a package turbo.json override, but not its boundaries tags', () => {
        const tree = (config: unknown) =>
          workspace([
            unit({
              files: { 'src/main.ts': 'export {};\n', 'turbo.json': JSON.stringify(config) },
            }),
          ]);
        const base = { extends: ['//'], tags: ['unit'] };
        compare(tree(base), tree({ ...base, tags: ['unit', 'rag'] }), false);
        compare(tree(base), tree({ ...base, tasks: { build: { outputs: ['x/**'] } } }), true);
      });

      it('refuses a turbo.json that is not valid JSONC', () => {
        expect(() => digest(workspace([unit()], { turbo: '{ "tasks": ' }))).toThrow(/JSONC/);
      });
    });
  });

  describe('the lockfile', () => {
    it('changes when an external resolution in the closure moves', () => {
      compare(workspace([unit()]), workspace([unit({ dependencies: { zod: '4.6.6' } })]), true);
    });

    it('changes when a transitive resolution or a peer resolution moves', () => {
      const tree = (dep: string, peer: string) =>
        workspace([unit({ dependencies: { ai: `7.0.109(zod@${peer})` } })], {
          graph: { [`ai@7.0.109(zod@${peer})`]: { '@ai-sdk/provider': dep } },
        });
      compare(tree('4.0.17', '4.6.5'), tree('4.0.18', '4.6.5'), true, 'transitive');
      compare(tree('4.0.17', '4.6.5'), tree('4.0.17', '4.6.6'), true, 'peer');
    });

    it('follows the unit’s external devDependencies and optionalDependencies', () => {
      compare(
        workspace([unit({ devDependencies: { typescript: '5.9.3' } })]),
        workspace([unit({ devDependencies: { typescript: '5.9.4' } })]),
        true,
        'dev',
      );
      compare(
        workspace([unit({ optionalDependencies: { fsevents: '2.3.3' } })]),
        workspace([unit({ optionalDependencies: { fsevents: '2.3.4' } })]),
        true,
        'optional',
      );
    });

    it('is unchanged by another package and the external packages only it resolves to', () => {
      // What adding a unit does to the lockfile: a new importer, plus new `packages:` and
      // `snapshots:` entries. `turbo prune --docker` never puts any of them into this unit's image.
      const other = (deps: Record<string, string>): Pkg => ({
        name: '@ai-pipeline/wf-other',
        dir: 'workflows/other',
        metadata: '{}',
        dependencies: deps,
      });
      compare(
        workspace([unit(), other({ zod: '4.6.5' })]),
        workspace([unit(), other({ zod: '4.6.5', '@mastra/core': '1.72.0', pg: '8.23.0' })], {
          graph: { '@mastra/core@1.72.0': { zod: '4.6.5', 'p-map': '7.0.3' } },
        }),
        false,
      );
    });

    it('is unchanged by a whole unrelated package being added to the workspace', () => {
      // The property that makes units independently deployable, asserted end to end.
      compare(
        workspace([unit()]),
        workspace([
          unit(),
          {
            name: '@ai-pipeline/wf-unrelated',
            dir: 'workflows/unrelated',
            metadata: '{}',
            dependencies: { '@mastra/rag': '2.6.5' },
          },
        ]),
        false,
      );
    });

    it('refuses to hash a lockfile it does not fully understand', () => {
      const root = workspace([unit()]);
      writeFileSync(join(root, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '6.0' }));
      expect(() => digest(root)).toThrow(/lockfileVersion/);
      rmSync(join(root, 'pnpm-lock.yaml'));
      expect(() => digest(root)).toThrow(/pnpm-lock.yaml is missing/);
    });
  });
});
