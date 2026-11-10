import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMetadata, type Metadata } from '@ai-pipeline/metadata/metadata';
import { readManifest } from './manifest.js';
import { workspaceGroups, workspacePackages } from './workspace.js';

export interface Unit {
  dir: string;
  packageName: string;
  metadata: Metadata;
}

/**
 * Every deployable unit in the monorepo.
 *
 * A unit is recognised by what it *is* rather than where it sits: a workspace package that carries a
 * `metadata.json` and serves handlers from `src/main.ts`. So a new group of units needs no change
 * here beyond `pnpm-workspace.yaml`.
 */
/** A unit whose `metadata.json` does not parse. Its own deploy must fail; nobody else's should. */
export interface BrokenUnit {
  dir: string;
  error: string;
}

export interface Discovered {
  units: Unit[];
  broken: BrokenUnit[];
}

/**
 * Every deployable unit in the monorepo.
 *
 * A unit is recognised by what it *is* rather than where it sits: a workspace package that carries a
 * `metadata.json` and serves handlers from `src/main.ts`. So a new group of units needs no change
 * here beyond `pnpm-workspace.yaml`.
 *
 * A unit whose metadata does not parse is collected rather than thrown, because this walks *all* of
 * them: one malformed file used to make `pipeline deploy <any other unit>` fail, which is the
 * opposite of the independence the artifact rules are designed around.
 */
export function discoverUnits(root: string): Discovered {
  const units: Unit[] = [];
  const broken: BrokenUnit[] = [];
  for (const dir of [...workspacePackages(root).values()].sort()) {
    if (!existsSync(join(dir, 'metadata.json')) || !existsSync(join(dir, 'src/main.ts'))) continue;
    try {
      units.push({
        dir,
        packageName: readManifest(join(dir, 'package.json')).name,
        metadata: parseMetadata(
          JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as unknown,
        ),
      });
    } catch (error) {
      broken.push({ dir, error: (error as Error).message });
    }
  }
  return { units, broken };
}

/**
 * Every unit's declared name, whether or not it's deployable via this CLI.
 *
 * `discoverUnits` only sees TS units (it needs `package.json`/`src/main.ts` to build and run one),
 * but a unit can depend on one that isn't -- `whisper` is Python. A dependency name just needs to
 * resolve to *something* registered in the catalogue, so this reads `metadata.json` off every
 * workspace-group directory directly, regardless of language.
 */
export function allDeclaredUnitNames(root: string): Set<string> {
  const names = new Set<string>();
  for (const group of workspaceGroups(root)) {
    const base = join(root, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base)) {
      const metadataPath = join(base, entry, 'metadata.json');
      if (!existsSync(metadataPath)) continue;
      try {
        names.add(parseMetadata(JSON.parse(readFileSync(metadataPath, 'utf8')) as unknown).name);
      } catch {
        // Invalid metadata is that unit's own problem (discoverUnits collects it as broken);
        // this is only ever used to ask "does this name exist at all".
      }
    }
  }
  return names;
}

export function findUnit(root: string, name: string): Unit {
  const { units, broken } = discoverUnits(root);
  const unit = units.find((u) => u.metadata.name === name);
  if (unit) return unit;

  // Only now does a broken unit matter, and only if it is plausibly the one being asked for.
  const suspect = broken.find((b) => b.dir.endsWith(`/${name}`));
  if (suspect) throw new Error(`${name} has an invalid metadata.json: ${suspect.error}`);
  const known = units.map((u) => u.metadata.name).join(', ') || '(none)';
  throw new Error(`no deployable unit named "${name}"; known units: ${known}`);
}
