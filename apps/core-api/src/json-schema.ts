import { Ajv, type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

// ajv-formats is CommonJS: under NodeNext its callable is the `default` export.
const ajv = addFormats.default(new Ajv({ strict: true, allErrors: true, addUsedSchema: false }), [
  'date-time',
  'date',
  'time',
  'uri',
  'email',
  'uuid',
]);
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
