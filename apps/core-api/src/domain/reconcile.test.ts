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
const sub = (id: string, topic: string, handler: string) => ({
  id,
  source: `kafka://local/${topic}`,
  sink: `${prefix}${handler}`,
  options: {},
});

describe('desiredSubscriptions', () => {
  it('maps each enabled kafka trigger to a handler of the trigger service', () => {
    const desired = desiredSubscriptions(metadata, (id) => id !== 'content-updated');
    expect(desired).toEqual([
      {
        triggerId: 'content-published',
        source: 'kafka://local/content.published',
        sink: 'service://ContentEnrichmentTrigger/onContentPublished',
        options: {
          'group.id': 'wf.content-enrichment.content-published',
          'auto.offset.reset': 'earliest',
        },
      },
    ]);
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
