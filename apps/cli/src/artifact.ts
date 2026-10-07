import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { canonicalJson } from '@ai-pipeline/contracts/schemas';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { parse as parseYaml } from 'yaml';
import { lockfileClosure } from './lockfile.js';
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
 * code. It is a *dev*Dependency, and the closure follows runtime dependencies only, so it would
 * otherwise escape the digest entirely.
 */
function compilerConfig(root: string): string[] {
  const dir = join(root, 'packages/typescript-config');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => join(dir, entry));
}

/** Files `pnpm deploy` packs from a package root whatever its `files` field says. */
const ALWAYS_PACKED = /^(readme|licen[cs]e|changelog)(\..*)?$/i;

function alwaysPacked(dir: string): string[] {
  return readdirSync(dir)
    .filter((entry) => ALWAYS_PACKED.test(entry))
    .map((entry) => join(dir, entry))
    .filter((path) => lstatSync(path).isFile());
}

/**
 * A unit and every workspace package it needs at run time, by name → directory.
 *
 * `dependencies` and `optionalDependencies` are followed; a devDependency is test-only wiring (it is
 * how a replay test reaches another unit) and never enters the image.
 */
export function workspaceClosure(root: string, packageName: string): Map<string, string> {
  const packages = workspacePackages(root);
  const closure = new Map<string, string>();
  const queue = [packageName];
  while (queue.length) {
    const name = queue.pop()!;
    if (closure.has(name)) continue;
    const dir = packages.get(name);
    if (!dir)
      throw new Error(
        `"${name}" is not a package in this workspace; check pnpm-workspace.yaml covers its directory`,
      );
    closure.set(name, dir);
    const manifest = readManifest(join(dir, 'package.json'));
    for (const deps of [manifest.dependencies, manifest.optionalDependencies])
      for (const [dep, range] of Object.entries(deps))
        if (range.startsWith('workspace:') && packages.has(dep)) queue.push(dep);
  }
  return closure;
}

/** Root scripts pnpm runs during `pnpm install` in the image build. Every other one is tooling. */
const INSTALL_LIFECYCLE = new Set([
  'pnpm:devPreinstall',
  'preinstall',
  'install',
  'postinstall',
  'preprepare',
  'prepare',
  'postprepare',
  'prepublish',
]);

/**
 * The root `package.json` as the image build reads it: everything but non-lifecycle scripts.
 * Its devDependencies stay — the repo-local turbo they pin is the one that runs `turbo run build`.
 */
function rootManifest(path: string): string {
  const manifest = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const scripts = manifest.scripts as Record<string, unknown> | undefined;
  if (scripts)
    manifest.scripts = Object.fromEntries(
      Object.entries(scripts).filter(([name]) => INSTALL_LIFECYCLE.has(name)),
    );
  return canonicalJson(manifest);
}

/**
 * `pnpm-workspace.yaml` minus its catalogs. A catalog entry only matters through the versions it
 * resolves to, and those are in the unit's lockfile closure — so adding a catalog entry another
 * package uses does not change this unit's artifact.
 */
function workspaceManifest(path: string): string {
  const workspace = (parseYaml(readFileSync(path, 'utf8')) ?? {}) as Record<string, unknown>;
  delete workspace.catalog;
  delete workspace.catalogs;
  return canonicalJson(workspace);
}

type TaskConfig = { dependsOn?: unknown };

/**
 * The tasks `turbo run build` can execute: `build`, any `<package>#build`, and everything they
 * transitively depend on. Root tasks (`//#…`), lint and typecheck never run in an image build.
 */
function buildTasks(tasks: Record<string, TaskConfig>): Set<string> {
  const keep = new Set<string>();
  const queue = Object.keys(tasks).filter((key) => key === 'build' || key.endsWith('#build'));
  while (queue.length) {
    const key = queue.pop()!;
    if (keep.has(key)) continue;
    keep.add(key);
    const dependsOn = tasks[key]?.dependsOn;
    for (const dep of Array.isArray(dependsOn) ? dependsOn : []) {
      if (typeof dep !== 'string') continue;
      const task = dep.replace(/^\^/, '');
      const bare = task.includes('#') ? task.slice(task.lastIndexOf('#') + 1) : task;
      for (const candidate of [task, bare]) if (tasks[candidate]) queue.push(candidate);
    }
  }
  return keep;
}

/**
 * A `turbo.json` as the image build reads it, parsed as JSONC (it carries comments, and its
 * `$schema` value contains `//`).
 *
 * This is a denylist, not an allowlist: anything not known to be irrelevant stays hashed, so a
 * future key that does affect the build cannot silently fall out of the digest.
 *
 * - root: `$schema`, `globalPassThroughEnv` (pass-through env changes no build output, as the file
 *   itself says), `boundaries`, and tasks outside the build closure are dropped;
 * - package: `$schema` and `tags` (which only feed `turbo boundaries`) are dropped.
 */
function turboConfig(path: string, scope: 'root' | 'package'): string {
  const errors: ParseError[] = [];
  const config = parseJsonc(readFileSync(path, 'utf8'), errors, {
    allowTrailingComma: true,
  }) as Record<string, unknown> | undefined;
  if (errors.length > 0 || !config || typeof config !== 'object')
    throw new Error(
      `${path} is not valid JSONC: ${errors.map((e) => printParseErrorCode(e.error)).join(', ') || 'not an object'}`,
    );
  delete config.$schema;
  if (scope === 'package') {
    delete config.tags;
    return canonicalJson(config);
  }
  delete config.globalPassThroughEnv;
  delete config.boundaries;
  const tasks = config.tasks as Record<string, TaskConfig> | undefined;
  if (tasks) {
    const keep = buildTasks(tasks);
    config.tasks = Object.fromEntries(Object.entries(tasks).filter(([key]) => keep.has(key)));
  }
  return canonicalJson(config);
}

/** Workspace-relative and `/`-separated, the way the lockfile and the hash spell paths. */
const posix = (root: string, path: string) => relative(root, path).split(sep).join('/');

/**
 * Deterministic artifact identity: sha256 over everything that can reach the unit's image —
 * the build recipe, the unit's slice of the lockfile, and the sources of the unit and its workspace
 * dependencies. (Docker image ids are not reproducible across rebuilds, so they can't identify an
 * artifact.)
 *
 * Two properties are pinned by `artifact.test.ts`:
 *
 * - **invariant 5** — if the image can change, the digest changes. Files are hashed whole unless
 *   the build provably ignores part of them; a lockfile the walk does not understand throws.
 * - **invariant 17** — adding, changing or removing one unit does not change another's digest.
 *   That is why the lockfile, `pnpm-workspace.yaml`, the root `package.json` and `turbo.json` are
 *   reduced to what the Dockerfile's `pnpm install --frozen-lockfile`, `turbo run build` and
 *   `pnpm deploy --prod` read for *this* unit.
 */
export function sourceDigest(root: string, packageName: string): string {
  const closure = workspaceClosure(root, packageName);
  const entries: [path: string, content: string | Buffer][] = [];
  const raw = (path: string) => entries.push([posix(root, path), readFileSync(path)]);
  const derived = (path: string, content: string) => entries.push([posix(root, path), content]);
  const at = (path: string) => join(root, path);

  // The build recipe, hashed as is.
  for (const file of ['Dockerfile', '.dockerignore', '.npmrc', '.pnpmfile.cjs'])
    if (existsSync(at(file))) raw(at(file));
  for (const file of files(at('patches'))) raw(file);
  for (const file of compilerConfig(root)) raw(file);

  // Shared configuration, hashed as far as the image build reads it.
  if (existsSync(at('package.json'))) derived(at('package.json'), rootManifest(at('package.json')));
  if (existsSync(at('pnpm-workspace.yaml')))
    derived(at('pnpm-workspace.yaml'), workspaceManifest(at('pnpm-workspace.yaml')));
  if (existsSync(at('turbo.json')))
    derived(at('turbo.json'), turboConfig(at('turbo.json'), 'root'));

  for (const dir of [...closure.values()].sort()) {
    raw(join(dir, 'package.json'));
    raw(join(dir, 'tsconfig.json'));
    for (const optional of ['tsconfig.build.json', 'metadata.json'])
      if (existsSync(join(dir, optional))) raw(join(dir, optional));
    if (existsSync(join(dir, 'turbo.json')))
      derived(join(dir, 'turbo.json'), turboConfig(join(dir, 'turbo.json'), 'package'));
    for (const file of alwaysPacked(dir)) raw(file);
    for (const file of files(join(dir, 'src')).filter(ships)) raw(file);
  }

  const lockfile = at('pnpm-lock.yaml');
  if (!existsSync(lockfile))
    throw new Error('pnpm-lock.yaml is missing; the image build installs with --frozen-lockfile');
  const importerDirs = [...closure.values()].map((dir) => posix(root, dir));
  derived(
    lockfile,
    canonicalJson(lockfileClosure(parseYaml(readFileSync(lockfile, 'utf8')), importerDirs)),
  );

  const hash = createHash('sha256');
  for (const [path, content] of entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    hash.update(path).update('\0').update(content).update('\0');
  return `sha256:${hash.digest('hex')}`;
}
