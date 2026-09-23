import { ContentMetadataInput } from '@ai-pipeline/contract-content-metadata';
import { QuizGenerateInput } from '@ai-pipeline/contract-quiz-generate';
import { SummaryInput } from '@ai-pipeline/contract-summary';
import { describe, expect, it } from 'vitest';
import {
  CONTENT_DESCRIPTION_MAX,
  CONTENT_NAME_MAX,
  CONTENT_TEXT_MAX,
  ContentAuthoringInput,
  ContentAuthoringRequest,
  DikshaContentEvent,
} from './schemas.js';
import { authoringText } from './steps.js';

/** This workflow's own contract, and the limits it has to respect in the three units it calls. */
describe('ContentAuthoringInput', () => {
  const valid = { contentId: 'do_3130931731069747201', name: 'Photosynthesis', text: 'Plants…' };

  it('requires an id, a name and some text', () => {
    expect(ContentAuthoringInput.safeParse(valid).success).toBe(true);
    expect(ContentAuthoringInput.safeParse({ ...valid, text: '' }).success).toBe(false);
    expect(ContentAuthoringInput.safeParse({ ...valid, name: '' }).success).toBe(false);
    expect(ContentAuthoringInput.safeParse({ contentId: 'do_1', text: 't' }).success).toBe(false);
  });

  it('treats description, subject and gradeLevel as optional', () => {
    const parsed = ContentAuthoringInput.parse({
      ...valid,
      description: 'A short blurb',
      subject: 'Science',
      gradeLevel: 'Class 7',
    });
    expect(parsed.subject).toBe('Science');
    expect(ContentAuthoringInput.safeParse(valid).success).toBe(true);
  });

  it('defaults the language, so a caller that omits it still gets one', () => {
    expect(ContentAuthoringInput.parse(valid).language).toBe('en');
    expect(ContentAuthoringInput.parse({ ...valid, language: 'hi' }).language).toBe('hi');
  });

  it('refuses unknown keys, so a caller cannot smuggle fields past the contract', () => {
    expect(ContentAuthoringInput.safeParse({ ...valid, mimeType: 'video/mp4' }).success).toBe(
      false,
    );
  });
});

describe('ContentAuthoringRequest', () => {
  const input = { contentId: 'do_1', name: 'N', text: 't' };

  it('carries the trigger context alongside the input', () => {
    expect(
      ContentAuthoringRequest.safeParse({
        input,
        trigger: { type: 'rest', id: 'api', receivedAt: 1_700_000_000_000 },
      }).success,
    ).toBe(true);
  });

  it('will not accept a request with no trigger context', () => {
    // The control plane builds the trigger context; a request without one did not come through it.
    expect(ContentAuthoringRequest.safeParse({ input }).success).toBe(false);
  });
});

describe('DikshaContentEvent', () => {
  const event = {
    eid: 'BE_OBJECT_LIFECYCLE',
    objectType: 'Content',
    identifier: 'do_1',
    edata: { state: 'Live', name: 'Photosynthesis', body: 'Plants make food.' },
  };

  it('accepts the platform shape and tolerates extra fields', () => {
    expect(DikshaContentEvent.safeParse({ ...event, channel: 'in.ekstep' }).success).toBe(true);
  });

  it('requires an identifier and a name', () => {
    expect(DikshaContentEvent.safeParse({ ...event, identifier: '' }).success).toBe(false);
    expect(DikshaContentEvent.safeParse({ ...event, edata: { state: 'Live' } }).success).toBe(
      false,
    );
  });

  it('accepts subject, gradeLevel and language as either a string or an array', () => {
    const both = (value: unknown) =>
      DikshaContentEvent.safeParse({ ...event, edata: { ...event.edata, gradeLevel: value } })
        .success;
    expect(both('Class 7')).toBe(true);
    expect(both(['Class 7', 'Class 8'])).toBe(true);
    expect(both(7)).toBe(true); // tolerated and ignored: the adapter will not find a string
  });
});

describe('the limits this workflow has to respect in its callees', () => {
  const largest = ContentAuthoringInput.parse({
    contentId: 'do_1',
    name: 'n'.repeat(CONTENT_NAME_MAX),
    description: 'd'.repeat(CONTENT_DESCRIPTION_MAX),
    text: 't'.repeat(CONTENT_TEXT_MAX),
  });

  it('the largest valid input still fits all three services', () => {
    // The handler sends one composed text to summary, content-metadata and quiz-generate, so this
    // unit's maxima have to add up to something every one of them accepts. Shrinking any service's
    // limit should fail here, not in production.
    const text = authoringText(largest);
    expect(SummaryInput.safeParse({ text, maxWords: 1000 }).success).toBe(true);
    expect(ContentMetadataInput.safeParse({ text, maxKeywords: 20 }).success).toBe(true);
    expect(QuizGenerateInput.safeParse({ text, questionCount: 10, focus: [] }).success).toBe(true);
  });

  it('one character more than the maximum is refused here rather than by a callee', () => {
    expect(
      ContentAuthoringInput.safeParse({ ...largest, text: 't'.repeat(CONTENT_TEXT_MAX + 1) })
        .success,
    ).toBe(false);
  });
});
