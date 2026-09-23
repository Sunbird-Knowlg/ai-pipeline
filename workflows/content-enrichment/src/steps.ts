/** Steps: deterministic helpers that run inside the workflow's handler (not catalogued). */
export function textStats(text: string) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length;
  return {
    wordCount,
    charCount: text.length,
    readingTimeMinutes: Math.round((wordCount / 200) * 10) / 10,
  };
}
