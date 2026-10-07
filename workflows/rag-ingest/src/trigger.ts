import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { adapters } from './adapters.js';
import { RagIngestInput } from './schemas.js';
import { metadata } from './unit.js';

/**
 * `RagIngestTrigger`: the sink of this workflow's Kafka subscriptions, one handler per Kafka trigger
 * in `metadata.json`. A trigger with an `adapter` maps its events through that `eventMappings`
 * entry; one without takes canonical `RagIngestInput` records. The run id comes from the record's
 * coordinates, so a redelivered record lands on the same run.
 */
export const ragIngestTrigger = kafkaTrigger({ metadata, input: RagIngestInput, adapters });
