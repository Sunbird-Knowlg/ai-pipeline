import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { adapters } from './adapters.js';
import { ContentAuthoringInput } from './schemas.js';
import { metadata } from './unit.js';

/**
 * `ContentAuthoringTrigger`: the sink of this workflow's Kafka subscriptions, one handler per Kafka
 * trigger in `metadata.json` (`diksha-content-published` → `onDikshaContentPublished`). The control
 * plane creates the subscriptions on deploy; this only adapts records and submits runs.
 *
 * The run id is derived from the record's coordinates (cluster, topic, partition, offset,
 * timestamp), so a redelivered record lands on the same run and Restate deduplicates it.
 */
export const contentAuthoringTrigger = kafkaTrigger({
  metadata,
  input: ContentAuthoringInput,
  adapters,
});
