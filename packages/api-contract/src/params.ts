import { z } from 'zod';

/**
 * Path, query and header primitives shared by the routes. They were duplicated as module-level
 * consts in one route file and inlined in another; a single definition keeps the accepted shapes
 * identical everywhere and documents them once.
 */

/** A catalogue name: lower-case kebab, as `metadata.json` requires. */
export const unitName = z.string().regex(/^[a-z][a-z0-9-]{0,62}$/);

/** A run id. Opaque: `api_…`/`kf_…` today, but callers must not parse it. */
export const runId = z.string().regex(/^[A-Za-z0-9_.:-]{1,256}$/);

/** A Restate deployment id. */
export const deploymentId = z.string().regex(/^dp_[A-Za-z0-9]{1,64}$/);

export const idempotencyKey = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\r\n]+$/);

export const unitKind = z.enum(['workflow', 'service']);
export type UnitKind = z.infer<typeof unitKind>;

export const visibility = z.enum(['public', 'private']);

export const deploymentMode = z.enum(['dev', 'immutable']);
export type DeploymentMode = z.infer<typeof deploymentMode>;

export const deploymentStatus = z.enum(['active', 'draining', 'retired']);
export type DeploymentStatus = z.infer<typeof deploymentStatus>;

/** An ISO-8601 instant. Views convert Postgres `Date`s before they reach the wire. */
export const timestamp = z.iso.datetime();

/** Arbitrary JSON decided by a unit's own contract (workflow input/output, JSON Schema, trigger). */
export const opaqueJson = z.unknown();
