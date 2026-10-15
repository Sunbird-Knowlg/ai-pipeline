import { describe, expect, it } from 'vitest';
import { languageName } from './language.js';

describe('languageName', () => {
  it('returns the English name for an ISO 639-1 code', () => {
    expect(languageName('hi')).toBe('Hindi');
    expect(languageName('fr')).toBe('French');
    expect(languageName('ar')).toBe('Arabic');
  });

  it('falls back to the upper-cased code when the code is not a valid language tag', () => {
    expect(languageName('not a code')).toBe('NOT A CODE');
  });

  it('never returns an empty string', () => {
    expect(languageName('zz').length).toBeGreaterThan(0);
  });
});
