import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { contracts } from '@ai-pipeline/contracts/registry';
import { contractHash, contractSchemas } from '@ai-pipeline/contracts/schemas';
import { describe, expect, it } from 'vitest';
import { discoverUnits, findUnit } from './units.js';
import { workspaceGroups, workspacePackages } from './workspace.js';

/**
 * These run against the real repository rather than a fixture, on purpose: they check that this
 * repository's units and contracts agree. Until now that agreement was only checked at deploy time,
 * against a running control plane — so a mismatch showed up as a failed deploy instead of a failed
 * build.
 */
const ROOT = process.cwd().replace(/\/apps\/cli$/, '');

describe('workspace', () => {
  it('reads the package groups from pnpm-workspace.yaml', () => {
    expect(workspaceGroups(ROOT)).toEqual(
      expect.arrayContaining(['packages', 'services', 'workflows', 'apps', 'tests/fixtures']),
    );
  });

  it('finds every workspace package by name', () => {
    const packages = workspacePackages(ROOT);
    expect(packages.get('@ai-pipeline/contracts')).toBe(join(ROOT, 'packages/contracts'));
    expect(packages.get('@ai-pipeline/core-api')).toBe(join(ROOT, 'apps/core-api'));
    // Nothing declared in pnpm-workspace.yaml should be missing from the map.
    expect(packages.size).toBeGreaterThanOrEqual(12);
  });
});

describe('discoverUnits', () => {
  const units = discoverUnits(ROOT);

  it('finds the deployable units and nothing else', () => {
    expect(units.map((u) => u.metadata.name).sort()).toEqual([
      'content-enrichment',
      'summary',
      'versioned-sleeper',
    ]);
  });

  it('requires both a metadata.json and a served entry point', () => {
    for (const unit of units) {
      expect(existsSync(join(unit.dir, 'metadata.json')), unit.dir).toBe(true);
      expect(existsSync(join(unit.dir, 'src/main.ts')), unit.dir).toBe(true);
    }
  });

  it('names the units it knows when asked for one it does not', () => {
    expect(() => findUnit(ROOT, 'nope')).toThrow(/known units: .*content-enrichment/);
  });
});

describe('units and contracts agree', () => {
  const units = discoverUnits(ROOT);

  it.each(units.map((u) => [u.metadata.name, u] as const))(
    '%s has a contract whose Restate name matches its metadata',
    (_name, unit) => {
      // A unit either uses a shared contract or ships its own in `dist/contract.js`; the latter is
      // built output, so only the shared half can be checked without a build.
      const shared = contracts[unit.metadata.name];
      if (!shared) {
        expect(
          existsSync(join(unit.dir, 'src/contract.ts')),
          `${unit.metadata.name} has neither a shared contract nor a unit-local one`,
        ).toBe(true);
        return;
      }
      expect(shared.restateName).toBe(unit.metadata.restateName);
      expect(shared.handler).toBe(unit.metadata.kind === 'workflow' ? 'run' : shared.handler);
    },
  );

  it.each(Object.keys(contracts))('%s generates a stable contract hash', (name) => {
    const schemas = contractSchemas(contracts[name]!);
    expect(contractHash(schemas)).toMatch(/^sha256:[0-9a-f]{64}$/);
    // The hash is what the version rule compares, so it must not depend on key order.
    expect(contractHash(structuredClone(schemas))).toBe(contractHash(schemas));
  });

  it('every unit declares a config that its contract accepts', () => {
    for (const unit of units) {
      const contract = contracts[unit.metadata.name];
      if (!contract) continue;
      const parsed = contract.config.safeParse(unit.metadata.config);
      expect(parsed.success, `${unit.metadata.name}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it('every unit dependency names another unit in the workspace', () => {
    const names = new Set(units.map((u) => u.metadata.name));
    for (const unit of units)
      for (const dependency of unit.metadata.dependencies)
        expect(names, `${unit.metadata.name} → ${dependency.name}`).toContain(dependency.name);
  });
});
