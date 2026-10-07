/**
 * Which metadata filters a search may carry.
 *
 * Mastra's PgVector compiles a MongoDB-style filter to SQL over each chunk's `metadata` jsonb. Most
 * operators become an equality, range or membership test. `$regex` compiles to `~`, and a string
 * `$contains` to `ILIKE '%…%'`: pattern scans of every chunk that a public caller should not be able
 * to start. Mastra also accepts shapes that it compiles to the wrong SQL:
 * - a dot path and the same path as nested fields collapse into one key, losing a condition;
 * - `$exists` on a dot path tests a top-level key that cannot exist;
 * - an empty filter inside `$and`/`$or` is invalid SQL;
 * - `$all` matches string elements only (Postgres `?&`), so numbers in it never match;
 * - a `__proto__` key is assigned, not read, and its condition vanishes.
 *
 * Chunk metadata is flat (the document's own metadata, chunking's and extraction's), so dot paths
 * and nested fields could never match anything real. A filter is checked against this whitelist
 * before the query, and anything else fails with a 400 that names its problems.
 *
 * The grammar:
 * - a filter is an object whose entries are ANDed: field conditions, plus `$and`/`$or`/`$nor` (each
 *   a non-empty array of non-empty filters) and `$not` (a non-empty filter);
 * - a field is one metadata key;
 * - a field's condition is a value (equality), an array of values (`$in`), or an object of
 *   operators, which may include `$not` over further operators.
 *
 * Its size is bounded as well. Every condition becomes SQL with bound parameters, and a filtered
 * search scores every chunk the filter matches, so a filter is no place for thousands of terms.
 */

/** Operators that compare one field with a value. */
const COMPARISON = new Set([
  '$eq',
  '$ne',
  '$gt',
  '$gte',
  '$lt',
  '$lte',
  '$in',
  '$nin',
  '$all',
  '$exists',
  '$size',
]);
/** Logical operators that take an array of filters. */
const LIST = new Set(['$and', '$or', '$nor']);

/** How deep objects may nest. The filter itself is level 1, and `{ year: { $gt: 1 } }` is 2. */
export const MAX_FILTER_DEPTH = 8;
/** Field conditions in one filter, each operator counting once. */
export const MAX_FILTER_CONDITIONS = 64;
/** Values across every list in one filter (`$in`, `$nin`, `$all`, a bare array). */
export const MAX_FILTER_VALUES = 1000;
/** Problems reported for one filter; a hostile one would otherwise make a huge error. */
const MAX_PROBLEMS = 20;

/** One metadata key, as Mastra accepts it in a field path: an identifier of at most 63 characters. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
/** Names an object's prototype machinery answers to. The translator assigns them, and they vanish. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

type Scalar = string | number | boolean;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is Scalar =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

const nonEmpty = (value: unknown): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length > 0;

/** What a walk has seen so far. */
interface Walk {
  problems: string[];
  conditions: number;
  values: number;
}

function report(walk: Walk, problem: string): void {
  if (walk.problems.length < MAX_PROBLEMS) walk.problems.push(problem);
}

/** The problems with a filter, each naming where it is; empty when the filter may be used. */
export function filterProblems(filter: Record<string, unknown>): string[] {
  const walk: Walk = { problems: [], conditions: 0, values: 0 };
  checkFilter(filter, 'filter', 1, walk);
  if (walk.conditions > MAX_FILTER_CONDITIONS)
    report(walk, `filter: ${walk.conditions} conditions; at most ${MAX_FILTER_CONDITIONS}`);
  if (walk.values > MAX_FILTER_VALUES)
    report(walk, `filter: ${walk.values} values in lists; at most ${MAX_FILTER_VALUES}`);
  return walk.problems;
}

function refusal(operator: string): string {
  if (operator === '$regex' || operator === '$options' || operator === '$contains')
    return `${operator} is not allowed: it compiles to a pattern scan of every chunk`;
  return `${operator} is not a supported operator (use ${[...COMPARISON].join(' ')}, $not, or ${[...LIST].join(' ')} between filters)`;
}

/**
 * The recursion follows only shapes the grammar allows, and stops at `MAX_FILTER_DEPTH`, so even
 * a hostile filter costs a bounded walk.
 */
function checkFilter(filter: Record<string, unknown>, at: string, depth: number, walk: Walk): void {
  if (depth > MAX_FILTER_DEPTH) {
    report(walk, `${at}: nested deeper than ${MAX_FILTER_DEPTH} levels`);
    return;
  }
  for (const [key, value] of Object.entries(filter)) {
    const here = `${at}.${key}`;
    if (LIST.has(key)) {
      if (!Array.isArray(value) || value.length === 0) {
        report(walk, `${here}: expects a non-empty array of filters`);
        continue;
      }
      value.forEach((item, i) => {
        if (nonEmpty(item)) checkFilter(item, `${here}[${i}]`, depth + 1, walk);
        else report(walk, `${here}[${i}]: expects a non-empty filter object`);
      });
    } else if (key === '$not') {
      if (nonEmpty(value)) checkFilter(value, here, depth + 1, walk);
      else report(walk, `${here}: expects a non-empty filter object`);
    } else if (COMPARISON.has(key)) {
      report(walk, `${here}: ${key} applies to a field, e.g. { "year": { "${key}": … } }`);
    } else if (key.startsWith('$')) {
      report(walk, `${here}: ${refusal(key)}`);
    } else {
      checkField(key, value, here, depth, walk);
    }
  }
}

/** `depth` is the level of the object that holds this field. */
function checkField(key: string, condition: unknown, at: string, depth: number, walk: Walk): void {
  if (UNSAFE_KEYS.has(key) || !KEY.test(key)) {
    report(
      walk,
      `${at}: "${key}" is not a metadata key (letters, digits and "_", at most 63; metadata is flat, so no dot paths)`,
    );
    return;
  }
  if (isScalar(condition)) {
    walk.conditions++;
    return;
  }
  if (Array.isArray(condition)) {
    walk.conditions++;
    checkValues(condition, at, walk);
    return;
  }
  if (!isObject(condition)) {
    report(walk, `${at}: expects a value, an array of values, or an object of operators`);
    return;
  }
  const keys = Object.keys(condition);
  if (keys.length === 0) {
    report(walk, `${at}: an empty condition`);
    return;
  }
  if (depth + 1 > MAX_FILTER_DEPTH) {
    report(walk, `${at}: nested deeper than ${MAX_FILTER_DEPTH} levels`);
    return;
  }
  if (!keys.every((operator) => operator.startsWith('$'))) {
    report(
      walk,
      `${at}: expects operators ($eq, $in, …); metadata is flat, so there are no nested fields`,
    );
    return;
  }
  for (const [operator, operand] of Object.entries(condition)) {
    const here = `${at}.${operator}`;
    if (operator === '$not') {
      if (!nonEmpty(operand)) {
        report(walk, `${here}: expects a non-empty object of operators`);
        continue;
      }
      for (const [inner, innerOperand] of Object.entries(operand))
        if (COMPARISON.has(inner)) checkOperand(inner, innerOperand, `${here}.${inner}`, walk);
        else report(walk, `${here}.${inner}: $not takes comparison operators only`);
    } else if (COMPARISON.has(operator)) {
      checkOperand(operator, operand, here, walk);
    } else if (LIST.has(operator)) {
      report(
        walk,
        `${here}: ${operator} combines filters, so it belongs beside fields, not in one`,
      );
    } else {
      report(walk, `${here}: ${refusal(operator)}`);
    }
  }
}

function checkValues(values: unknown[], at: string, walk: Walk): void {
  walk.values += values.length;
  if (!values.every(isScalar))
    report(walk, `${at}: expects an array of strings, numbers or booleans`);
}

function checkOperand(operator: string, operand: unknown, at: string, walk: Walk): void {
  walk.conditions++;
  switch (operator) {
    case '$eq':
    case '$ne':
      if (!isScalar(operand) && operand !== null)
        report(walk, `${at}: expects a string, a number, a boolean or null`);
      return;
    case '$gt':
    case '$gte':
    case '$lt':
    case '$lte':
      if (typeof operand !== 'number' && typeof operand !== 'string')
        report(walk, `${at}: expects a number or a string`);
      return;
    case '$in':
    case '$nin':
      if (Array.isArray(operand)) checkValues(operand, at, walk);
      else report(walk, `${at}: expects an array of strings, numbers or booleans`);
      return;
    case '$all':
      // Postgres `?&` matches string elements only: a number in the list could never match.
      if (Array.isArray(operand) && operand.every((value) => typeof value === 'string'))
        walk.values += operand.length;
      else report(walk, `${at}: expects an array of strings (it matches string elements only)`);
      return;
    case '$exists':
      if (typeof operand !== 'boolean') report(walk, `${at}: expects true or false`);
      return;
    case '$size':
      if (!Number.isInteger(operand) || (operand as number) < 0)
        report(walk, `${at}: expects a non-negative integer`);
      return;
    default:
      report(walk, `${at}: ${refusal(operator)}`);
  }
}
