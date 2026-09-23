import { parseMetadata } from '@ai-pipeline/metadata/metadata';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { kafkaTrigger } from './kafka-trigger.js';

/**
 * The guards that run while the trigger service is being *built*, at import time.
 *
 * They matter because a unit that gets one of these wrong would otherwise start, register, and then
 * silently never consume — the subscription's sink would name a handler that does not exist. Failing
 * at construction turns that into a container that refuses to boot.
 *
 * The handlers themselves need a Restate context, so they are covered by the always-replay test.
 */
const metadata = (triggers: unknown[]) =>
  parseMetadata({
    apiVersion: 'ai-pipeline/v1alpha1',
    kind: 'workflow',
    name: 'content-enrichment',
    restateName: 'ContentEnrichment',
    version: '1.0.0',
    triggers,
  });

const kafka = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: 'kafka',
  cluster: 'local',
  topic: 'content.published',
  ...extra,
});

const input = z.object({ text: z.string() });

describe('kafkaTrigger', () => {
  it('builds one handler per Kafka trigger, named after the trigger id', () => {
    const service = kafkaTrigger({
      metadata: metadata([kafka('content-published'), kafka('content-updated')]),
      input,
    });
    // The subscription sinks the control plane creates point at exactly these names.
    expect(Object.keys((service as unknown as { service: object }).service).sort()).toEqual([
      'onContentPublished',
      'onContentUpdated',
    ]);
  });

  it('names the service after the workflow it feeds', () => {
    const service = kafkaTrigger({ metadata: metadata([kafka('content-published')]), input });
    expect((service as unknown as { name: string }).name).toBe('ContentEnrichmentTrigger');
  });

  it('refuses a unit that declares no Kafka triggers', () => {
    expect(() =>
      kafkaTrigger({ metadata: metadata([{ id: 'api', type: 'rest' }]), input }),
    ).toThrow(/declares no kafka triggers/);
  });

  it('refuses a trigger whose named adapter is not exported', () => {
    expect(() =>
      kafkaTrigger({
        metadata: metadata([kafka('content-published', { adapter: 'contentPublished' })]),
        input,
        adapters: {},
      }),
    ).toThrow(/adapter "contentPublished" is not exported/);
  });

  it('accepts a trigger with no adapter, which passes the record through', () => {
    expect(() =>
      kafkaTrigger({ metadata: metadata([kafka('content-published')]), input }),
    ).not.toThrow();
  });

  it('accepts an adapter that is exported', () => {
    expect(() =>
      kafkaTrigger({
        metadata: metadata([kafka('content-published', { adapter: 'contentPublished' })]),
        input,
        adapters: { contentPublished: (event) => event },
      }),
    ).not.toThrow();
  });
});
