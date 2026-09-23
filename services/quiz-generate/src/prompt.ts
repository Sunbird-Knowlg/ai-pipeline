import {
  QUIZ_OPTION_COUNT,
  QuizQuestion,
  type QuizQuestion as Question,
} from '@ai-pipeline/contract-quiz-generate';

/**
 * The prompt this service sends and how its reply is read back.
 *
 * Both live here, apart from the handler, because they are one decision: the prompt asks for a
 * shape, and `parseQuestions` is what happens when the model answers in a slightly different one. A
 * careless edit to either changes every quiz the pipeline produces, so they are reviewed and tested
 * as text.
 */

export const QUIZ_SYSTEM =
  'You write multiple-choice quiz questions from a passage. Reply with a JSON array only, ' +
  'no prose and no code fences.';

/** The passage is delimited so that instructions inside it read as content, not as direction. */
export function quizPrompt(text: string, questionCount: number, focus: readonly string[]): string {
  const cover =
    focus.length > 0
      ? ` Cover these ideas where the passage supports them: ${focus.join(', ')}.`
      : '';
  return (
    `Write ${questionCount} multiple-choice questions about the passage.${cover}\n` +
    `Each item: {"question": string, "options": [${QUIZ_OPTION_COUNT} strings], ` +
    `"answerIndex": 0-${QUIZ_OPTION_COUNT - 1}}. Use only facts from the passage.\n\n` +
    `<passage>\n${text}\n</passage>`
  );
}

/**
 * The first JSON array in a model reply.
 *
 * Models fence their JSON, prefix it with "Here you go:", or append a note — none of which is worth
 * a retry. Slicing between the outer brackets costs nothing and rescues most of those replies. It is
 * deliberately not a lenient JSON parser: whatever it returns still goes through the schema.
 */
export function firstJsonArray(reply: string): unknown[] | undefined {
  const start = reply.indexOf('[');
  const end = reply.lastIndexOf(']');
  if (start === -1 || end <= start) return undefined;
  try {
    const value: unknown = JSON.parse(reply.slice(start, end + 1));
    return Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a model reply back into questions the contract accepts, and counts what it had to throw
 * away.
 *
 * Item-by-item on purpose: a model that writes five good questions and one with three options has
 * produced a usable quiz, and discarding the whole reply over the sixth would waste it. `discarded`
 * is what keeps that honest — a caller can see the quiz was trimmed, and a rising count over time
 * says the prompt or the model needs attention.
 */
export function parseQuestions(reply: string): { questions: Question[]; discarded: number } {
  const items = firstJsonArray(reply);
  if (!items) return { questions: [], discarded: 0 };
  const questions: Question[] = [];
  let discarded = 0;
  for (const item of items) {
    const parsed = QuizQuestion.safeParse(item);
    if (parsed.success) questions.push(parsed.data);
    else discarded += 1;
  }
  return { questions, discarded };
}
