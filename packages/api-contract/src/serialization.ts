import { z } from 'zod';

/**
 * Turns a response schema into the draft-07 JSON Schema Fastify compiles for serialization.
 *
 * Two consequences worth knowing:
 *  - it is a contract check — a field the schema does not describe never reaches the client, so a
 *    route and its schema cannot drift apart unnoticed;
 *  - `fast-json-stringify` is measurably faster than `JSON.stringify` on a known shape.
 *
 * `io: 'output'` matters: it resolves defaults and transforms the way a *response* sees them, so an
 * optional-with-default field is described as present.
 */
export function responseSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _ignored, ...json } = z.toJSONSchema(schema, {
    target: 'draft-07',
    io: 'output',
    // A response may legitimately carry a unit's own JSON (workflow input/output, a trigger
    // envelope, a generated JSON Schema). Those are `unknown` in the contract; describe them as
    // "any JSON" rather than failing to convert.
    unrepresentable: 'any',
  });
  return json;
}
