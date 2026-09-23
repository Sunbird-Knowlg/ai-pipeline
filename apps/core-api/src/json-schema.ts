import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import { RE2JS } from 're2js';

/**
 * `pattern` is evaluated by a linear-time engine, not by JavaScript's.
 *
 * Catalogued schemas are caller-supplied — `POST /v1/deployments` submits them, and every
 * `POST /v1/workflows/:name/runs` then validates a caller's input against one. With the native
 * `RegExp`, a pattern like `^(a+)+$` against a 30-character subject backtracks for ~25 seconds, and
 * Node is single-threaded: that blocks every other request, `/health/ready` included, and no
 * timeout helps because nothing is waiting on I/O. The same pattern and subject return in about a
 * millisecond here.
 *
 * The trade is that RE2 refuses backreferences and lookaround. Those are precisely the constructs
 * that make a regex super-linear, nothing zod generates uses them, and a contract that does is
 * refused at deploy time with the parser's own message rather than accepted and weaponised later.
 */
const linearTimeRegExp = Object.assign(
  (pattern: string, flags: string) => {
    const compiled = RE2JS.compile(pattern);
    return {
      // JSON Schema `pattern` is an unanchored search, which is what `find()` does. A fresh matcher
      // per call because `find()` resumes from the previous match.
      test: (value: string) => compiled.matcher(value).find(),
      // Ajv keys its scope of compiled patterns on `String(engine(pattern, flags))`, so this must
      // differ per pattern the way a RegExp's does. Returning the default `[object Object]` makes
      // every pattern in the process share whichever one was compiled first.
      toString: () => `/${pattern}/${flags}`,
    };
  },
  { code: 'new RegExp' },
);

// ajv-formats is CommonJS: under NodeNext its callable is the `default` export.
const ajv = addFormats.default(
  new Ajv({
    strict: true,
    allErrors: true,
    addUsedSchema: false,
    code: { regExp: linearTimeRegExp },
  }),
  ['date-time', 'date', 'time', 'uri', 'email', 'uuid'],
);
const cache = new Map<string, ValidateFunction>();

/** Compiles (and caches by contract hash) a draft-07 schema from the catalogue. */
export function validator(key: string, schema: object): ValidateFunction {
  let fn = cache.get(key);
  if (!fn) {
    fn = ajv.compile(schema);
    cache.set(key, fn);
  }
  return fn;
}

export function compileOrThrow(schema: object): void {
  ajv.compile(schema);
}

/** One-off validation (not cached); returns a readable error summary or undefined. */
export function validateOnce(schema: object, value: unknown): string | undefined {
  const validate = ajv.compile(schema);
  if (validate(value)) return undefined;
  return (validate.errors ?? [])
    .slice(0, 10)
    .map((e) => `${e.instancePath || '(root)'} ${e.message}`)
    .join('; ');
}
