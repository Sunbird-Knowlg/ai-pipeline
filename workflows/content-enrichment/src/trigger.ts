import { ContentInput } from './schemas.js';
import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { adapters } from './adapters.js';
import { metadata } from './unit.js';

/**
 * `ContentEnrichmentTrigger`: the sink of this workflow's Kafka subscriptions. One handler per Kafka
 * trigger declared in `metadata.json`, each adapting a record and submitting a run.
 */
export const contentEnrichmentTrigger = kafkaTrigger({
  metadata,
  input: ContentInput,
  adapters,
});
