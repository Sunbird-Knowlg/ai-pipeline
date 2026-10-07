import { describe, expect, it } from 'vitest';
import { memoryRagStore } from './memory.js';
import { storable } from './store.js';
import { storeContract } from './testing/store-contract.js';

storeContract(
  'memory',
  (() => {
    const store = memoryRagStore();
    return () => store;
  })(),
);

describe('storable', () => {
  it('drops NUL characters and replaces unpaired surrogates, deeply, keys included', () => {
    expect(storable('a\u0000b')).toBe('ab');
    expect(storable('\ud800x\udc00')).toBe('�x�');
    expect(storable('😀')).toBe('😀'); // a real pair is kept
    expect(storable({ 'k\u0000': ['v\u0000', 1, true, null, { n: '\ud800' }] })).toEqual({
      k: ['v', 1, true, null, { n: '�' }],
    });
  });
});
