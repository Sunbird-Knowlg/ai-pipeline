import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContractEntry } from './entry.js';

export interface ContractSchemas {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** Minimal shape of the zod internals this file reads; `.refine()` records a `custom` check. */
interface ZodChecked {
  _zod?: { def?: { checks?: { _zod?: { def?: { check?: string } } }[]; check?: string } };
}

const hasRefinement = (schema: unknown): boolean =>
  ((schema as ZodChecked)._zod?.def?.checks ?? []).some(
    (check) => check._zod?.def?.check === 'custom',
  );

/**
 * A JSON Schema pointer read back as the field path the developer wrote:
 * `properties.a.properties.b.items` → `a.b[]`. The error is about their zod schema, so it should
 * name their field, not the generated document.
 */
function fieldPath(path: readonly (string | number)[]): string {
  const parts: string[] = [];
  for (const segment of path) {
    if (segment === 'properties') continue;
    if (segment === 'items' || segment === 'additionalProperties') {
      parts.push(`${parts.pop() ?? ''}[]`);
      continue;
    }
    parts.push(String(segment));
  }
  return parts.length > 0 ? parts.join('.') : '(root)';
}

/**
 * Draft-07 JSON Schemas (what Ajv's default class compiles), without the `$schema` marker.
 *
 * A contract that JSON Schema cannot express is refused here rather than silently narrowed.
 * `z.toJSONSchema` drops `.refine()`/`.superRefine()` without a word, and the consequences are
 * worse than they look: the core API would accept a request with `202` against the published
 * schema that the handler's own Standard Schema serde then rejects, so a caller is told the run
 * started and finds it failed. And because `contractHash` is computed over this output, two
 * contracts differing only in a refinement hash identically — so `VERSION_CONTRACT_CONFLICT`
 * could never fire between them.
 *
 * The traversal is zod's own (`override` is called for every node), so nested refinements are
 * found too, and the error names the path.
 */
export function contractSchemas(entry: ContractEntry): ContractSchemas {
  const json = (schema: z.ZodType, io: 'input' | 'output', which: string) => {
    const refined: string[] = [];
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      target: 'draft-07',
      io,
      override: ({ zodSchema, path }) => {
        if (hasRefinement(zodSchema)) refined.push(fieldPath(path));
      },
    });
    if (refined.length > 0)
      throw new Error(
        `the ${which} schema uses .refine()/.superRefine() at ${refined.join(', ')}, which JSON Schema ` +
          'cannot express: the catalogue would publish a weaker contract than the handler enforces. ' +
          'Express the rule with a built-in constraint (min/max/regex/enum), or move it into the handler ' +
          'and throw a TerminalError.',
      );
    return rest as Record<string, unknown>;
  };
  return {
    input: json(entry.input, 'input', 'input'),
    output: json(entry.output, 'output', 'output'),
    config: json(entry.config, 'input', 'config'),
  };
}

/** sha256 over canonical (key-sorted) JSON of the schemas. */
export function contractHash(schemas: ContractSchemas): string {
  return `sha256:${createHash('sha256').update(canonicalJson(schemas)).digest('hex')}`;
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
