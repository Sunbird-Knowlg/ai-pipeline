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

/** Run id for a REST start: derived from the caller's Idempotency-Key, else random. */
export function apiRunId(workflow: string, idempotencyKey?: string): string {
  return idempotencyKey
    ? `api_${digest(`api:${workflow}:${idempotencyKey}`)}`
    : `api_${crypto.randomUUID().replaceAll('-', '')}`;
}

export const RUN_ID_PATTERN = /^(api|kf)_[0-9a-f]{32}$/;
