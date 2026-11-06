import { createHash } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);

/**
 * Opaque, stable run id for one Kafka record of one trigger. Identity only — never parsed back.
 * The record timestamp is part of it: a redelivered record keeps its id (Restate dedups it),
 * but a recreated topic whose offsets restart at 0 does not collide with earlier runs.
 */
export function kafkaRunId(parts: {
  cluster: string;
  triggerId: string;
  topic: string;
  partition: string | number;
  offset: string | number;
  timestamp?: string | number;
}): string {
  const { cluster, triggerId, topic, partition, offset, timestamp = '' } = parts;
  return `kf_${digest(`kafka:${cluster}:${triggerId}:${topic}:${partition}:${offset}:${timestamp}`)}`;
}

/**
 * Run id for a Kafka record whose business input has its own stable identity (e.g. a Content's
 * identifier plus the artifact it was published with). Two records that produce the same key
 * collapse onto one workflow execution -- Restate's own submission semantics dedupe them (the
 * second attaches/no-ops rather than running again), with no extra storage or infrastructure.
 * Same shape as `kafkaRunId` (`kf_` prefix, 32 hex chars) so nothing downstream that expects
 * `RUN_ID_PATTERN` needs to change.
 */
export function contentRunId(identifier: string, artifactHash: string): string {
  return `kf_${digest(`content:${identifier}:${artifactHash}`)}`;
}

/** Run id for a REST start: derived from the caller's Idempotency-Key, else random. */
export function apiRunId(workflow: string, idempotencyKey?: string): string {
  return idempotencyKey
    ? `api_${digest(`api:${workflow}:${idempotencyKey}`)}`
    : `api_${crypto.randomUUID().replaceAll('-', '')}`;
}

export const RUN_ID_PATTERN = /^(api|kf)_[0-9a-f]{32}$/;
