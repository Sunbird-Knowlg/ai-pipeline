import { describe, expect, it } from 'vitest';
import { adapters } from './adapters.js';
import { mappedAdapter, readPath } from './mapping.js';
import { EventMapping, RagIngestInput } from './schemas.js';

describe('readPath', () => {
  const event = { edata: { name: 'N', tags: ['a', 'b'], nested: [{ x: 1 }] }, top: 0 };
  it('follows keys and indexes, and gives up quietly on a missing step', () => {
    expect(readPath(event, 'edata.name')).toBe('N');
    expect(readPath(event, 'edata.tags[1]')).toBe('b');
    expect(readPath(event, 'edata.nested[0].x')).toBe(1);
    expect(readPath(event, 'top')).toBe(0);
    expect(readPath(event, 'edata.missing.deeper')).toBeUndefined();
    expect(readPath(event, 'edata.name[0]')).toBeUndefined();
  });
});

describe('mappedAdapter', () => {
  const mapping = EventMapping.parse({
    collection: 'diksha_content',
    when: [
      { path: 'eid', equals: 'BE_JOB_REQUEST' },
      { path: 'edata.status', in: ['Live', 'Draft'] },
    ],
    deleteWhen: [{ path: 'edata.status', equals: 'Draft' }],
    documentId: 'edata.identifier',
    text: ['edata.name', 'edata.description', 'edata.body'],
    title: 'edata.name',
    version: 'ets',
    metadata: { channel: 'edata.channel', subject: 'edata.subject', medium: 'edata.medium' },
  });
  const adapt = mappedAdapter(mapping);
  const event = (edata: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    eid: 'BE_JOB_REQUEST',
    ets: 1757930000000,
    edata: { identifier: 'do_1', status: 'Live', name: 'Water', ...edata },
    ...extra,
  });

  it('maps an event to an upsert of one document, joining the text paths it finds', () => {
    const input = adapt(
      event({
        description: 'The water cycle.',
        channel: 'ch',
        subject: ['Science'],
        medium: { nested: true },
      }),
    );
    expect(RagIngestInput.parse(input)).toEqual({
      operation: 'upsert',
      collection: 'diksha_content',
      documents: [
        {
          id: 'do_1',
          text: 'Water\n\nThe water cycle.',
          format: 'text',
          title: 'Water',
          // An object is not filterable metadata, so it is left out.
          metadata: { channel: 'ch', subject: ['Science'] },
          version: 1757930000000,
        },
      ],
    });
  });

  it('skips events that are not its business, silently', () => {
    expect(adapt({ eid: 'OTHER' })).toBeNull();
    expect(adapt(event({ status: 'Retired' }))).toBeNull();
  });

  it('turns a matching delete condition into a delete, ordered by the event’s version', () => {
    expect(adapt(event({ status: 'Draft' }))).toEqual({
      operation: 'delete',
      collection: 'diksha_content',
      documentIds: ['do_1'],
      version: 1757930000000,
    });
  });

  it('fails loudly on an event that is ours but broken', () => {
    expect(() => adapt(event({ identifier: '' }))).toThrow(/no document id/);
    expect(() => adapt(event({ name: undefined }))).toThrow(/no text/);
    expect(() => adapt(event({}, { ets: 'yesterday' }))).toThrow(/version/);
  });

  it('reads an ISO date or a numeric string as a version', () => {
    const iso = adapt(event({}, { ets: '2026-10-01T00:00:00.000Z' }));
    expect(iso).toMatchObject({ documents: [{ version: Date.parse('2026-10-01T00:00:00.000Z') }] });
    expect(adapt(event({}, { ets: '42' }))).toMatchObject({ documents: [{ version: 42 }] });
  });
});

describe('the shipped adapters', () => {
  it('build one adapter per eventMappings entry, and map the fake document events', () => {
    expect(Object.keys(adapters)).toEqual(['documentEvent']);
    const input = adapters.documentEvent!({
      type: 'document',
      id: 'doc-1',
      title: 'Photosynthesis',
      body: '# Leaves\nPlants make food.',
      lang: 'en',
      tags: ['biology'],
      version: 3,
    });
    expect(RagIngestInput.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      operation: 'upsert',
      collection: 'documents',
      documents: [{ id: 'doc-1', format: 'markdown', metadata: { lang: 'en', tags: ['biology'] } }],
    });
    expect(adapters.documentEvent!({ type: 'document', id: 'doc-1', deleted: true })).toEqual({
      operation: 'delete',
      collection: 'documents',
      documentIds: ['doc-1'],
    });
    expect(adapters.documentEvent!({ type: 'ping' })).toBeNull();
  });
});
