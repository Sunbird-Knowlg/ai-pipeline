import type { DeploymentMode, DeploymentStatus } from '@ai-pipeline/api-contract/params';
import type { Queryable } from './db.js';

/**
 * Registered deployments. `status` mirrors Restate's routing rather than leading it: the deployment
 * Restate sends new invocations to is `active`, every other live one is only draining.
 */
export interface Deployment {
  deploymentId: string;
  name: string;
  version: string;
  endpoint: string;
  artifactDigest: string;
  mode: DeploymentMode;
  status: DeploymentStatus;
  registeredAt: Date;
  drainedAt?: Date;
}

interface DeploymentRow {
  deployment_id: string;
  name: string;
  version: string;
  endpoint_uri: string;
  artifact_digest: string;
  mode: DeploymentMode;
  status: DeploymentStatus;
  registered_at: Date;
  drained_at: Date | null;
}

const toDeployment = (row: DeploymentRow): Deployment => ({
  deploymentId: row.deployment_id,
  name: row.name,
  version: row.version,
  endpoint: row.endpoint_uri,
  artifactDigest: row.artifact_digest,
  mode: row.mode,
  status: row.status,
  registeredAt: row.registered_at,
  ...(row.drained_at ? { drainedAt: row.drained_at } : {}),
});

export interface DeploymentStore {
  list(name?: string): Promise<Deployment[]>;
  find(deploymentId: string): Promise<Deployment | undefined>;
  /**
   * Artifacts a semantic version is bound to: every immutable deployment (retired ones too — a
   * version never changes its code) plus live dev deployments.
   */
  artifactsOfVersion(name: string, version: string): Promise<string[]>;
  upsert(deployment: UpsertDeployment): Promise<void>;
  /** Marks one deployment active and every other live one draining. False if it is unknown. */
  setActive(name: string, deploymentId: string): Promise<boolean>;
  retire(deploymentId: string): Promise<void>;
}

export type UpsertDeployment = Omit<Deployment, 'status' | 'registeredAt' | 'drainedAt'>;

export function deploymentStore(db: Queryable): DeploymentStore {
  return {
    async list(name) {
      const { rows } = await db.query<DeploymentRow>(
        'SELECT * FROM workflow_deployments WHERE ($1::text IS NULL OR name = $1) ORDER BY registered_at DESC',
        [name ?? null],
      );
      return rows.map(toDeployment);
    },

    async find(deploymentId) {
      const { rows } = await db.query<DeploymentRow>(
        'SELECT * FROM workflow_deployments WHERE deployment_id = $1',
        [deploymentId],
      );
      return rows[0] && toDeployment(rows[0]);
    },

    async artifactsOfVersion(name, version) {
      const { rows } = await db.query<{ artifact_digest: string }>(
        "SELECT DISTINCT artifact_digest FROM workflow_deployments WHERE name = $1 AND version = $2 AND (mode = 'immutable' OR status <> 'retired')",
        [name, version],
      );
      return rows.map((r) => r.artifact_digest);
    },

    async upsert(d) {
      await db.query(
        `INSERT INTO workflow_deployments (deployment_id, name, version, endpoint_uri, artifact_digest, mode, status)
         VALUES ($1,$2,$3,$4,$5,$6,'draining')
         ON CONFLICT (deployment_id) DO UPDATE SET
           name = EXCLUDED.name, version = EXCLUDED.version, endpoint_uri = EXCLUDED.endpoint_uri,
           artifact_digest = EXCLUDED.artifact_digest, mode = EXCLUDED.mode,
           status = CASE WHEN workflow_deployments.status = 'retired' THEN 'draining' ELSE workflow_deployments.status END,
           drained_at = NULL`,
        [d.deploymentId, d.name, d.version, d.endpoint, d.artifactDigest, d.mode],
      );
    },

    async setActive(name, deploymentId) {
      const { rowCount } = await db.query(
        "SELECT 1 FROM workflow_deployments WHERE name = $1 AND deployment_id = $2 AND status <> 'retired'",
        [name, deploymentId],
      );
      if (rowCount !== 1) return false;
      await db.query(
        `UPDATE workflow_deployments
         SET status = CASE WHEN deployment_id = $2 THEN 'active' ELSE 'draining' END
         WHERE name = $1 AND status <> 'retired'`,
        [name, deploymentId],
      );
      return true;
    },

    async retire(deploymentId) {
      await db.query(
        "UPDATE workflow_deployments SET status = 'retired', drained_at = now() WHERE deployment_id = $1",
        [deploymentId],
      );
    },
  };
}
