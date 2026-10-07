import { describe, expect, it } from 'vitest';
import {
  MAX_FILTER_CONDITIONS,
  MAX_FILTER_DEPTH,
  MAX_FILTER_VALUES,
  filterProblems,
} from './filter.js';

describe('filterProblems', () => {
  it('accepts every whitelisted operator in the places Mastra reads them', () => {
    const filters: Record<string, unknown>[] = [
      {},
      { lang: 'en', year: 2024, draft: false },
      { tags: ['a', 'b'] },
      {
        year: { $gte: 2020, $lt: 2025 },
        rank: { $gt: 1, $lte: 9 },
        lang: { $eq: 'en', $ne: 'fr' },
        missing: { $eq: null },
      },
      { tags: { $in: ['a'], $nin: ['b'], $all: ['a', 'c'], $size: 2 } },
      { author: { $exists: true }, editor: { $exists: false } },
      { $and: [{ lang: 'en' }, { $or: [{ year: { $gt: 2020 } }, { tags: { $in: ['x'] } }] }] },
      { $nor: [{ lang: 'fr' }, { draft: true }] },
      { $not: { lang: 'fr' } },
      { year: { $not: { $lt: 2000, $in: [2010] } } },
    ];
    for (const filter of filters)
      expect(filterProblems(filter), JSON.stringify(filter)).toEqual([]);
  });

  it('refuses the operators that compile to a pattern scan of every chunk', () => {
    expect(filterProblems({ title: { $regex: '^Photo' } })).toEqual([
      'filter.title.$regex: $regex is not allowed: it compiles to a pattern scan of every chunk',
    ]);
    expect(filterProblems({ title: { $contains: 'photo' } })[0]).toMatch(
      /^filter\.title\.\$contains: \$contains is not allowed/,
    );
    expect(filterProblems({ title: { $regex: 'x', $options: 'i' } })).toHaveLength(2);
  });

  it('refuses any other $-key, wherever it is', () => {
    expect(filterProblems({ tags: { $elemMatch: { $eq: 'a' } } })[0]).toMatch(
      /^filter\.tags\.\$elemMatch: \$elemMatch is not a supported operator/,
    );
    expect(filterProblems({ $where: 'sleep(10)' })[0]).toMatch(/^filter\.\$where: /);
    expect(filterProblems({ $and: [{ $text: 'x' }] })[0]).toMatch(/^filter\.\$and\[0\]\.\$text: /);
    expect(filterProblems({ year: { $not: { $regex: 'x' } } })).toEqual([
      'filter.year.$not.$regex: $not takes comparison operators only',
    ]);
  });

  it('puts comparisons on fields and logical operators between filters', () => {
    expect(filterProblems({ $gt: 3 })[0]).toMatch(/^filter\.\$gt: \$gt applies to a field/);
    expect(filterProblems({ year: { $or: [{ $gt: 1 }] } })[0]).toMatch(
      /^filter\.year\.\$or: \$or combines filters/,
    );
    expect(filterProblems({ $and: { lang: 'en' } })).toEqual([
      'filter.$and: expects a non-empty array of filters',
    ]);
    expect(filterProblems({ $or: ['en'] })).toEqual([
      'filter.$or[0]: expects a non-empty filter object',
    ]);
    expect(filterProblems({ $not: {} })).toEqual([
      'filter.$not: expects a non-empty filter object',
    ]);
    expect(filterProblems({ year: { $not: { $not: { $eq: 1 } } } })).toEqual([
      'filter.year.$not.$not: $not takes comparison operators only',
    ]);
    expect(filterProblems({ year: { $gt: 1, month: 2 } })).toEqual([
      'filter.year: expects operators ($eq, $in, …); metadata is flat, so there are no nested fields',
    ]);
  });

  it('checks each operand', () => {
    expect(
      filterProblems({
        a: { $eq: ['x'] },
        b: { $gt: { x: 1 } },
        c: { $in: 'x' },
        d: { $nin: [['nested']] },
        e: { $exists: 'yes' },
        f: { $size: -1 },
        g: { $size: 1.5 },
        h: null,
        i: [{ x: 1 }],
        j: {},
      }),
    ).toEqual([
      'filter.a.$eq: expects a string, a number, a boolean or null',
      'filter.b.$gt: expects a number or a string',
      'filter.c.$in: expects an array of strings, numbers or booleans',
      'filter.d.$nin: expects an array of strings, numbers or booleans',
      'filter.e.$exists: expects true or false',
      'filter.f.$size: expects a non-negative integer',
      'filter.g.$size: expects a non-negative integer',
      'filter.h: expects a value, an array of values, or an object of operators',
      'filter.i: expects an array of strings, numbers or booleans',
      'filter.j: an empty condition',
    ]);
  });

  it('accepts only flat metadata keys as fields', () => {
    for (const key of [
      'content-type',
      '1st',
      'source.lang',
      'a..b',
      "x'; DROP TABLE t; --",
      'k'.repeat(64),
    ])
      expect(filterProblems({ [key]: 'v' }), key).toEqual([
        `filter.${key}: "${key}" is not a metadata key (letters, digits and "_", at most 63; metadata is flat, so no dot paths)`,
      ]);
    expect(filterProblems({ k: 'v', ['k'.repeat(63)]: 'v', _private: 1 })).toEqual([]);
  });

  it('refuses the shapes Mastra compiles to the wrong SQL', () => {
    // A dot path and nested fields would collapse into one key, losing a condition.
    expect(filterProblems({ source: { lang: 'fr' } })[0]).toMatch(/there are no nested fields/);
    // An empty filter inside a list compiles to `WHERE ()`.
    expect(filterProblems({ $and: [{}] })).toEqual([
      'filter.$and[0]: expects a non-empty filter object',
    ]);
    expect(filterProblems({ $or: [{}, { lang: 'en' }] })).toHaveLength(1);
    expect(filterProblems({ $nor: [] })).toEqual([
      'filter.$nor: expects a non-empty array of filters',
    ]);
    // `?&` matches string elements only.
    expect(filterProblems({ grades: { $all: [7] } })).toEqual([
      'filter.grades.$all: expects an array of strings (it matches string elements only)',
    ]);
  });

  it('refuses keys that name prototype machinery, which the translator would drop', () => {
    // As JSON.parse builds them: an own `__proto__` property.
    const parsed = JSON.parse('{"$and":[{"__proto__":"x","lang":"en"}]}') as Record<
      string,
      unknown
    >;
    expect(filterProblems(parsed)).toEqual([
      'filter.$and[0].__proto__: "__proto__" is not a metadata key (letters, digits and "_", at most 63; metadata is flat, so no dot paths)',
    ]);
    expect(filterProblems({ constructor: 'x' })).toHaveLength(1);
    expect(filterProblems({ prototype: 'x' })).toHaveLength(1);
  });

  it(`bounds a filter's size: ${MAX_FILTER_CONDITIONS} conditions, ${MAX_FILTER_VALUES} listed values`, () => {
    const conditions = (n: number) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`k${i}`, i]));
    expect(filterProblems(conditions(MAX_FILTER_CONDITIONS))).toEqual([]);
    expect(filterProblems(conditions(MAX_FILTER_CONDITIONS + 1))).toEqual([
      `filter: ${MAX_FILTER_CONDITIONS + 1} conditions; at most ${MAX_FILTER_CONDITIONS}`,
    ]);
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`);
    expect(filterProblems({ a: values(MAX_FILTER_VALUES) })).toEqual([]);
    expect(filterProblems({ a: { $in: values(600) }, b: { $all: values(401) } })).toEqual([
      `filter: ${MAX_FILTER_VALUES + 1} values in lists; at most ${MAX_FILTER_VALUES}`,
    ]);
    // A wide `$or` is many conditions, and its problems are reported a bounded number of times.
    const wide = { $or: Array.from({ length: 100_000 }, () => ({ lang: { $regex: 'x' } })) };
    expect(filterProblems(wide).length).toBeLessThanOrEqual(21);
  });

  it(`stops at ${MAX_FILTER_DEPTH} levels of nesting`, () => {
    const nested = (levels: number): Record<string, unknown> => {
      let filter: Record<string, unknown> = { lang: 'en' };
      for (let i = 1; i < levels; i++) filter = { $and: [filter] };
      return filter;
    };
    expect(filterProblems(nested(MAX_FILTER_DEPTH))).toEqual([]);
    expect(filterProblems(nested(MAX_FILTER_DEPTH + 1))).toEqual([
      `filter${'.$and[0]'.repeat(MAX_FILTER_DEPTH)}: nested deeper than ${MAX_FILTER_DEPTH} levels`,
    ]);
    // A field's operators are a level of their own: { k: { $eq: 1 } } at the bottom is one more.
    let fielded: Record<string, unknown> = { k: { $eq: 1 } };
    for (let i = 2; i < MAX_FILTER_DEPTH; i++) fielded = { $and: [fielded] };
    expect(filterProblems(fielded)).toEqual([]);
    expect(filterProblems({ $and: [fielded] })[0]).toMatch(/nested deeper than/);
  });

  it('walks a hostile filter in bounded time and reports it once', () => {
    let filter: Record<string, unknown> = { lang: 'en' };
    for (let i = 0; i < 50_000; i++) filter = { $or: [filter] };
    expect(filterProblems(filter)).toHaveLength(1);
  });

  it('names every problem, not just the first', () => {
    expect(
      filterProblems({ $and: [{ a: { $regex: 'x' } }, { 'b-c': 1 }], d: { $exists: 1 } }),
    ).toHaveLength(3);
  });
});
