/**
 * The prompt this service sends. Kept apart from the handler so it can be reviewed and tested as
 * text: a prompt is behaviour, and a careless edit changes every summary the pipeline produces.
 */

export const SUMMARY_SYSTEM =
  'You write faithful, neutral summaries. Use only facts from the text. Reply with the summary only.';

/** The text is delimited so that instructions inside it read as content, not as direction. */
export const summaryPrompt = (text: string, maxWords: number): string =>
  `Summarise the following text in at most ${maxWords} words.\n\n<text>\n${text}\n</text>`;
