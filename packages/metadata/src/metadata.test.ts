import { describe, expect, it } from 'vitest';
import { parseMetadata } from './metadata.js';
import { apiRunId, kafkaRunId, RUN_ID_PATTERN } from './run-ids.js';

const base = {
  apiVersion: 'ai-pipeline/v1alpha1',
  kind: 'workflow',
  name: 'content-enrichment',
  restateName: 'ContentEnrichment',
  version: '0.1.0',
};

describe('metadata', () => {
  it('applies defaults', () => {
    const m = parseMetadata(base);
    expect(m).toMatchObject({ visibility: 'public', config: {}, triggers: [], dependencies: [] });
  });

  it('rejects duplicate trigger ids and unknown keys', () => {
    const dup = {
      ...base,
      triggers: [
        { id: 'api', type: 'rest' },
        { id: 'api', type: 'rest' },
      ],
    };
    expect(() => parseMetadata(dup)).toThrow(/duplicate trigger id/);
    expect(() => parseMetadata({ ...base, schemas: {} })).toThrow(/invalid metadata/);
  });

  it('rejects ids whose kafka handler names collide, and duplicate dependencies', () => {
    const kafka = (id: string) => ({ id, type: 'kafka', cluster: 'local', topic: 't' });
    expect(() => parseMetadata({ ...base, triggers: [kafka('order-1'), kafka('order1')] })).toThrow(
      /same handler/,
    );
    expect(() => parseMetadata({ ...base, triggers: [kafka('orders-')] })).toThrow(/kebab/);
    const dep = { kind: 'service', name: 'summary' };
    expect(() => parseMetadata({ ...base, dependencies: [dep, dep] })).toThrow(
      /duplicate dependency/,
    );
  });

  it('rejects triggers on private services', () => {
    const svc = {
      ...base,
      kind: 'service',
      visibility: 'private',
      triggers: [{ id: 'api', type: 'rest' }],
    };
    expect(() => parseMetadata(svc)).toThrow(/only workflows declare triggers/);
  });
});

describe('run ids', () => {
  it('derives stable opaque ids', () => {
    const parts = { cluster: 'local', triggerId: 't', topic: 'x.y', partition: 0, offset: 42 };
    expect(kafkaRunId(parts)).toBe(kafkaRunId({ ...parts, offset: '42' }));
    expect(kafkaRunId(parts)).not.toBe(kafkaRunId({ ...parts, offset: 43 }));
    expect(kafkaRunId({ ...parts, timestamp: 1 })).not.toBe(kafkaRunId({ ...parts, timestamp: 2 }));
    expect(kafkaRunId(parts)).toMatch(RUN_ID_PATTERN);
    expect(apiRunId('wf', 'k')).toBe(apiRunId('wf', 'k'));
    expect(apiRunId('wf', 'k')).not.toBe(apiRunId('other', 'k'));
    expect(apiRunId('wf')).toMatch(RUN_ID_PATTERN);
  });
});
