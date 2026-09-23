import { Difficulty, METADATA_TEXT_MAX } from '@ai-pipeline/contract-content-metadata';
import { QUIZ_TEXT_MAX, QuizQuestion } from '@ai-pipeline/contract-quiz-generate';
import { runRequest } from '@ai-pipeline/contracts/trigger';
import { z } from 'zod';

/**
 * The `content-authoring` contract's data shapes. Kept apart from `./api.ts` so the catalogue side
 * of the contract — what the deploy CLI turns into JSON Schema — needs no Restate SDK.
 */

export const CONTENT_NAME_MAX = 500;
export const CONTENT_DESCRIPTION_MAX = 2_000;

/**
 * Bounded by what this workflow's *callees* accept.
 *
 * The handler sends `name`, `description` and `text` joined by blank lines to three services, so
 * this unit's maxima have to add up to something the smallest of them still takes. A caller's
 * limits are the caller's responsibility; `schemas.test.ts` pins the arithmetic, so shrinking a
 * service's limit fails a test here rather than a run in production.
 */
export const CONTENT_TEXT_MAX =
  Math.min(METADATA_TEXT_MAX, QUIZ_TEXT_MAX) - CONTENT_NAME_MAX - CONTENT_DESCRIPTION_MAX - 4;

/**
 * The payload DIKSHA hands over: what the content is, and enough of it to work on.
 *
 * `contentId` is the DIKSHA identifier (`do_…`), kept as an opaque string — this pipeline never
 * parses it. It is also what a caller uses to find the run again.
 */
export const ContentAuthoringInput = z.strictObject({
  contentId: z.string().min(1).max(256),
  name: z.string().min(1).max(CONTENT_NAME_MAX),
  description: z.string().max(CONTENT_DESCRIPTION_MAX).optional(),
  /** The body, transcript or long description — whatever text the authoring pack is built from. */
  text: z.string().min(1).max(CONTENT_TEXT_MAX),
  subject: z.string().max(100).optional(),
  gradeLevel: z.string().max(100).optional(),
  /**
   * Defaulted, not required: the catalogue's *input* schema marks it optional, and the Restate
   * handler's own schema fills it in. A REST caller may omit it; the handler still sees a language.
   */
  language: z.string().min(2).max(40).default('en'),
});
export type ContentAuthoringInput = z.infer<typeof ContentAuthoringInput>;

export const ContentAuthoringOutput = z.strictObject({
  contentId: z.string(),
  name: z.string(),
  summary: z.string(),
  metadata: z.strictObject({
    keywords: z.array(z.string()).max(20),
    concepts: z.array(z.string()).max(8),
    difficulty: Difficulty,
    language: z.string(),
    subject: z.string().optional(),
    gradeLevel: z.string().optional(),
    wordCount: z.number().int().nonnegative(),
    readingTimeMinutes: z.number(),
  }),
  quiz: z.strictObject({
    questions: z.array(QuizQuestion).min(1),
    /** Items the quiz service had to discard. A rising number is a prompt or model problem. */
    discarded: z.number().int().nonnegative(),
  }),
  /** Where this pack came from and what made it — the part an editor needs when it looks wrong. */
  provenance: z.strictObject({
    trigger: z.enum(['rest', 'kafka']),
    version: z.string(),
    models: z.strictObject({
      summary: z.string(),
      metadata: z.string(),
      quiz: z.string(),
    }),
    authoredAt: z.number().int(),
  }),
});
export type ContentAuthoringOutput = z.infer<typeof ContentAuthoringOutput>;

export const ContentAuthoringConfig = z.strictObject({
  summaryMaxWords: z.number().int().min(10).max(1000),
  maxKeywords: z.number().int().min(3).max(20),
  questionCount: z.number().int().min(1).max(10),
});
export type ContentAuthoringConfig = z.infer<typeof ContentAuthoringConfig>;

/**
 * The `diksha.content.published` event as the platform emits it (mapped by the trigger adapter).
 *
 * Loose, and strict only about the three things this workflow cannot do without: the identifier,
 * the name, and some text. Everything else is `unknown` because DIKSHA sends `subject`,
 * `gradeLevel` and `language` sometimes as a string and sometimes as an array — normalising that is
 * the adapter's job, not a reason to reject a record.
 */
export const DikshaContentEvent = z.looseObject({
  eid: z.string().optional(),
  objectType: z.string().optional(),
  identifier: z.string().min(1),
  edata: z.looseObject({
    state: z.string().nullish(),
    name: z.string().min(1),
    description: z.string().nullish(),
    body: z.string().nullish(),
    transcript: z.string().nullish(),
    // `.optional()` is not decoration: in zod 4 a bare `z.unknown()` still requires the key.
    subject: z.unknown().optional(),
    gradeLevel: z.unknown().optional(),
    language: z.unknown().optional(),
  }),
});
export type DikshaContentEvent = z.infer<typeof DikshaContentEvent>;

export const ContentAuthoringRequest = runRequest(ContentAuthoringInput);
export type ContentAuthoringRequest = z.infer<typeof ContentAuthoringRequest>;
