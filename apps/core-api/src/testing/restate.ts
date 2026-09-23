import { createLogger, type Logger } from '@ai-pipeline/observability/logger';
import { parseMetadata, type Metadata } from '@ai-pipeline/metadata/metadata';
import type { ControlPlane } from '../domain/deps.js';
import type { RestateAdminPort, Subscription } from '../restate/admin.js';
import type { IngressPort, Submission } from '../restate/ingress.js';
import type { Definition } from '../store/definitions.js';
import type { Deployment } from '../store/deployments.js';
import type { TriggerRecord } from '../store/triggers.js';
import { fakeStore, type FakeStore, type Seed } from './store.js';

/** A Restate admin API that answers from memory and records what it was asked to change. */
export interface FakeAdmin extends RestateAdminPort {
  subscriptions: Subscription[];
  /** `restateName` → the deployment Restate routes to. */
  routing: Map<string, string>;
  /** Endpoints `dryRunDeployment`/`registerDeployment` report as served. */
  served: Map<string, string[]>;
  rows: Record<string, unknown>[];
  deleted: string[];
  clusters: string[];
  /** How many times each method was called — the read paths' round-trip counts are worth asserting. */
  calls: Record<string, number>;
  /** Set to make the next `createSubscription` throw. */
  failCreate?: string;
}

export function fakeAdmin(overrides: Partial<FakeAdmin> = {}): FakeAdmin {
  let nextId = 1;
  const admin: FakeAdmin = {
    subscriptions: [],
    routing: new Map(),
    served: new Map(),
    rows: [],
    deleted: [],
    clusters: [],
    calls: {},

    health: async () => true,

    ensureKafkaCluster: async (name) => {
      admin.clusters.push(name);
    },

    dryRunDeployment: async (uri) => ({
      id: `dp_dry${String(nextId)}`,
      services: (admin.served.get(uri) ?? []).map((name) => ({ name })),
    }),

    registerDeployment: async (uri) => {
      const id = `dp_${String(nextId++)}`;
      return { id, services: (admin.served.get(uri) ?? []).map((name) => ({ name })) };
    },

    deleteDeployment: async (id) => {
      admin.deleted.push(id);
    },

    serviceExists: async (name) => admin.routing.has(name),

    service: async (name) => {
      const deploymentId = admin.routing.get(name);
      return deploymentId === undefined ? undefined : { deployment_id: deploymentId, revision: 1 };
    },

    listSubscriptions: async () => {
      admin.calls.listSubscriptions = (admin.calls.listSubscriptions ?? 0) + 1;
      return [...admin.subscriptions];
    },

    createSubscription: async (source, sink, options) => {
      if (admin.failCreate) throw new Error(admin.failCreate);
      const subscription = { id: `sub_${String(nextId++)}`, source, sink, options };
      admin.subscriptions.push(subscription);
      return subscription;
    },

    deleteSubscription: async (id) => {
      admin.subscriptions = admin.subscriptions.filter((s) => s.id !== id);
    },

    query: async <T>() => {
      admin.calls.query = (admin.calls.query ?? 0) + 1;
      return admin.rows as T[];
    },

    cancelInvocation: async () => 'requested',

    killInvocation: async () => 'requested',

    resumeInvocation: async () => 'requested',

    ...overrides,
  };
  return admin;
}

export interface FakeIngress extends IngressPort {
  submissions: { restateName: string; runId: string; request: unknown }[];
  output: unknown;
}

export function fakeIngress(overrides: Partial<FakeIngress> = {}): FakeIngress {
  const ingress: FakeIngress = {
    submissions: [],
    output: undefined,
    submitWorkflow: async (restateName, runId, request): Promise<Submission> => {
      ingress.submissions.push({ restateName, runId, request });
      return { invocationId: `inv_${String(ingress.submissions.length)}`, status: 'Accepted' };
    },
    workflowOutput: async () => ingress.output,
    ...overrides,
  };
  return ingress;
}

export const silentLogger = (): Logger => createLogger('test').child({}, { level: 'silent' });

/** A `ControlPlane` wired entirely from fakes. */
export function fakeControlPlane(
  parts: { seed?: Partial<Seed>; admin?: Partial<FakeAdmin>; ingress?: Partial<FakeIngress> } = {},
): ControlPlane & { store: FakeStore; admin: FakeAdmin; ingress: FakeIngress } {
  return {
    store: fakeStore(parts.seed),
    admin: fakeAdmin(parts.admin),
    ingress: fakeIngress(parts.ingress),
    kafka: { cluster: 'local', bootstrapServers: 'kafka:9092' },
    log: silentLogger(),
  };
}

// ── record builders ───────────────────────────────────────────────────────────

const BASE_METADATA = {
  apiVersion: 'ai-pipeline/v1alpha1',
  kind: 'workflow',
  name: 'content-enrichment',
  restateName: 'ContentEnrichment',
  version: '1.0.0',
};

export function metadataOf(overrides: Record<string, unknown> = {}): Metadata {
  return parseMetadata({ ...BASE_METADATA, ...overrides });
}

export function definitionOf(overrides: Partial<Definition> = {}): Definition {
  const metadata = overrides.metadata ?? metadataOf();
  const at = overrides.updatedAt ?? new Date('2026-01-01T00:00:00.000Z');
  return {
    name: metadata.name,
    version: metadata.version,
    kind: metadata.kind,
    restateName: metadata.restateName,
    visibility: metadata.visibility,
    description: metadata.description,
    metadata,
    schemas: {
      input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      output: { type: 'object' },
      config: { type: 'object' },
    },
    contractHash: `sha256:${'a'.repeat(64)}`,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}

export function deploymentOf(overrides: Partial<Deployment> = {}): Deployment {
  return {
    deploymentId: 'dp_1',
    name: 'content-enrichment',
    version: '1.0.0',
    endpoint: 'http://content-enrichment-abc:9080',
    artifactDigest: `sha256:${'b'.repeat(64)}`,
    mode: 'immutable',
    status: 'active',
    registeredAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

export function triggerOf(overrides: Partial<TriggerRecord> = {}): TriggerRecord {
  return {
    name: 'content-enrichment',
    triggerId: 'api',
    type: 'rest',
    definition: { id: 'api', type: 'rest' },
    desiredEnabled: true,
    observedStatus: 'active',
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}
