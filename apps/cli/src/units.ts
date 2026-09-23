import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMetadata, type Metadata } from '@ai-pipeline/metadata/metadata';
import { readManifest } from './manifest.js';
import { workspacePackages } from './workspace.js';

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
export function discoverUnits(root: string): Unit[] {
  const units: Unit[] = [];
  for (const dir of [...workspacePackages(root).values()].sort()) {
    if (!existsSync(join(dir, 'metadata.json')) || !existsSync(join(dir, 'src/main.ts'))) continue;
    units.push({
      dir,
      packageName: readManifest(join(dir, 'package.json')).name,
      metadata: parseMetadata(
        JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as unknown,
      ),
    });
  }
  return units;
}

export function findUnit(root: string, name: string): Unit {
  const units = discoverUnits(root);
  const unit = units.find((u) => u.metadata.name === name);
  if (!unit)
    throw new Error(
      `no deployable unit named "${name}"; known units: ${units.map((u) => u.metadata.name).join(', ') || '(none)'}`,
    );
  return unit;
}
