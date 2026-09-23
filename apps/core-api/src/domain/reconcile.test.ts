import { parseMetadata } from '@ai-pipeline/metadata/metadata';
import { describe, expect, it } from 'vitest';
import {
  desiredSubscriptions,
  diffSubscriptions,
  observedStatus,
  registrationConflict,
  sinkPrefix,
} from './reconcile.js';

const metadata = parseMetadata({
  apiVersion: 'ai-pipeline/v1alpha1',
  kind: 'workflow',
  name: 'content-enrichment',
  restateName: 'ContentEnrichment',
  version: '0.1.0',
  triggers: [
    { id: 'api', type: 'rest' },
    { id: 'content-published', type: 'kafka', cluster: 'local', topic: 'content.published' },
    { id: 'content-updated', type: 'kafka', cluster: 'local', topic: 'content.updated' },
  ],
});
const prefix = sinkPrefix('ContentEnrichment');
/** A live subscription as Restate reports it, matching what `desiredSubscriptions` asks for. */
const sub = (id: string, topic: string, handler: string, options?: Record<string, string>) => ({
  id,
  source: `kafka://local/${topic}`,
  sink: `${prefix}${handler}`,
  options: options ?? {
    ...(desiredSubscriptions(metadata, () => true).find((d) => d.sink.endsWith(handler))?.options ??
      {}),
    // Restate sets this itself; extra keys must not count as a mismatch.
    'client.id': 'restate',
  },
});

describe('desiredSubscriptions', () => {
  it('maps each enabled kafka trigger to a handler of the trigger service', () => {
    const desired = desiredSubscriptions(metadata, (id) => id !== 'content-updated');
    expect(desired).toHaveLength(1);
    expect(desired[0]).toMatchObject({
      triggerId: 'content-published',
      source: 'kafka://local/content.published',
      sink: 'service://ContentEnrichmentTrigger/onContentPublished',
      options: {
        'group.id': 'wf.content-enrichment.content-published',
        'auto.offset.reset': 'earliest',
      },
    });
  });

  it('widens the consumer timeouts, so a host stall does not get the consumer evicted', () => {
    // Restate passes these through to librdkafka. Without them a few seconds of stall is enough
    // for the broker to drop the member on a missed heartbeat — and Restate does not rejoin, so
    // ingestion stops while the subscription (and therefore the trigger's status) still looks fine.
    const [subscription] = desiredSubscriptions(metadata, () => true);
    const options = subscription!.options;
    const session = Number(options['session.timeout.ms']);
    const heartbeat = Number(options['heartbeat.interval.ms']);

    expect(session).toBeGreaterThan(45_000); // librdkafka's default, which was not enough
    expect(Number(options['max.poll.interval.ms'])).toBeGreaterThanOrEqual(session);
    // Kafka refuses a heartbeat interval that is not comfortably under the session timeout.
    expect(heartbeat).toBeLessThan(session / 3);
  });
});

describe('diffSubscriptions', () => {
  const desired = desiredSubscriptions(metadata, () => true);

  it('creates missing, keeps matching, removes stale and duplicates, ignores foreign sinks', () => {
    const live = [
      sub('sub_keep', 'content.published', 'onContentPublished'),
      sub('sub_dup', 'content.published', 'onContentPublished'),
      sub('sub_stale', 'content.old', 'onContentOld'),
      {
        id: 'sub_foreign',
        source: 'kafka://local/x',
        sink: 'service://OtherTrigger/onX',
        options: {},
      },
    ];
    const diff = diffSubscriptions(desired, live, prefix);
    expect(diff.create.map((d) => d.triggerId)).toEqual(['content-updated']);
    expect(diff.keep.get('content-published')?.id).toBe('sub_keep');
    expect(diff.remove.map((s) => s.id).sort()).toEqual(['sub_dup', 'sub_stale']);
  });

  it('replaces a subscription whose consumer options no longer match', () => {
    // A subscription cannot be edited, so changing the desired consumer settings has to mean
    // replacing it. Matching on source and sink alone would leave an existing subscription on
    // whatever it was created with, and a settings change would reach new units only.
    const stale = sub('sub_old_options', 'content.published', 'onContentPublished', {
      'group.id': 'wf.content-enrichment.content-published',
      'auto.offset.reset': 'earliest',
      'client.id': 'restate',
    });
    const diff = diffSubscriptions(desired, [stale], prefix);
    expect(diff.remove.map((s) => s.id)).toEqual(['sub_old_options']);
    expect(diff.create.map((d) => d.triggerId)).toContain('content-published');
  });

  it('replaces a subscription whose topic changed', () => {
    const diff = diffSubscriptions(
      desired,
      [sub('sub_moved', 'content.moved', 'onContentPublished')],
      prefix,
    );
    expect(diff.remove.map((s) => s.id)).toEqual(['sub_moved']);
    expect(diff.create.map((d) => d.triggerId)).toEqual(['content-published', 'content-updated']);
  });
});

describe('observedStatus', () => {
  const live = sub('sub_1', 'content.published', 'onContentPublished');
  it.each([
    [{ type: 'rest', desired: true }, undefined, 'active'],
    [{ type: 'rest', desired: false }, undefined, 'disabled'],
    [{ type: 'kafka', desired: true }, live, 'active'],
    [{ type: 'kafka', desired: true }, undefined, 'pending'],
    [{ type: 'kafka', desired: true, lastError: 'boom' }, undefined, 'error'],
    [{ type: 'kafka', desired: false }, live, 'disabling'],
    [{ type: 'kafka', desired: false }, undefined, 'disabled'],
  ] as const)('%j + %j → %s', (trigger, subscription, expected) => {
    expect(observedStatus(trigger, subscription)).toBe(expected);
  });
});

describe('registrationConflict', () => {
  const incoming = { contractHash: 'sha256:a', artifactDigest: 'img:1' };
  it('allows new versions and idempotent re-registration', () => {
    expect(registrationConflict('immutable', undefined, [], incoming)).toBeUndefined();
    expect(
      registrationConflict('immutable', { contractHash: 'sha256:a' }, ['img:1'], incoming),
    ).toBeUndefined();
  });
  it('rejects same version with a different contract or artifact', () => {
    expect(
      registrationConflict('immutable', { contractHash: 'sha256:b' }, [], incoming)?.code,
    ).toBe('VERSION_CONTRACT_CONFLICT');
    expect(
      registrationConflict('immutable', { contractHash: 'sha256:a' }, ['img:0'], incoming)?.code,
    ).toBe('VERSION_ARTIFACT_CONFLICT');
  });
  it('lets dev mode replace in place', () => {
    expect(
      registrationConflict('dev', { contractHash: 'sha256:b' }, ['img:0'], incoming),
    ).toBeUndefined();
  });
});
