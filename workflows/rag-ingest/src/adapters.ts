import { mappedAdapter } from './mapping.js';
import type { RagIngestInput } from './schemas.js';
import { config } from './unit.js';

/**
 * Trigger adapters, one per `eventMappings` entry in `metadata.json`. A Kafka trigger names one
 * with `"adapter"`; a trigger without one takes canonical `RagIngestInput` records as they are.
 *
 * Built from configuration rather than written per producer, so a new source — a topic, an event
 * shape, a target collection — is a `metadata.json` change. `kafkaTrigger` refuses to boot if a
 * trigger names an adapter that is not here.
 */
export const adapters: Record<string, (event: unknown) => RagIngestInput | null> =
  Object.fromEntries(
    Object.entries(config.eventMappings).map(([name, mapping]) => [name, mappedAdapter(mapping)]),
  );
