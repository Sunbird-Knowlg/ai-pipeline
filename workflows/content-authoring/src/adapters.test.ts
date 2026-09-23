import { describe, expect, it } from 'vitest';
import { adapters } from './adapters.js';
import { ContentAuthoringInput } from './schemas.js';

const event = {
  eid: 'BE_OBJECT_LIFECYCLE',
  objectType: 'Content',
  identifier: 'do_31309317310697472011526',
  edata: {
    state: 'Live',
    name: 'Photosynthesis',
    description: 'How green plants make food',
    body: 'Plants use sunlight to make glucose.',
    subject: ['Science'],
    gradeLevel: ['Class 7'],
    language: ['English'],
  },
};

describe('dikshaContentPublished adapter', () => {
  it('maps a published Content event to ContentAuthoringInput', () => {
    expect(adapters.dikshaContentPublished(event)).toEqual({
      contentId: 'do_31309317310697472011526',
      name: 'Photosynthesis',
      description: 'How green plants make food',
      text: 'Plants use sunlight to make glucose.',
      subject: 'Science',
      gradeLevel: 'Class 7',
      language: 'en',
    });
  });

  it('produces something the workflow input schema accepts', () => {
    // The trigger validates the mapped value before submitting a run; if this ever disagrees, the
    // record fails terminally at run time instead of here.
    expect(ContentAuthoringInput.safeParse(adapters.dikshaContentPublished(event)).success).toBe(
      true,
    );
  });

  it('skips objects that are not Content', () => {
    expect(adapters.dikshaContentPublished({ ...event, objectType: 'Collection' })).toBeNull();
    expect(
      adapters.dikshaContentPublished({ objectType: 'QuestionSet', identifier: 'do_2' }),
    ).toBeNull();
  });

  it('skips lifecycle states other than Live: a draft is not ready to be authored against', () => {
    for (const state of ['Draft', 'Review', 'Retired', 'Flagged'])
      expect(
        adapters.dikshaContentPublished({ ...event, edata: { ...event.edata, state } }),
      ).toBeNull();
  });

  it('accepts an event with no state or objectType, since the topic may carry bare records', () => {
    const bare = { identifier: 'do_3', edata: { name: 'N', body: 'b' } };
    expect(adapters.dikshaContentPublished(bare)).toEqual({
      contentId: 'do_3',
      name: 'N',
      text: 'b',
      language: 'en',
    });
  });

  it('falls back through body, transcript and description for the text', () => {
    const text = (edata: Record<string, unknown>) =>
      adapters.dikshaContentPublished({ identifier: 'do_4', edata: { name: 'N', ...edata } })?.text;
    expect(text({ body: 'b', transcript: 't', description: 'd' })).toBe('b');
    expect(text({ transcript: 't', description: 'd' })).toBe('t');
    expect(text({ description: 'd' })).toBe('d');
  });

  it('fails a Live Content with no text at all, rather than dropping it quietly', () => {
    // It is this workflow's business and it arrived broken: a producer bug worth seeing.
    expect(() =>
      adapters.dikshaContentPublished({ ...event, edata: { state: 'Live', name: 'N' } }),
    ).toThrow(/no body, transcript or description/);
  });

  it('rejects a Content event that is missing the fields it promises', () => {
    expect(() => adapters.dikshaContentPublished({ identifier: 'do_5', edata: {} })).toThrow();
    expect(() => adapters.dikshaContentPublished({ edata: { name: 'N', body: 'b' } })).toThrow();
  });

  it('normalises the metadata DIKSHA sends as arrays, and ignores what it cannot read', () => {
    const mapped = adapters.dikshaContentPublished({
      ...event,
      edata: { ...event.edata, subject: 'Maths', gradeLevel: 7, language: [] },
    });
    expect(mapped?.subject).toBe('Maths');
    expect(mapped?.gradeLevel).toBeUndefined();
    expect(mapped?.language).toBe('en');
  });

  it('maps language names to codes, and passes an unknown one through', () => {
    const lang = (language: unknown) =>
      adapters.dikshaContentPublished({ ...event, edata: { ...event.edata, language } })?.language;
    expect(lang(['Hindi'])).toBe('hi');
    expect(lang('TELUGU')).toBe('te');
    expect(lang(['Bodo'])).toBe('Bodo');
  });

  it('tolerates fields the platform adds later', () => {
    const mapped = adapters.dikshaContentPublished({
      ...event,
      channel: 'in.ekstep',
      edata: { ...event.edata, pkgVersion: 3 },
    });
    expect(mapped?.contentId).toBe('do_31309317310697472011526');
  });
});
