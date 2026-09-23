import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { defineConfig } from 'vitest/config';

/** The workspace globs, so the package layout is declared in exactly one place. */
function workspaceGroups(): string[] {
  const lines = readFileSync('pnpm-workspace.yaml', 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'packages:');
  const groups: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s+-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    if (!entry) break;
    groups.push(dirname(entry[1]!));
  }
  return groups;
}

/**
 * Maps every `@ai-pipeline/*` entry point to its source file, so tests never run a stale `dist/`.
 *
 * Both halves come from the files that already declare them: the globs from `pnpm-workspace.yaml`
 * and the entry points from each manifest's `exports`, where the `@ai-pipeline/source` condition
 * names the source behind each subpath. Adding a subpath needs no change here.
 *
 * The patterns are anchored regexes: a bare string `find` in Vite also matches everything under
 * `find + '/'`, which would rewrite `@ai-pipeline/runtime/retry` against the root entry point.
 */
function workspaceSourceAliases(): { find: RegExp; replacement: string }[] {
  const aliases: { find: RegExp; replacement: string }[] = [];
  for (const group of workspaceGroups()) {
    if (!existsSync(group)) continue;
    for (const entry of readdirSync(group)) {
      const dir = join(group, entry);
      const manifestPath = join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        name?: string;
        exports?: Record<string, Record<string, string> | string>;
      };
      if (!manifest.name || !manifest.exports) continue;
      for (const [subpath, target] of Object.entries(manifest.exports)) {
        const source = typeof target === 'string' ? undefined : target['@ai-pipeline/source'];
        if (!source) continue;
        const specifier = subpath === '.' ? manifest.name : `${manifest.name}${subpath.slice(1)}`;
        aliases.push({
          find: new RegExp(`^${specifier.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}$`),
          replacement: resolvePath(join(dir, source)),
        });
      }
    }
  }
  return aliases;
}

const resolve = { alias: workspaceSourceAliases() };

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: ['{packages,services,workflows,apps}/*/src/**/*.test.ts'],
          exclude: ['**/*.replay.test.ts', '**/node_modules/**'],
        },
      },
      {
        resolve,
        test: {
          name: 'replay',
          include: ['{packages,services,workflows,apps}/*/src/**/*.replay.test.ts'],
          testTimeout: 120_000,
          hookTimeout: 180_000,
          fileParallelism: false,
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          globalSetup: ['tests/e2e/setup.ts'],
          testTimeout: 600_000,
          hookTimeout: 900_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
