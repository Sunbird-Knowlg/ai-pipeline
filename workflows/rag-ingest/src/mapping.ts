import type { Condition, EventMapping, RagIngestInput } from './schemas.js';

/**
 * Config-driven Kafka adapters: a producer's event, read through the paths of an `EventMapping`,
 * becomes this workflow's canonical input. Pure, like every adapter — the same event always maps the
 * same way, and the trigger runs it outside any `ctx.run`.
 */

/** The value at a dot path (`edata.name`, `tags[0]`), or undefined if any step is missing. */
export function readPath(event: unknown, path: string): unknown {
  let current: unknown = event;
  for (const [, key, index] of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) {
    if (current === null || typeof current !== 'object') return undefined;
    if (index !== undefined) {
      if (!Array.isArray(current)) return undefined;
      current = (current as unknown[])[Number(index)];
    } else current = (current as Record<string, unknown>)[key!];
  }
  return current;
}

function holds(event: unknown, condition: Condition): boolean {
  const value = readPath(event, condition.path);
  if ('equals' in condition) return value === condition.equals;
  if ('in' in condition) return (condition.in as unknown[]).includes(value);
  return (value !== undefined && value !== null) === condition.exists;
}

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';

/** A non-empty string at `path`; numbers are accepted as ids. */
function text(event: unknown, path: string): string | undefined {
  const value = readPath(event, path);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** A version: a non-negative integer, or an ISO date read as epoch milliseconds. */
function version(event: unknown, path: string): number | undefined {
  const value = readPath(event, path);
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) return Number(value);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  throw new Error(`version at "${path}" is not a non-negative integer or an ISO date`);
}

/**
 * The adapter for one mapping. Three outcomes, as for every trigger adapter:
 *
 * - `null` — `when` does not hold: not this mapping's event; no run, no error;
 * - throws — the event is ours but broken (no id, no text): failed terminally, never retried;
 * - the canonical input — an upsert of one document, or its delete when `deleteWhen` holds.
 */
export function mappedAdapter(mapping: EventMapping): (event: unknown) => RagIngestInput | null {
  return (event) => {
    if (!mapping.when.every((condition) => holds(event, condition))) return null;

    const documentId = text(event, mapping.documentId);
    if (documentId === undefined)
      throw new Error(`the event has no document id at "${mapping.documentId}"`);
    const documentVersion = mapping.version ? version(event, mapping.version) : undefined;
    if (mapping.deleteWhen?.every((condition) => holds(event, condition)))
      // The delete is ordered like the writes it races with: by the event's version, if it has one.
      return {
        operation: 'delete',
        collection: mapping.collection,
        documentIds: [documentId],
        ...(documentVersion !== undefined ? { version: documentVersion } : {}),
      };

    const paths = Array.isArray(mapping.text) ? mapping.text : [mapping.text];
    const parts = paths.map((path) => text(event, path)).filter((part) => part !== undefined);
    if (parts.length === 0)
      throw new Error(`event ${documentId} carries no text at ${paths.join(', ')}`);

    const metadata: Record<string, string | number | boolean | (string | number | boolean)[]> = {};
    for (const [key, path] of Object.entries(mapping.metadata)) {
      const value = readPath(event, path);
      if (isScalar(value)) metadata[key] = value;
      else if (Array.isArray(value) && value.every(isScalar)) metadata[key] = value.slice(0, 64);
    }
    const title = mapping.title ? text(event, mapping.title) : undefined;

    return {
      operation: 'upsert',
      collection: mapping.collection,
      ...(mapping.collectionSettings ? { collectionSettings: mapping.collectionSettings } : {}),
      documents: [
        {
          id: documentId,
          text: parts.join('\n\n'),
          format: mapping.format,
          ...(title ? { title } : {}),
          metadata,
          ...(documentVersion !== undefined ? { version: documentVersion } : {}),
        },
      ],
      ...(mapping.options ? { options: mapping.options } : {}),
    };
  };
}
