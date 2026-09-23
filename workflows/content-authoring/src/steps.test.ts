import { describe, expect, it } from 'vitest';
import { ContentAuthoringInput } from './schemas.js';
import { authoringText, textStats } from './steps.js';

const input = (over: Partial<ContentAuthoringInput> = {}): ContentAuthoringInput =>
  ContentAuthoringInput.parse({
    contentId: 'do_1',
    name: 'Photosynthesis',
    text: 'Plants make food from light.',
    ...over,
  });

describe('authoringText', () => {
  it('puts the title first, then the blurb, then the body', () => {
    expect(authoringText(input({ description: 'How green plants make food' }))).toBe(
      'Photosynthesis\n\nHow green plants make food\n\nPlants make food from light.',
    );
  });

  it('leaves no blank gap when there is no description', () => {
    expect(authoringText(input())).toBe('Photosynthesis\n\nPlants make food from light.');
  });

  it('is pure: the same input gives the same text every time it replays', () => {
    const one = input({ description: 'd' });
    expect(authoringText(one)).toBe(authoringText(one));
  });
});

describe('textStats', () => {
  it('counts words across any whitespace', () => {
    expect(textStats('  one two\nthree  ')).toEqual({ wordCount: 3, readingTimeMinutes: 0 });
    expect(textStats('   ')).toEqual({ wordCount: 0, readingTimeMinutes: 0 });
  });

  it('reports reading time at 200 words a minute, to a tenth', () => {
    expect(textStats('w '.repeat(200)).readingTimeMinutes).toBe(1);
    expect(textStats('w '.repeat(650)).readingTimeMinutes).toBe(3.3);
  });
});
