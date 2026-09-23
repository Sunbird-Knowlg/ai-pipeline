import type { UnitKind } from '@ai-pipeline/api-contract/params';
import type { Dependency } from '@ai-pipeline/metadata/metadata';
import type { Queryable } from './db.js';

/** What a unit version declares it calls. Recorded per version, so history stays truthful. */
export interface DependencyStore {
  list(name: string, version: string): Promise<Dependency[]>;
  replace(name: string, version: string, dependencies: Dependency[]): Promise<void>;
}

export function dependencyStore(db: Queryable): DependencyStore {
  return {
    async list(name, version) {
      const { rows } = await db.query<{ dependency_name: string; dependency_kind: UnitKind }>(
        'SELECT dependency_name, dependency_kind FROM workflow_dependencies WHERE name = $1 AND version = $2 ORDER BY 1',
        [name, version],
      );
      return rows.map((r) => ({ name: r.dependency_name, kind: r.dependency_kind }));
    },

    async replace(name, version, dependencies) {
      await db.query('DELETE FROM workflow_dependencies WHERE name = $1 AND version = $2', [
        name,
        version,
      ]);
      for (const dependency of dependencies)
        await db.query(
          'INSERT INTO workflow_dependencies (name, version, dependency_name, dependency_kind) VALUES ($1,$2,$3,$4)',
          [name, version, dependency.name, dependency.kind],
        );
    },
  };
}
