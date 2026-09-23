import type { ObservedStatus, TriggerType } from '@ai-pipeline/api-contract/triggers';
import type { Trigger } from '@ai-pipeline/metadata/metadata';
import type { Queryable } from './db.js';

/**
 * Trigger state: what an operator asked for (`desiredEnabled`) next to what was last observed in
 * Restate. The two are reconciled, never assumed equal.
 */
export interface TriggerRecord {
  name: string;
  triggerId: string;
  type: TriggerType;
  definition: Trigger;
  desiredEnabled: boolean;
  subscriptionId?: string;
  observedStatus: ObservedStatus;
  lastError?: string;
  updatedAt: Date;
}

interface TriggerRow {
  name: string;
  trigger_id: string;
  type: TriggerType;
  definition: Trigger;
  desired_enabled: boolean;
  subscription_id: string | null;
  observed_status: ObservedStatus;
  last_error: string | null;
  updated_at: Date;
}

const toTrigger = (row: TriggerRow): TriggerRecord => ({
  name: row.name,
  triggerId: row.trigger_id,
  type: row.type,
  definition: row.definition,
  desiredEnabled: row.desired_enabled,
  ...(row.subscription_id ? { subscriptionId: row.subscription_id } : {}),
  observedStatus: row.observed_status,
  ...(row.last_error ? { lastError: row.last_error } : {}),
  updatedAt: row.updated_at,
});

export interface Observation {
  subscriptionId: string | null;
  status: ObservedStatus;
  error: string | null;
}

export interface TriggerStore {
  list(name: string): Promise<TriggerRecord[]>;
  /** Adds new triggers (enabled), refreshes definitions, keeps `desiredEnabled`, drops removed ones. */
  sync(name: string, triggers: Trigger[]): Promise<void>;
  /** Returns false when the trigger does not exist. */
  setDesired(name: string, triggerId: string, enabled: boolean): Promise<boolean>;
  setObserved(name: string, triggerId: string, observation: Observation): Promise<void>;
}

export function triggerStore(db: Queryable): TriggerStore {
  return {
    async list(name) {
      const { rows } = await db.query<TriggerRow>(
        'SELECT * FROM workflow_triggers WHERE name = $1 ORDER BY trigger_id',
        [name],
      );
      return rows.map(toTrigger);
    },

    async sync(name, triggers) {
      await db.query(
        'DELETE FROM workflow_triggers WHERE name = $1 AND NOT (trigger_id = ANY($2::text[]))',
        [name, triggers.map((t) => t.id)],
      );
      for (const trigger of triggers)
        await db.query(
          `INSERT INTO workflow_triggers (name, trigger_id, type, definition)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (name, trigger_id) DO UPDATE SET type = EXCLUDED.type, definition = EXCLUDED.definition, updated_at = now()`,
          [name, trigger.id, trigger.type, trigger],
        );
    },

    async setDesired(name, triggerId, enabled) {
      const { rowCount } = await db.query(
        'UPDATE workflow_triggers SET desired_enabled = $3, updated_at = now() WHERE name = $1 AND trigger_id = $2',
        [name, triggerId, enabled],
      );
      return rowCount === 1;
    },

    async setObserved(name, triggerId, observation) {
      await db.query(
        `UPDATE workflow_triggers SET subscription_id = $3, observed_status = $4, last_error = $5, updated_at = now()
         WHERE name = $1 AND trigger_id = $2`,
        [name, triggerId, observation.subscriptionId, observation.status, observation.error],
      );
    },
  };
}
