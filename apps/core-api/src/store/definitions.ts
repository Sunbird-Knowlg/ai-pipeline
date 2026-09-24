import type { UnitKind } from '@ai-pipeline/api-contract/params';
import type { Metadata } from '@ai-pipeline/metadata/metadata';
import type { Queryable } from './db.js';

/**
 * Catalogued definitions: one row per `(name, version)`. The repository maps rows to this shape, so
 * nothing above `store/` speaks in column names.
 */
export interface Definition {
  name: string;
  version: string;
  kind: UnitKind;
  restateName: string;
  visibility: 'public' | 'private';
  description: string;
  metadata: Metadata;
  /** Draft-07 JSON Schemas generated from the unit's contract by the deploy CLI. */
  schemas: { input: JsonSchema; output: JsonSchema; config: JsonSchema };
  contractHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export type JsonSchema = Record<string, unknown>;

/** One registered version of a unit, for the detail view's history. */
export interface DefinitionVersion {
  version: string;
  contractHash: string;
  registeredAt: Date;
}

interface DefinitionRow {
  name: string;
  version: string;
  kind: UnitKind;
  restate_name: string;
  visibility: 'public' | 'private';
  description: string;
  metadata: Metadata;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
  config_schema: JsonSchema;
  contract_hash: string;
  created_at: Date;
  updated_at: Date;
}

const toDefinition = (row: DefinitionRow): Definition => ({
  name: row.name,
  version: row.version,
  kind: row.kind,
  restateName: row.restate_name,
  visibility: row.visibility,
  description: row.description,
  metadata: row.metadata,
  schemas: { input: row.input_schema, output: row.output_schema, config: row.config_schema },
  contractHash: row.contract_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface DefinitionStore {
  /** One exact version. */
  find(name: string, version: string): Promise<Definition | undefined>;
  /**
   * The current definition of a unit: the version of the deployment Restate routes to (the
   * `active` one), else the most recently registered version. Re-registering an older build does
   * not change it, because it does not change Restate's routing either.
   */
  current(name: string): Promise<Definition | undefined>;
  /** The current definition of every unit, optionally of one kind, by name. */
  listCurrent(kind?: UnitKind): Promise<Definition[]>;
  versions(name: string): Promise<DefinitionVersion[]>;
  /** Other catalogue names already bound to this Restate name (names are global in Restate). */
  namesUsingRestateName(restateName: string, except: string): Promise<string[]>;
  /**
   * The Restate identity this logical unit is already bound to, across every version.
   *
   * Deliberately not `current()`: that is undefined once nothing is active, which is exactly the
   * case where old runs and subscriptions still exist and must stay reachable.
   */
  identity(name: string): Promise<{ restateName: string; kind: UnitKind } | undefined>;
  upsert(definition: UpsertDefinition): Promise<void>;
}

export type UpsertDefinition = Omit<Definition, 'createdAt' | 'updatedAt'>;

export function definitionStore(db: Queryable): DefinitionStore {
  return {
    async find(name, version) {
      const { rows } = await db.query<DefinitionRow>(
        'SELECT * FROM workflow_definitions WHERE name = $1 AND version = $2',
        [name, version],
      );
      return rows[0] && toDefinition(rows[0]);
    },

    async current(name) {
      const { rows } = await db.query<DefinitionRow>(
        `SELECT d.* FROM workflow_definitions d
         LEFT JOIN workflow_deployments x ON x.name = d.name AND x.version = d.version AND x.status = 'active'
         WHERE d.name = $1
         ORDER BY (x.deployment_id IS NOT NULL) DESC, d.updated_at DESC
         LIMIT 1`,
        [name],
      );
      return rows[0] && toDefinition(rows[0]);
    },

    async listCurrent(kind) {
      const { rows } = await db.query<DefinitionRow>(
        `SELECT * FROM (
           SELECT DISTINCT ON (d.name) d.* FROM workflow_definitions d
           LEFT JOIN workflow_deployments x ON x.name = d.name AND x.version = d.version AND x.status = 'active'
           ORDER BY d.name, (x.deployment_id IS NOT NULL) DESC, d.updated_at DESC
         ) current WHERE ($1::text IS NULL OR kind = $1) ORDER BY name`,
        [kind ?? null],
      );
      return rows.map(toDefinition);
    },

    async versions(name) {
      const { rows } = await db.query<
        Pick<DefinitionRow, 'version' | 'contract_hash' | 'updated_at'>
      >(
        'SELECT version, contract_hash, updated_at FROM workflow_definitions WHERE name = $1 ORDER BY updated_at DESC',
        [name],
      );
      return rows.map((row) => ({
        version: row.version,
        contractHash: row.contract_hash,
        registeredAt: row.updated_at,
      }));
    },

    async namesUsingRestateName(restateName, except) {
      const { rows } = await db.query<{ name: string }>(
        'SELECT DISTINCT name FROM workflow_definitions WHERE restate_name = $1 AND name <> $2',
        [restateName, except],
      );
      return rows.map((r) => r.name);
    },

    async identity(name) {
      const { rows } = await db.query<{ restate_name: string; kind: UnitKind }>(
        'SELECT restate_name, kind FROM workflow_definitions WHERE name = $1 ORDER BY updated_at DESC LIMIT 1',
        [name],
      );
      return rows[0] && { restateName: rows[0].restate_name, kind: rows[0].kind };
    },

    async upsert(d) {
      await db.query(
        `INSERT INTO workflow_definitions
           (name, version, kind, restate_name, visibility, description, metadata, input_schema, output_schema, config_schema, contract_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (name, version) DO UPDATE SET
           kind = EXCLUDED.kind, restate_name = EXCLUDED.restate_name, visibility = EXCLUDED.visibility,
           description = EXCLUDED.description, metadata = EXCLUDED.metadata, input_schema = EXCLUDED.input_schema,
           output_schema = EXCLUDED.output_schema, config_schema = EXCLUDED.config_schema,
           contract_hash = EXCLUDED.contract_hash, updated_at = now()`,
        [
          d.name,
          d.version,
          d.kind,
          d.restateName,
          d.visibility,
          d.description,
          d.metadata,
          d.schemas.input,
          d.schemas.output,
          d.schemas.config,
          d.contractHash,
        ],
      );
    },
  };
}
