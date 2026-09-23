import { describe, expect, it } from 'vitest';
import {
  QUIZ_MAX_QUESTIONS,
  QUIZ_TEXT_MAX,
  QuizGenerateConfig,
  QuizGenerateInput,
  QuizGenerateOutput,
  QuizQuestion,
} from './schemas.js';

const question = {
  question: 'What absorbs light energy in a leaf?',
  options: ['Glucose', 'Chlorophyll', 'Oxygen', 'Water'],
  answerIndex: 1,
};

/** The quiz-generate contract. Shared, because `content-authoring` calls this service. */
describe('QuizQuestion', () => {
  it('requires exactly four options', () => {
    expect(QuizQuestion.safeParse(question).success).toBe(true);
    expect(QuizQuestion.safeParse({ ...question, options: ['a', 'b', 'c'] }).success).toBe(false);
    expect(
      QuizQuestion.safeParse({ ...question, options: ['a', 'b', 'c', 'd', 'e'] }).success,
    ).toBe(false);
  });

  it('keeps answerIndex pointing at an option that exists', () => {
    expect(QuizQuestion.safeParse({ ...question, answerIndex: 0 }).success).toBe(true);
    expect(QuizQuestion.safeParse({ ...question, answerIndex: 3 }).success).toBe(true);
    expect(QuizQuestion.safeParse({ ...question, answerIndex: 4 }).success).toBe(false);
    expect(QuizQuestion.safeParse({ ...question, answerIndex: -1 }).success).toBe(false);
  });

  it('refuses an empty option, which would render as a blank choice', () => {
    expect(QuizQuestion.safeParse({ ...question, options: ['a', 'b', 'c', ''] }).success).toBe(
      false,
    );
  });
});

describe('QuizGenerateInput', () => {
  const valid = { text: 'Plants make food.', questionCount: 3, focus: ['photosynthesis'] };

  it('requires text, a question count in range, and a focus list (possibly empty)', () => {
    expect(QuizGenerateInput.safeParse(valid).success).toBe(true);
    expect(QuizGenerateInput.safeParse({ ...valid, focus: [] }).success).toBe(true);
    expect(QuizGenerateInput.safeParse({ text: 'x', questionCount: 3 }).success).toBe(false);
    expect(QuizGenerateInput.safeParse({ ...valid, questionCount: 0 }).success).toBe(false);
    expect(
      QuizGenerateInput.safeParse({ ...valid, questionCount: QUIZ_MAX_QUESTIONS + 1 }).success,
    ).toBe(false);
  });

  it('accepts text up to the documented maximum and no further', () => {
    const at = 'x'.repeat(QUIZ_TEXT_MAX);
    expect(QuizGenerateInput.safeParse({ ...valid, text: at }).success).toBe(true);
    expect(QuizGenerateInput.safeParse({ ...valid, text: `${at}y` }).success).toBe(false);
  });
});

describe('QuizGenerateOutput', () => {
  it('treats an empty quiz as invalid: no questions is a failure, not a result', () => {
    expect(QuizGenerateOutput.safeParse({ questions: [], discarded: 3, model: 'm' }).success).toBe(
      false,
    );
    expect(
      QuizGenerateOutput.safeParse({ questions: [question], discarded: 0, model: 'm' }).success,
    ).toBe(true);
  });

  it('reports how many items it threw away, and which model wrote the rest', () => {
    expect(QuizGenerateOutput.safeParse({ questions: [question], discarded: -1 }).success).toBe(
      false,
    );
    expect(QuizGenerateOutput.safeParse({ questions: [question], discarded: 1 }).success).toBe(
      false,
    );
  });
});

describe('QuizGenerateConfig', () => {
  it('defaults the output budget rather than requiring every unit to state it', () => {
    expect(QuizGenerateConfig.parse({ model: 'chat-default' })).toEqual({
      model: 'chat-default',
      maxOutputTokens: 1200,
    });
  });

  it('requires a model', () => {
    expect(QuizGenerateConfig.safeParse({}).success).toBe(false);
  });
});
