import { describe, expect, it } from 'vitest';
import { chunkId, fingerprint, renderTemplate, tableName } from './ids.js';

describe('chunkId', () => {
  it('is a deterministic, UUID-shaped id per (collection, document, index)', () => {
    const id = chunkId('c1', 'doc', 0);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(chunkId('c1', 'doc', 0)).toBe(id);
    expect(
      new Set([id, chunkId('c1', 'doc', 1), chunkId('c2', 'doc', 0), chunkId('c1', 'do', 0)]).size,
    ).toBe(4);
  });
});

describe('fingerprint', () => {
  it('ignores key order and sees every value', () => {
    expect(fingerprint({ a: 1, b: [1, 2] })).toBe(fingerprint({ b: [1, 2], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
    expect(fingerprint({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('tableName', () => {
  it('is a short SQL identifier taken from the incarnation', () => {
    expect(tableName('3F2A9B1C-0D4E-4F5A-8B6C-7D8E9F0A1B2C')).toBe('c_3f2a9b1c0d4e4f5a');
    expect(() => tableName('short')).toThrow(/entropy/);
  });
});

describe('renderTemplate', () => {
  it('fills placeholders, joins arrays, and trims what a missing value leaves behind', () => {
    expect(renderTemplate('{title}\n\n{text}', { text: 'body' })).toBe('body');
    expect(renderTemplate('{title}\n\n{text}', { title: 'T', text: 'body' })).toBe('T\n\nbody');
    expect(renderTemplate('{k}: {n} {b}', { k: ['a', 'b'], n: 3, b: false })).toBe('a, b: 3 false');
    expect(renderTemplate('Query: {query}', { query: 'x', unused: 1 })).toBe('Query: x');
  });
});
