import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { adapters } from './adapters.js';
import { TranscriptInput } from './schemas.js';
import { metadata } from './unit.js';

/**
 * `TranscriptTrigger`: the sink of this workflow's Kafka subscriptions, one handler per Kafka
 * trigger in `metadata.json` (`content-published` → `contentPublishedEvent`).
 * The control plane creates the subscriptions on deploy; this only adapts records and submits runs.
 */
export const transcriptTrigger = kafkaTrigger({
  metadata,
  input: TranscriptInput,
  adapters,
});
