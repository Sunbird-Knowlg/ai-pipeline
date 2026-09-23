import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readManifest } from './manifest.js';

/**
 * Where the workspace's packages live, read from `pnpm-workspace.yaml`.
 *
 * The list used to be hardcoded in three places (here, unit discovery, and the Vitest config), which
 * is exactly the kind of duplication that goes stale the first time a group is added. pnpm already
 * declares it, so that file is the source.
 */
export function workspaceGroups(root: string): string[] {
  const file = join(root, 'pnpm-workspace.yaml');
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === 'packages:');
  if (start === -1) return [];
  const groups: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const entry = /^\s+-\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line);
    // The `packages:` block ends at the first line that is not a list entry.
    if (!entry) break;
    groups.push(dirname(entry[1]!));
  }
  return groups;
}

/** Every workspace package, by name → its directory. */
export function workspacePackages(root: string): Map<string, string> {
  const byName = new Map<string, string>();
  for (const group of workspaceGroups(root)) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const dir = join(base, entry);
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) byName.set(readManifest(manifest).name, dir);
    }
  }
  return byName;
}
