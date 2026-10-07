/**
 * The slice of `pnpm-lock.yaml` (lockfile v9) that can reach one unit's image.
 *
 * `turbo prune --docker` writes a pruned lockfile per image, containing the importers of the pruned
 * workspace packages and the external packages they resolve to. So the artifact digest must react
 * to exactly that subgraph: a resolution another unit gained cannot change this unit's image, and
 * hashing the whole resolution graph used to force a version bump of every unit whenever any of
 * them added a dependency (invariant 17).
 *
 * The walk fails closed. A lockfile it does not fully understand throws instead of hashing less,
 * because hashing less is how an image changes under an unchanged digest (invariant 5).
 */

export class LockfileError extends Error {
  override name = 'LockfileError';
}

/**
 * Top-level sections that apply to every install. They are hashed whole: they rarely change, and
 * when they do, every image may change.
 */
const GLOBAL_SECTIONS = [
  'lockfileVersion',
  'settings',
  'overrides',
  'packageExtensionsChecksum',
  'patchedDependencies',
  'pnpmfileChecksum',
  'ignoredOptionalDependencies',
] as const;

/** Sections hashed only as far as one unit's closure reaches them. */
const SCOPED_SECTIONS = ['importers', 'packages', 'snapshots'] as const;

/**
 * Sections that cannot change an image on their own. A catalog's resolved version shows up in the
 * importers and snapshots that use it, and `time` is publication metadata.
 */
const IGNORED_SECTIONS = ['catalogs', 'time'] as const;

const KNOWN_SECTIONS = new Set<string>([
  ...GLOBAL_SECTIONS,
  ...SCOPED_SECTIONS,
  ...IGNORED_SECTIONS,
]);

/** Importer edges: an importer's declared dependencies of every kind reach its build. */
const IMPORTER_EDGES = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

/** Snapshot edges. `transitivePeerDependencies` lists names only, not resolutions. */
const SNAPSHOT_EDGES = ['dependencies', 'optionalDependencies'] as const;

type Section = Record<string, unknown>;

const isRecord = (value: unknown): value is Section =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The snapshot key a dependency reference points at (pnpm's `refToRelative`).
 *
 * - `link:` is a workspace package, which the digest covers through its sources: `null`.
 * - A reference that already names a package (an alias such as `string-width@4.2.3`, or a scoped
 *   `@scope/name@1.0.0`) is the key itself.
 * - Anything else is a version, possibly with a peer suffix: `<name>@<reference>`.
 */
export function refToRelative(reference: string, name: string): string | null {
  if (reference.startsWith('link:')) return null;
  if (reference.startsWith('@')) return reference;
  const at = reference.indexOf('@');
  if (at === -1) return `${name}@${reference}`;
  const colon = reference.indexOf(':');
  const bracket = reference.indexOf('(');
  if ((colon === -1 || at < colon) && (bracket === -1 || at < bracket)) return reference;
  return `${name}@${reference}`;
}

/**
 * The `packages:` key of a snapshot key: the snapshot minus its trailing parenthesised groups.
 * Groups nest (`vite@8.3.0(@types/node@24.13.5)(yaml@2.9.1)` inside a peer list) and include
 * `(patch_hash=…)`, so this balances parentheses rather than cutting at the first `(`.
 */
export function removeSuffix(depPath: string): string {
  let end = depPath.length;
  while (end > 0 && depPath[end - 1] === ')') {
    let depth = 0;
    let start = end - 1;
    for (; start >= 0; start--) {
      const char = depPath[start];
      if (char === ')') depth++;
      else if (char === '(' && --depth === 0) break;
    }
    if (start < 0) throw new LockfileError(`unbalanced parentheses in "${depPath}"`);
    end = start;
  }
  return depPath.slice(0, end);
}

function section(lock: Section, name: string): Section {
  const value = lock[name] ?? {};
  if (!isRecord(value)) throw new LockfileError(`lockfile section "${name}" is not a mapping`);
  return value;
}

/** The `(name, reference)` pairs of an importer or snapshot, for the given edge kinds. */
function edgesOf(entry: Section, kinds: readonly string[], where: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const kind of kinds) {
    const deps = entry[kind];
    if (deps === undefined) continue;
    if (!isRecord(deps)) throw new LockfileError(`${where}.${kind} is not a mapping`);
    for (const [name, spec] of Object.entries(deps)) {
      // Importers record `{ specifier, version }`; snapshots record the version string directly.
      const reference = isRecord(spec) ? spec.version : spec;
      if (typeof reference !== 'string')
        throw new LockfileError(`${where}.${kind}.${name} has no version string`);
      pairs.push([name, reference]);
    }
  }
  return pairs;
}

/**
 * The canonical, closure-scoped view of a parsed lockfile: the global sections, the importers of
 * the given workspace directories plus the root (`.`, whose devDependencies include the turbo that
 * runs the image build), and every snapshot and package entry they transitively reach.
 *
 * `importerDirs` are workspace-relative, `/`-separated paths, exactly as the lockfile spells them.
 */
export function lockfileClosure(
  lock: unknown,
  importerDirs: readonly string[],
): Record<string, unknown> {
  if (!isRecord(lock)) throw new LockfileError('the lockfile is not a mapping');
  if (lock.lockfileVersion !== '9.0')
    throw new LockfileError(
      `unsupported lockfileVersion ${JSON.stringify(lock.lockfileVersion)}; the artifact digest understands '9.0' only`,
    );
  for (const key of Object.keys(lock))
    if (!KNOWN_SECTIONS.has(key))
      throw new LockfileError(
        `unknown lockfile section "${key}": decide in apps/cli/src/lockfile.ts whether it can reach an image`,
      );

  const importers = section(lock, 'importers');
  const snapshots = section(lock, 'snapshots');
  const packages = section(lock, 'packages');

  const dirs = [...new Set(['.', ...importerDirs])].sort();
  const reached = new Set<string>();
  const queue: { key: string; from: string }[] = [];
  const follow = (pairs: [string, string][], from: string) => {
    for (const [name, reference] of pairs) {
      const key = refToRelative(reference, name);
      if (key !== null) queue.push({ key, from });
    }
  };

  const importerBlocks: Record<string, unknown> = {};
  for (const dir of dirs) {
    const importer = importers[dir];
    if (!isRecord(importer))
      throw new LockfileError(
        `the lockfile has no importer for "${dir}"; run pnpm install so it describes the workspace`,
      );
    importerBlocks[dir] = importer;
    follow(edgesOf(importer, IMPORTER_EDGES, `importers.${dir}`), `importers.${dir}`);
  }

  while (queue.length > 0) {
    const { key, from } = queue.pop()!;
    if (reached.has(key)) continue;
    const snapshot = snapshots[key];
    if (!isRecord(snapshot))
      throw new LockfileError(`${from} references "${key}", which has no snapshot`);
    if (!isRecord(packages[removeSuffix(key)]))
      throw new LockfileError(`snapshot "${key}" has no packages entry "${removeSuffix(key)}"`);
    reached.add(key);
    follow(edgesOf(snapshot, SNAPSHOT_EDGES, `snapshots.${key}`), `snapshots.${key}`);
  }

  const keys = [...reached].sort();
  return {
    global: Object.fromEntries(
      GLOBAL_SECTIONS.filter((name) => lock[name] !== undefined).map((name) => [name, lock[name]]),
    ),
    importers: importerBlocks,
    snapshots: Object.fromEntries(keys.map((key) => [key, snapshots[key]])),
    packages: Object.fromEntries(
      [...new Set(keys.map(removeSuffix))].sort().map((key) => [key, packages[key]]),
    ),
  };
}
