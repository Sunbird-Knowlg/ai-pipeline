import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { adapters } from './adapters.js';
import { TranscriptInput } from './schemas.js';
import { metadata } from './unit.js';

/**
 * `TranscriptTrigger`: the sink of this workflow's Kafka subscriptions, one handler per Kafka
 * trigger in `metadata.json`. The control plane creates the subscriptions; this only adapts records.
 */
export const transcriptTrigger = kafkaTrigger({ metadata, input: TranscriptInput, adapters });
