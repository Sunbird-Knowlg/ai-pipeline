import { describe, expect, it } from 'vitest';
import {
  definitionOf,
  deploymentOf,
  fakeControlPlane,
  metadataOf,
  triggerOf,
} from '../testing/restate.js';
import { describeUnit, listUnits } from './catalogue.js';

/**
 * The catalogue read models — and the round-trip counts they cost.
 *
 * Restate has no per-service subscription endpoint, so a naive implementation fetches the same
 * global list once per catalogued unit. These tests pin the count, because that is the only thing
 * that stops it quietly coming back.
 */
const twoUnits = () =>
  fakeControlPlane({
    seed: {
      definitions: [
        definitionOf(),
        definitionOf({
          metadata: metadataOf({ name: 'whisper', kind: 'service', restateName: 'WhisperService' }),
          name: 'whisper',
          kind: 'service',
        }),
      ],
      deployments: [deploymentOf(), deploymentOf({ deploymentId: 'dp_2', name: 'whisper' })],
      triggers: [triggerOf()],
    },
  });

describe('listUnits', () => {
  it('lists every catalogued unit with its triggers and active deployment', async () => {
    const cp = twoUnits();
    const units = await listUnits(cp);
    expect(units.map((u) => u.name)).toEqual(['transcript', 'whisper']);
    expect(units[0]).toMatchObject({
      kind: 'workflow',
      activeDeployment: 'dp_1',
      triggers: [expect.objectContaining({ id: 'api' })],
    });
  });

  it('filters by kind', async () => {
    const cp = twoUnits();
    expect((await listUnits(cp, 'service')).map((u) => u.name)).toEqual(['whisper']);
  });

  it('fetches the subscription list once, not once per unit', async () => {
    const cp = twoUnits();
    await listUnits(cp);
    expect(cp.admin.calls.listSubscriptions).toBe(1);
  });

  it('returns an empty list rather than failing on an empty catalogue', async () => {
    await expect(listUnits(fakeControlPlane())).resolves.toEqual([]);
  });
});

describe('describeUnit', () => {
  it('assembles versions, deployments, dependencies and triggers', async () => {
    const cp = twoUnits();
    const detail = await describeUnit(cp, 'transcript');
    expect(detail).toMatchObject({
      name: 'transcript',
      version: '1.0.0',
      restateName: 'Transcript',
      contractHash: expect.stringMatching(/^sha256:/),
    });
    expect(detail.versions).toEqual([
      expect.objectContaining({ version: '1.0.0', registeredAt: expect.any(String) }),
    ]);
    expect(detail.deployments[0]).toMatchObject({ deploymentId: 'dp_1', status: 'active' });
    // Timestamps reach the wire as ISO strings, converted in views.ts rather than by the serializer.
    expect(detail.versions[0]!.registeredAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('404s on a unit the catalogue does not know', async () => {
    await expect(describeUnit(twoUnits(), 'nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
