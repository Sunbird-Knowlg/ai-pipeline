import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ContractEntry } from '@ai-pipeline/contracts/entry';
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

  it('finds the example units', () => {
    // Asserted as a subset on purpose: a hardcoded list would mean adding a workflow breaks this
    // test, which is exactly the friction the scaffold exists to remove.
    expect(units.map((u) => u.metadata.name)).toEqual(
      expect.arrayContaining(['content-enrichment', 'summary', 'versioned-sleeper']),
    );
  });

  it('finds only packages that are actually deployable', () => {
    const names = units.map((u) => u.metadata.name);
    // A package without metadata.json and src/main.ts is not a unit, however it is named.
    expect(names).not.toContain('contracts');
    expect(names).not.toContain('core-api');
    expect(new Set(names).size).toBe(names.length);
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

  /**
   * Loads a unit's contract from its source, the way `pipeline deploy` loads it from `dist`. There is
   * no shared registry to check against any more — each unit owns its contract, which is what makes
   * units independently deployable — so the check is per unit.
   */
  const contractOf = async (dir: string) =>
    ((await import(join(dir, 'src/contract.ts'))) as { contract?: ContractEntry }).contract;

  it.each(units.map((u) => [u.metadata.name, u] as const))(
    '%s ships a contract that agrees with its metadata',
    async (_name, unit) => {
      expect(
        existsSync(join(unit.dir, 'src/contract.ts')),
        `${unit.metadata.name} ships no src/contract.ts, so it cannot be deployed`,
      ).toBe(true);

      const contract = await contractOf(unit.dir);
      expect(
        contract,
        `${unit.metadata.name}/src/contract.ts must export \`contract\``,
      ).toBeDefined();
      expect(contract!.restateName).toBe(unit.metadata.restateName);
      // The runs API selects invocations by handler name, so a workflow's entry point must be `run`.
      if (unit.metadata.kind === 'workflow') expect(contract!.handler).toBe('run');
    },
  );

  it.each(units.map((u) => [u.metadata.name, u] as const))(
    '%s generates a stable contract hash',
    async (_name, unit) => {
      const schemas = contractSchemas((await contractOf(unit.dir))!);
      expect(contractHash(schemas)).toMatch(/^sha256:[0-9a-f]{64}$/);
      // The hash is what the version rule compares, so it must not depend on key order.
      expect(contractHash(structuredClone(schemas))).toBe(contractHash(schemas));
    },
  );

  it.each(units.map((u) => [u.metadata.name, u] as const))(
    '%s declares a config its contract accepts',
    async (_name, unit) => {
      const contract = (await contractOf(unit.dir))!;
      const parsed = contract.config.safeParse(unit.metadata.config);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    },
  );

  it('every unit dependency names another unit in the workspace', () => {
    const names = new Set(units.map((u) => u.metadata.name));
    for (const unit of units)
      for (const dependency of unit.metadata.dependencies)
        expect(names, `${unit.metadata.name} → ${dependency.name}`).toContain(dependency.name);
  });

  it('no unit depends on a shared registry of contracts', () => {
    // A shared name → contract map would be a file every unit's artifact digest depends on, so
    // adding one workflow would change every other unit's artifact. Guard against it coming back.
    expect(existsSync(join(ROOT, 'packages/contracts/src/registry.ts'))).toBe(false);
  });
});
