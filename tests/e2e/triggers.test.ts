import type { ErrorEnvelope } from '@ai-pipeline/api-contract/errors';
import type { TriggerPatched } from '@ai-pipeline/api-contract/triggers';
import { describe, expect, it } from 'vitest';
import { ADMIN, api } from './support.js';

const subscriptions = async () =>
  (
    (await (await fetch(`${ADMIN}/subscriptions`)).json()) as { subscriptions: { sink: string }[] }
  ).subscriptions.filter((s) => s.sink.startsWith('service://ContentEnrichmentTrigger/'));

describe('trigger management', () => {
  it('disables and re-enables the Kafka trigger by converging Restate subscriptions', async () => {
    const path = '/v1/workflows/content-enrichment/triggers/content-published';
    try {
      const off = await api<TriggerPatched>('PATCH', path, { enabled: false });
      expect(off.body).toMatchObject({ desiredEnabled: false, observedStatus: 'disabled' });
      expect(off.body.note).toMatch(/already enqueued/);
      expect(await subscriptions()).toHaveLength(0);
    } finally {
      // Never leave the shared dev stack with the trigger off.
      const on = await api<TriggerPatched>('PATCH', path, { enabled: true });
      expect(on.body).toMatchObject({ desiredEnabled: true, observedStatus: 'active' });
    }
    expect(await subscriptions()).toHaveLength(1);
  });

  it('refuses cross-site browser writes (no auth in v1)', async () => {
    const res = await api<ErrorEnvelope>(
      'POST',
      '/v1/runs/content-enrichment/kf_00000000000000000000000000000000/cancel',
      undefined,
      { origin: 'https://evil.example' },
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CROSS_SITE_REQUEST');
  });

  it('rejects REST runs while the REST trigger is disabled', async () => {
    await api<TriggerPatched>('PATCH', '/v1/workflows/content-enrichment/triggers/api', {
      enabled: false,
    });
    try {
      const res = await api<ErrorEnvelope>('POST', '/v1/workflows/content-enrichment/runs', {
        input: { contentId: 'c', text: 't' },
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('TRIGGER_DISABLED');
    } finally {
      await api<TriggerPatched>('PATCH', '/v1/workflows/content-enrichment/triggers/api', {
        enabled: true,
      });
    }
  });
});
