import { describe, expect, it } from 'vitest';
import { chunkDocument } from './chunk.js';
import { chunkingFor } from './plan.js';
import type { ChunkingOptions } from './schemas.js';
import { config } from './unit.js';

/**
 * The chunking options reach Mastra intact, for every strategy and format. These run the real
 * `MDocument` — the point is that what the contract accepts, Mastra 2.6.5 accepts too.
 */

const MARKDOWN = [
  '# Photosynthesis',
  '',
  'Green plants make their own food from sunlight, water and carbon dioxide.',
  '',
  '## Chlorophyll',
  '',
  'Chlorophyll absorbs light. It is what makes leaves green.',
  '',
  '## Stomata',
  '',
  'Leaves breathe through stomata. Carbon dioxide enters and oxygen leaves.',
].join('\n');

const chunk = (options: ChunkingOptions, text = MARKDOWN, format = 'text' as const) =>
  chunkDocument({ text, format, metadata: { lang: 'en' } }, options);

describe('chunkDocument', () => {
  it('recursive: chunks within maxSize that keep their separators and the document metadata', async () => {
    const chunks = await chunk({
      strategy: 'recursive',
      maxSize: 120,
      overlap: 0,
      separatorPosition: 'start',
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(120);
      expect(MARKDOWN).toContain(c.text);
      expect(c.metadata.lang).toBe('en');
    }
  });

  it('recursive with a language: markdown separators split before headings', async () => {
    const chunks = await chunk({
      strategy: 'recursive',
      maxSize: 120,
      overlap: 0,
      language: 'markdown',
      separatorPosition: 'start',
    });
    expect(chunks.some((c) => c.text.startsWith('## Chlorophyll'))).toBe(true);
  });

  it('character: one chunk per separator-delimited piece', async () => {
    const chunks = await chunk({
      strategy: 'character',
      separator: '\n\n',
      maxSize: 500,
      overlap: 0,
    });
    expect(chunks.map((c) => c.text)).toContain('## Stomata');
  });

  it('token: sizes counted in tokens, special tokens passed as a Set', async () => {
    const chunks = await chunk({
      strategy: 'token',
      maxSize: 20,
      overlap: 0,
      encodingName: 'cl100k_base',
      disallowedSpecial: [],
    });
    expect(chunks.length).toBeGreaterThan(2);
  });

  it('markdown with headers: heading text becomes metadata', async () => {
    const chunks = await chunkDocument(
      { text: MARKDOWN, format: 'markdown', metadata: {} },
      {
        strategy: 'markdown',
        headers: [
          ['#', 'h1'],
          ['##', 'h2'],
        ],
      },
    );
    expect(chunks.find((c) => c.text.includes('stomata'))?.metadata).toMatchObject({
      h1: 'Photosynthesis',
      h2: 'Stomata',
    });
  });

  it('semantic-markdown: merges small sections below the join threshold', async () => {
    const chunks = await chunkDocument(
      { text: MARKDOWN, format: 'markdown', metadata: {} },
      { strategy: 'semantic-markdown', joinThreshold: 1000 },
    );
    expect(chunks).toHaveLength(1);
  });

  it('html: sections from the headers asked for', async () => {
    const html =
      '<html><body><h1>Intro</h1><p>First part.</p><h2>Detail</h2><p>Second part.</p></body></html>';
    const chunks = await chunkDocument(
      { text: html, format: 'html', metadata: {} },
      {
        strategy: 'html',
        headers: [
          ['h1', 'h1'],
          ['h2', 'h2'],
        ],
      },
    );
    expect(chunks.map((c) => c.text).join(' ')).toContain('Second part.');
    expect(chunks.some((c) => c.metadata.h2 === 'Detail')).toBe(true);
  });

  it('json: structure-aware chunks of valid JSON within maxSize', async () => {
    const json = JSON.stringify({
      lessons: Array.from({ length: 20 }, (_, i) => ({ id: i, title: `Lesson ${i}` })),
    });
    const chunks = await chunkDocument(
      { text: json, format: 'json', metadata: {} },
      { strategy: 'json', maxSize: 200, minSize: 50 },
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(() => JSON.parse(c.text) as unknown).not.toThrow();
  });

  it('latex: splits on sectioning commands', async () => {
    const latex =
      '\\section{One}\nThe first section has some text in it.\n\\section{Two}\nThe second section too.';
    const chunks = await chunkDocument(
      { text: latex, format: 'latex', metadata: {} },
      { strategy: 'latex', maxSize: 60, overlap: 0 },
    );
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('sentence: whole sentences up to maxSize', async () => {
    const chunks = await chunk({ strategy: 'sentence', maxSize: 90, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(90);
  });

  it('surfaces what Mastra refuses, such as JSON that does not parse', async () => {
    await expect(
      chunkDocument(
        { text: '{not json', format: 'json', metadata: {} },
        { strategy: 'json', maxSize: 100 },
      ),
    ).rejects.toThrow();
  });
});

describe('chunking as planned', () => {
  const html = '<html><body><h1>A</h1><p>Alpha text.</p><h2>B</h2><p>Beta text.</p></body></html>';
  const latex = '\\section{A}\nAlpha text here.\n\\section{B}\nBeta text here.';
  const json = JSON.stringify({ a: Array.from({ length: 10 }, (_, i) => ({ i, t: `item ${i}` })) });

  // The planner adds `separatorPosition: 'start'` to every strategy; Mastra must take it for each.
  const cases: [ChunkingOptions, string, 'text' | 'markdown' | 'html' | 'json' | 'latex'][] = [
    [{ strategy: 'recursive', maxSize: 40, overlap: 0 }, MARKDOWN, 'text'],
    [{ strategy: 'character', maxSize: 40, overlap: 0 }, MARKDOWN, 'text'],
    [{ strategy: 'token', maxSize: 10, overlap: 0 }, MARKDOWN, 'text'],
    [{ strategy: 'markdown', maxSize: 40, overlap: 0 }, MARKDOWN, 'markdown'],
    [{ strategy: 'semantic-markdown', joinThreshold: 5 }, MARKDOWN, 'markdown'],
    [{ strategy: 'html', sections: [['h1', 'h1']], maxSize: 40, overlap: 0 }, html, 'html'],
    [{ strategy: 'json', maxSize: 120 }, json, 'json'],
    [{ strategy: 'latex', maxSize: 40, overlap: 0 }, latex, 'latex'],
    [{ strategy: 'sentence', maxSize: 40 }, MARKDOWN, 'text'],
  ];
  for (const [options, text, format] of cases)
    it(`${options.strategy} takes the planner's separator position`, async () => {
      const planned = chunkingFor(format, options, config.defaults.chunking);
      expect(planned).toMatchObject({ separatorPosition: 'start' });
      await expect(chunkDocument({ text, format, metadata: {} }, planned)).resolves.not.toEqual([]);
    });

  for (const [format, text] of [
    ['html', html],
    ['latex', latex],
    ['markdown', MARKDOWN],
    ['json', json],
  ] as const)
    it(`the default chunking splits a ${format} document`, async () => {
      const planned = chunkingFor(format, undefined, config.defaults.chunking);
      await expect(chunkDocument({ text, format, metadata: {} }, planned)).resolves.not.toEqual([]);
    });
});
