import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ContractEntry } from './entry.js';

export interface ContractSchemas {
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** Draft-07 JSON Schemas (what Ajv's default class compiles), without the `$schema` marker. */
export function contractSchemas(entry: ContractEntry): ContractSchemas {
  const json = (schema: z.ZodType, io: 'input' | 'output') => {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, { target: 'draft-07', io });
    return rest as Record<string, unknown>;
  };
  return {
    input: json(entry.input, 'input'),
    output: json(entry.output, 'output'),
    config: json(entry.config, 'input'),
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
