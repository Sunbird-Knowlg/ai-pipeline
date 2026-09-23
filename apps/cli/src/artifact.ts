import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { readManifest } from './manifest.js';
import { workspacePackages } from './workspace.js';

/** Test code is excluded from the image, so it must not change the artifact's identity either. */
const ships = (file: string): boolean =>
  !file.endsWith('.test.ts') && !file.includes(`${sep}testing${sep}`);

/** Regular source files only: dotfiles (.DS_Store, editor swap files) and symlinks never ship. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    if (entry.startsWith('.')) return [];
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isDirectory()) return files(path);
    return stat.isFile() ? [path] : [];
  });
}

/**
 * The shared compiler config (`@ai-pipeline/typescript-config`) is part of the build recipe, like
 * the Dockerfile: every package extends one of its presets, so a change to one changes the emitted
 * code. It is a *dev*Dependency, and the walk below follows `dependencies` only, so it would
 * otherwise escape the digest entirely.
 */
function compilerConfig(root: string): string[] {
  const dir = join(root, 'packages/typescript-config');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry));
}

/**
 * Deterministic artifact identity: sha256 over everything that goes into the unit's image —
 * the build recipe, the lockfile, and the sources of the unit and its workspace dependencies.
 * (Docker image ids are not reproducible across rebuilds, so they can't identify an artifact.)
 */
export function sourceDigest(root: string, packageName: string): string {
  const packages = workspacePackages(root);
  const seen = new Set<string>();
  const queue = [packageName];
  while (queue.length) {
    const name = queue.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const manifest = readManifest(join(packages.get(name)!, 'package.json'));
    for (const [dep, range] of Object.entries(manifest.dependencies))
      if (range.startsWith('workspace:') && packages.has(dep)) queue.push(dep);
  }
  const inputs = [
    'Dockerfile',
    '.dockerignore',
    'turbo.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'package.json',
  ]
    .map((f) => join(root, f))
    .filter((f) => existsSync(f))
    .concat(compilerConfig(root));
  for (const name of [...seen].sort()) {
    const dir = packages.get(name)!;
    inputs.push(join(dir, 'package.json'), join(dir, 'tsconfig.json'));
    if (existsSync(join(dir, 'tsconfig.build.json'))) inputs.push(join(dir, 'tsconfig.build.json'));
    if (existsSync(join(dir, 'metadata.json'))) inputs.push(join(dir, 'metadata.json'));
    if (existsSync(join(dir, 'schema.sql'))) inputs.push(join(dir, 'schema.sql'));
    inputs.push(...files(join(dir, 'src')).filter(ships));
  }
  const hash = createHash('sha256');
  for (const file of inputs.sort()) {
    hash.update(relative(root, file)).update('\0').update(readFileSync(file)).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}
