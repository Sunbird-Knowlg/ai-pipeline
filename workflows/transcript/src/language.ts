const englishLanguageNames = new Intl.DisplayNames(['en'], { type: 'language' });

/**
 * English display name for an ISO 639 language code (`hi` -> `Hindi`), for the Transcript's
 * `language` field. Whisper and the target-language config only ever give the code.
 * Falls back to the upper-cased code when the runtime has no name for it, so the field is never empty.
 * Deterministic, no I/O — safe to call directly in a handler body, never inside `ctx.run`.
 */
export function languageName(code: string): string {
  try {
    return englishLanguageNames.of(code) ?? code.toUpperCase();
  } catch {
    // `of()` throws a RangeError on a structurally invalid code.
    return code.toUpperCase();
  }
}
