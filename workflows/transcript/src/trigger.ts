import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { contentRunId } from '@ai-pipeline/metadata/run-ids';
import { adapters } from './adapters.js';
import { TranscriptInput } from './schemas.js';
import { metadata } from './unit.js';

/**
 * `TranscriptTrigger`: the sink of this workflow's Kafka subscriptions, one handler per Kafka
 * trigger in `metadata.json` (`content-published` → `contentPublishedEvent`).
 * The control plane creates the subscriptions on deploy; this only adapts records and submits runs.
 *
 * `runKey` keys the run by `identifier` + `artifactHash` instead of the record's own Kafka
 * coordinates, whenever the event actually carries a hash: two records describing the same
 * Content with the same artifact (a redelivered record, or knowlg-publish re-emitting
 * `content-published` for an unrelated metadata edit) collapse onto one workflow execution --
 * Restate's own submission semantics dedupe them, nothing stored, no knowlg write. Returning
 * `undefined` when `artifactHash` is absent (hashing not deployed, or this publish didn't get
 * one) falls back to the default per-record id, same as before this change. This does not
 * serialize two genuinely different videos published back-to-back for the same identifier --
 * see workflow.ts's own doc comment on the deferred Virtual Object fix for that.
 */
export const transcriptTrigger = kafkaTrigger({
  metadata,
  input: TranscriptInput,
  adapters,
  runKey: (input) =>
    input.artifactHash ? contentRunId(input.identifier, input.artifactHash) : undefined,
});
