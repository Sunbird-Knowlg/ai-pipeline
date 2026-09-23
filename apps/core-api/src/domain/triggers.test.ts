import { describe, expect, it } from 'vitest';
import { definitionOf, fakeControlPlane, metadataOf, triggerOf } from '../testing/restate.js';
import { reconcileTriggers, setTriggerEnabled, triggerViews } from './triggers.js';

/**
 * Converging Restate's subscriptions onto the catalogue's desired state.
 *
 * The pure diff is covered in `reconcile.test.ts`; this covers the part with side effects — which
 * calls are actually made, in what order, and what gets recorded when one fails.
 */

const kafkaTrigger = {
  id: 'content-published',
  type: 'kafka' as const,
  cluster: 'local',
  topic: 'content.published',
};

const withKafka = () => {
  const metadata = metadataOf({ triggers: [{ id: 'api', type: 'rest' }, kafkaTrigger] });
  return fakeControlPlane({
    seed: {
      definitions: [definitionOf({ metadata })],
      triggers: [
        triggerOf(),
        triggerOf({
          triggerId: 'content-published',
          type: 'kafka',
          definition: kafkaTrigger,
          observedStatus: 'pending',
        }),
      ],
    },
  });
};

describe('reconcileTriggers', () => {
  it('creates the missing subscription and ensures the cluster first', async () => {
    const cp = withKafka();
    const views = await reconcileTriggers(cp, 'content-enrichment');

    expect(cp.admin.clusters).toEqual(['local']);
    expect(cp.admin.subscriptions).toEqual([
      expect.objectContaining({
        source: 'kafka://local/content.published',
        sink: 'service://ContentEnrichmentTrigger/onContentPublished',
        options: expect.objectContaining({
          'group.id': 'wf.content-enrichment.content-published',
          'auto.offset.reset': 'earliest',
        }) as unknown,
      }),
    ]);
    expect(views).toEqual([
      expect.objectContaining({ id: 'api', observedStatus: 'active' }),
      expect.objectContaining({
        id: 'content-published',
        observedStatus: 'active',
        source: 'kafka://local/content.published',
      }),
    ]);
  });

  it('serialises reconciles, because creating a subscription is not idempotent', async () => {
    const cp = withKafka();
    await reconcileTriggers(cp, 'content-enrichment');
    expect(cp.store.locks).toEqual(['reconcile:content-enrichment']);
  });

  it('does nothing twice: a second pass keeps the existing subscription', async () => {
    const cp = withKafka();
    await reconcileTriggers(cp, 'content-enrichment');
    const [first] = cp.admin.subscriptions;
    await reconcileTriggers(cp, 'content-enrichment');
    expect(cp.admin.subscriptions).toHaveLength(1);
    expect(cp.admin.subscriptions[0]!.id).toBe(first!.id);
  });

  it('records a failed create as an error the API can show', async () => {
    const cp = withKafka();
    cp.admin.failCreate = 'kafka cluster unreachable';

    const views = await reconcileTriggers(cp, 'content-enrichment');
    const kafka = views.find((v) => v.id === 'content-published');
    expect(kafka).toMatchObject({
      observedStatus: 'error',
      lastError: 'kafka cluster unreachable',
    });
    expect(kafka?.subscriptionId).toBeUndefined();
  });

  it('removes a subscription whose topic no longer matches the catalogue', async () => {
    const cp = withKafka();
    cp.admin.subscriptions = [
      {
        id: 'sub_stale',
        source: 'kafka://local/content.old',
        sink: 'service://ContentEnrichmentTrigger/onContentPublished',
        options: {},
      },
    ];
    await reconcileTriggers(cp, 'content-enrichment');
    expect(cp.admin.subscriptions.map((s) => s.id)).not.toContain('sub_stale');
    expect(cp.admin.subscriptions).toHaveLength(1);
  });

  it('leaves subscriptions belonging to another workflow alone', async () => {
    const cp = withKafka();
    cp.admin.subscriptions = [
      {
        id: 'sub_other',
        source: 'kafka://local/x',
        sink: 'service://OtherTrigger/onX',
        options: {},
      },
    ];
    await reconcileTriggers(cp, 'content-enrichment');
    expect(cp.admin.subscriptions.map((s) => s.id)).toContain('sub_other');
  });

  it('404s on a unit the catalogue does not know', async () => {
    await expect(reconcileTriggers(fakeControlPlane(), 'nope')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});

describe('setTriggerEnabled', () => {
  it('reports `disabling` while the subscription is still being torn down', async () => {
    const cp = withKafka();
    await reconcileTriggers(cp, 'content-enrichment');
    // Deleting the subscription stops the consumer, but Restate may already have enqueued records.
    const view = await setTriggerEnabled(cp, 'content-enrichment', 'content-published', false);
    expect(view).toMatchObject({ desiredEnabled: false, observedStatus: 'disabled' });
    expect(cp.admin.subscriptions).toHaveLength(0);
  });

  it('re-creates the subscription with the same group id, so it resumes from committed offsets', async () => {
    const cp = withKafka();
    await reconcileTriggers(cp, 'content-enrichment');
    await setTriggerEnabled(cp, 'content-enrichment', 'content-published', false);
    await setTriggerEnabled(cp, 'content-enrichment', 'content-published', true);

    expect(cp.admin.subscriptions).toHaveLength(1);
    expect(cp.admin.subscriptions[0]!.options['group.id']).toBe(
      'wf.content-enrichment.content-published',
    );
  });

  it('switches a REST trigger off without touching Restate', async () => {
    const cp = withKafka();
    const view = await setTriggerEnabled(cp, 'content-enrichment', 'api', false);
    expect(view).toMatchObject({ id: 'api', desiredEnabled: false, observedStatus: 'disabled' });
  });

  it('404s on an unknown trigger', async () => {
    await expect(
      setTriggerEnabled(withKafka(), 'content-enrichment', 'nope', false),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('triggerViews', () => {
  it('reads observed status live from Restate rather than trusting the stored value', async () => {
    const cp = withKafka();
    // The catalogue still claims a subscription exists; Restate has none.
    cp.store.seed.triggers[1]!.observedStatus = 'active';
    cp.store.seed.triggers[1]!.subscriptionId = 'sub_gone';

    const views = await triggerViews(cp, cp.store, 'content-enrichment');
    expect(views.find((v) => v.id === 'content-published')).toMatchObject({
      observedStatus: 'pending',
    });
  });
});
