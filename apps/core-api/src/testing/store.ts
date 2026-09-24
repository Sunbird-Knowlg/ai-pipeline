import type { Dependency } from '@ai-pipeline/metadata/metadata';
import type { Definition, UpsertDefinition } from '../store/definitions.js';
import type { Deployment, UpsertDeployment } from '../store/deployments.js';
import type { Repositories, Store } from '../store/store.js';
import type { Observation, TriggerRecord } from '../store/triggers.js';

/**
 * An in-memory `Store`.
 *
 * Domain tests run against this rather than per-method mocks, so they exercise the real rules —
 * including the ones that live in the queries, such as "current means the routed version, else the
 * most recently registered". A mock returning whatever the test expects would prove nothing.
 */
export interface Seed {
  definitions: Definition[];
  deployments: Deployment[];
  /** Keyed `name@version`. */
  dependencies: Map<string, Dependency[]>;
  triggers: TriggerRecord[];
}

export interface FakeStore extends Store {
  seed: Seed;
  /** Keys passed to `withLock`, in order — the serialisation guarantees are worth asserting. */
  locks: string[];
  /** How many lock sections are open at once; a nested one would mean a second real connection. */
  maxNestedLocks: number;
}

export function fakeStore(seed: Partial<Seed> = {}): FakeStore {
  const state: Seed = {
    definitions: seed.definitions ?? [],
    deployments: seed.deployments ?? [],
    dependencies: seed.dependencies ?? new Map<string, Dependency[]>(),
    triggers: seed.triggers ?? [],
  };
  const locks: string[] = [];

  const repositories: Repositories = {
    definitions: {
      find: async (name, version) =>
        state.definitions.find((d) => d.name === name && d.version === version),

      current: async (name) => currentOf(state, name),

      listCurrent: async (kind) => {
        const names = [...new Set(state.definitions.map((d) => d.name))].sort();
        return names
          .map((name) => currentOf(state, name))
          .filter((d): d is Definition => d !== undefined && (!kind || d.kind === kind));
      },

      versions: async (name) =>
        state.definitions
          .filter((d) => d.name === name)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
          .map((d) => ({
            version: d.version,
            contractHash: d.contractHash,
            registeredAt: d.updatedAt,
          })),

      namesUsingRestateName: async (restateName, except) => [
        ...new Set(
          state.definitions
            .filter((d) => d.restateName === restateName && d.name !== except)
            .map((d) => d.name),
        ),
      ],

      // Newest first, the same anchor the SQL picks.
      identity: async (name) => {
        const [latest] = state.definitions
          .filter((d) => d.name === name)
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        return latest && { restateName: latest.restateName, kind: latest.kind };
      },

      upsert: async (definition: UpsertDefinition) => {
        const at = new Date();
        const index = state.definitions.findIndex(
          (d) => d.name === definition.name && d.version === definition.version,
        );
        const record: Definition = { ...definition, createdAt: at, updatedAt: at };
        if (index === -1) state.definitions.push(record);
        else
          state.definitions[index] = { ...record, createdAt: state.definitions[index]!.createdAt };
      },
    },

    deployments: {
      list: async (name) =>
        state.deployments
          .filter((d) => !name || d.name === name)
          .sort((a, b) => b.registeredAt.getTime() - a.registeredAt.getTime()),

      find: async (deploymentId) => state.deployments.find((d) => d.deploymentId === deploymentId),

      artifactsOfVersion: async (name, version) => [
        ...new Set(
          state.deployments
            .filter(
              (d) =>
                d.name === name &&
                d.version === version &&
                (d.mode === 'immutable' || d.status !== 'retired'),
            )
            .map((d) => d.artifactDigest),
        ),
      ],

      upsert: async (deployment: UpsertDeployment) => {
        const existing = state.deployments.find((d) => d.deploymentId === deployment.deploymentId);
        if (existing) {
          Object.assign(existing, deployment, {
            status: existing.status === 'retired' ? 'draining' : existing.status,
          });
          delete existing.drainedAt;
          return;
        }
        state.deployments.push({ ...deployment, status: 'draining', registeredAt: new Date() });
      },

      setActive: async (name, deploymentId) => {
        const live = state.deployments.filter((d) => d.name === name && d.status !== 'retired');
        if (!live.some((d) => d.deploymentId === deploymentId)) return false;
        for (const deployment of live)
          deployment.status = deployment.deploymentId === deploymentId ? 'active' : 'draining';
        return true;
      },

      retire: async (deploymentId) => {
        const deployment = state.deployments.find((d) => d.deploymentId === deploymentId);
        if (deployment) {
          deployment.status = 'retired';
          deployment.drainedAt = new Date();
        }
      },
    },

    dependencies: {
      list: async (name, version) => state.dependencies.get(`${name}@${version}`) ?? [],
      replace: async (name, version, dependencies) => {
        state.dependencies.set(`${name}@${version}`, [...dependencies]);
      },
    },

    triggers: {
      list: async (name) =>
        state.triggers
          .filter((t) => t.name === name)
          .sort((a, b) => a.triggerId.localeCompare(b.triggerId)),

      sync: async (name, triggers) => {
        const ids = new Set(triggers.map((t) => t.id));
        state.triggers = state.triggers.filter((t) => t.name !== name || ids.has(t.triggerId));
        for (const trigger of triggers) {
          const existing = state.triggers.find(
            (t) => t.name === name && t.triggerId === trigger.id,
          );
          if (existing) {
            existing.type = trigger.type;
            existing.definition = trigger;
            existing.updatedAt = new Date();
          } else
            state.triggers.push({
              name,
              triggerId: trigger.id,
              type: trigger.type,
              definition: trigger,
              desiredEnabled: true,
              observedStatus: 'pending',
              updatedAt: new Date(),
            });
        }
      },

      setDesired: async (name, triggerId, enabled) => {
        const trigger = state.triggers.find((t) => t.name === name && t.triggerId === triggerId);
        if (!trigger) return false;
        trigger.desiredEnabled = enabled;
        return true;
      },

      setObserved: async (name, triggerId, observation: Observation) => {
        const trigger = state.triggers.find((t) => t.name === name && t.triggerId === triggerId);
        if (!trigger) return;
        trigger.observedStatus = observation.status;
        if (observation.subscriptionId) trigger.subscriptionId = observation.subscriptionId;
        else delete trigger.subscriptionId;
        if (observation.error) trigger.lastError = observation.error;
        else delete trigger.lastError;
      },
    },
  };

  let open = 0;
  // One promise chain per key, so the fake really does serialise — the way one session holding the
  // advisory locks does. A fake that merely recorded the key would let a test assert serialisation
  // it never had.
  const chains = new Map<string, Promise<unknown>>();

  const fake: FakeStore = {
    ...repositories,
    seed: state,
    locks,
    maxNestedLocks: 0,
    // No rollback: the tests that care about atomicity assert on the resulting state instead.
    transaction: (fn) => fn(repositories),
    withLock: (keys, fn) => {
      const ordered = [...new Set(keys)].sort();
      const waitFor = Promise.all(ordered.map((key) => chains.get(key) ?? Promise.resolve()));
      const section = waitFor.then(async () => {
        locks.push(...keys);
        open += 1;
        fake.maxNestedLocks = Math.max(fake.maxNestedLocks, open);
        try {
          return await fn({ ...repositories, transaction: (inner) => inner(repositories) });
        } finally {
          open -= 1;
        }
      });
      const settled = section.then(
        () => undefined,
        () => undefined,
      );
      for (const key of ordered) chains.set(key, settled);
      return section;
    },
    reachable: async () => true,
  };
  return fake;
}

/** The "current definition" rule, implemented the same way the SQL does. */
function currentOf(state: Seed, name: string): Definition | undefined {
  const candidates = state.definitions.filter((d) => d.name === name);
  const activeVersion = state.deployments.find(
    (d) => d.name === name && d.status === 'active',
  )?.version;
  return (
    candidates.find((d) => d.version === activeVersion) ??
    [...candidates].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0]
  );
}
