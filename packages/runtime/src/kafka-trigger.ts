import type { TriggerContext } from '@ai-pipeline/contracts/trigger';
import { type KafkaTrigger, type Metadata } from '@ai-pipeline/metadata/metadata';
import { kafkaHandlerName, triggerServiceName } from '@ai-pipeline/metadata/naming';
import { kafkaRunId } from '@ai-pipeline/metadata/run-ids';
import * as restate from '@restatedev/restate-sdk';
import type { z } from 'zod';
import { serviceOptions } from './options.js';

/**
 * Pure mapping from a trigger's event to the workflow's canonical input. Returning `null` drops the
 * record without starting a run.
 *
 * The return type is plain `unknown` because `unknown | null` collapses to `unknown` — the skip
 * contract lives in this comment and in the `=== null` check below, not in the type. Either way the
 * mapped value is validated against the workflow's input schema before a run starts.
 */
export type TriggerAdapter = (event: unknown) => unknown;

export interface KafkaTriggerOptions<I extends z.ZodType> {
  metadata: Metadata;
  /** The workflow's canonical input schema (from its contract). */
  input: I;
  adapters?: Record<string, TriggerAdapter>;
}

export type KafkaTriggerResult = { runId: string; invocationId: string } | { skipped: true };

/**
 * Builds `<Workflow>Trigger`: one handler per Kafka trigger (`on<TriggerId>`), each the sink of
 * that trigger's Restate subscription. A handler adapts the record, derives an opaque run id
 * from documented record coordinates, and submits the workflow. Invalid records fail terminally
 * (logged in Restate, never retried) and do not block the topic.
 */
export function kafkaTrigger<I extends z.ZodType>({
  metadata,
  input,
  adapters = {},
}: KafkaTriggerOptions<I>) {
  const triggers = metadata.triggers.filter((t): t is KafkaTrigger => t.type === 'kafka');
  if (triggers.length === 0) throw new Error(`${metadata.name} declares no kafka triggers`);
  const handlers: Record<string, ReturnType<typeof handlerFor>> = {};
  for (const trigger of triggers) {
    const adapter = trigger.adapter ? adapters[trigger.adapter] : undefined;
    if (trigger.adapter && !adapter)
      throw new Error(`${metadata.name}: adapter "${trigger.adapter}" is not exported`);
    const handler = kafkaHandlerName(trigger.id);
    if (handlers[handler]) throw new Error(`${metadata.name}: duplicate kafka handler ${handler}`);
    handlers[handler] = handlerFor(metadata, trigger, input, adapter);
  }
  return restate.service({
    name: triggerServiceName(metadata.restateName),
    description: `Kafka triggers of ${metadata.restateName}`,
    handlers,
    options: { ...serviceOptions(metadata), ingressPrivate: false },
  });
}

function handlerFor(
  metadata: Metadata,
  trigger: KafkaTrigger,
  input: z.ZodType,
  adapter?: TriggerAdapter,
) {
  return restate.createServiceHandler(
    { input: restate.serde.binary },
    async (ctx: restate.Context, record: Uint8Array): Promise<KafkaTriggerResult> => {
      const headers = ctx.request().headers;
      const partition = decimalHeader(headers, 'kafka.partition');
      const offset = decimalHeader(headers, 'kafka.offset');
      if (partition === undefined || offset === undefined)
        throw new restate.TerminalError('not a Kafka delivery: kafka.partition/offset missing', {
          errorCode: 400,
        });

      let event: unknown;
      try {
        event = JSON.parse(new TextDecoder().decode(record));
      } catch {
        throw new restate.TerminalError('Kafka record is not JSON', { errorCode: 400 });
      }
      let mapped: unknown;
      try {
        mapped = adapter ? adapter(event) : event;
      } catch (error) {
        throw new restate.TerminalError(
          `adapter rejected the Kafka record: ${(error as Error).message}`,
          { errorCode: 400 },
        );
      }
      if (mapped === null) return { skipped: true };
      const parsed = input.safeParse(mapped);
      if (!parsed.success)
        throw new restate.TerminalError(`Kafka record does not match ${metadata.name} input`, {
          errorCode: 400,
          metadata: {
            issues: parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')
              .slice(0, 500),
          },
        });

      const timestamp = decimalHeader(headers, 'kafka.timestamp');
      const trigger_: TriggerContext = {
        type: 'kafka',
        id: trigger.id,
        source: trigger.topic,
        partition: partition.value,
        offset: offset.value,
        receivedAt: timestamp && timestamp.value > 0 ? timestamp.value : await ctx.date.now(),
      };
      // Derived from the exact header text, never the narrowed number: past 2^53 two adjacent
      // offsets round to the same double, and Restate would dedupe the second record as a replay
      // of the first. The run id must distinguish records the broker distinguishes.
      const runId = kafkaRunId({
        cluster: trigger.cluster,
        triggerId: trigger.id,
        topic: trigger.topic,
        partition: partition.text,
        offset: offset.text,
        ...(timestamp ? { timestamp: timestamp.text } : {}),
      });
      const handle = ctx.genericSend({
        service: metadata.restateName,
        method: 'run',
        key: runId,
        parameter: { input: parsed.data, trigger: trigger_ },
        inputSerde: restate.serde.json,
      });
      return { runId, invocationId: await handle.invocationId };
    },
  );
}

/**
 * A non-negative decimal header, or undefined when missing/empty/malformed.
 *
 * Both forms are returned on purpose. `value` is what the trigger context reports, where a number
 * is the contract; `text` is the digits exactly as the broker sent them, which is what identity
 * must be derived from — `Number('9007199254740993')` is `9007199254740992`, so two distinct
 * offsets would otherwise produce one run id.
 */
function decimalHeader(
  headers: ReadonlyMap<string, string>,
  name: string,
): { text: string; value: number } | undefined {
  const raw = headers.get(name);
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined;
  return { text: raw, value: Number(raw) };
}
