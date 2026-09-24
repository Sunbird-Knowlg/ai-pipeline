import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { kafkaHandlerName } from './naming.js';

const name = z
  .string()
  .max(63)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'lower-case kebab identifier');
const restateName = z.string().regex(/^[A-Z][A-Za-z0-9]{0,62}$/, 'PascalCase Restate service name');
const semver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'semantic version');

export const restTriggerSchema = z.strictObject({ id: name, type: z.literal('rest') });

export const kafkaTriggerSchema = z.strictObject({
  id: name,
  type: z.literal('kafka'),
  /** Kafka cluster name as registered in Restate (`POST /kafka-clusters`). */
  cluster: name,
  topic: z.string().regex(/^[A-Za-z0-9._-]{1,249}$/),
  /** Named export of the workflow's trigger adapters; mapping event → workflow input. */
  adapter: z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9]*$/)
    .optional(),
});

export const triggerSchema = z.discriminatedUnion('type', [restTriggerSchema, kafkaTriggerSchema]);

export const dependencySchema = z.strictObject({
  kind: z.enum(['service', 'workflow']),
  name,
});

/**
 * `metadata.json`: operational metadata of one deployable unit. Input/output/config
 * schemas are NOT here — they come from the unit's contract in `@ai-pipeline/contracts`.
 */
export const metadataSchema = z
  .strictObject({
    $schema: z.string().optional(),
    apiVersion: z.literal('ai-pipeline/v1alpha1'),
    kind: z.enum(['workflow', 'service']),
    name,
    restateName,
    version: semver,
    description: z.string().max(2000).default(''),
    visibility: z.enum(['public', 'private']).default('public'),
    config: z.record(z.string(), z.unknown()).default({}),
    triggers: z.array(triggerSchema).max(32).default([]),
    dependencies: z.array(dependencySchema).max(32).default([]),
  })
  .superRefine((m, ctx) => {
    const ids = new Set<string>();
    for (const t of m.triggers) {
      if (ids.has(t.id))
        ctx.addIssue({ code: 'custom', message: `duplicate trigger id "${t.id}"` });
      ids.add(t.id);
    }
    const handlers = new Set<string>();
    for (const t of m.triggers)
      if (t.type === 'kafka') {
        const handler = kafkaHandlerName(t.id);
        if (handlers.has(handler))
          ctx.addIssue({
            code: 'custom',
            message: `kafka triggers map to the same handler ${handler}`,
          });
        handlers.add(handler);
      }
    const deps = new Set<string>();
    for (const d of m.dependencies) {
      if (deps.has(d.name))
        ctx.addIssue({ code: 'custom', message: `duplicate dependency "${d.name}"` });
      deps.add(d.name);
    }
    // The REST start path resolves one trigger (`triggers.find(t => t.type === 'rest')` in the core
    // API's `startRun`), so a second one would be silently unreachable. Refuse it here rather than
    // adding a way to choose between them: there is one REST surface per workflow.
    if (m.triggers.filter((t) => t.type === 'rest').length > 1)
      ctx.addIssue({ code: 'custom', message: 'a unit declares at most one rest trigger' });
    if (m.kind !== 'workflow' && m.triggers.length > 0)
      ctx.addIssue({ code: 'custom', message: 'only workflows declare triggers in v1' });
    if (m.visibility === 'private' && m.triggers.length > 0)
      ctx.addIssue({ code: 'custom', message: 'a private unit cannot declare triggers' });
  });

export type Metadata = z.infer<typeof metadataSchema>;
export type Trigger = z.infer<typeof triggerSchema>;
export type KafkaTrigger = z.infer<typeof kafkaTriggerSchema>;
export type Dependency = z.infer<typeof dependencySchema>;

export function parseMetadata(value: unknown): Metadata {
  const result = metadataSchema.safeParse(value);
  if (!result.success) throw new Error(`invalid metadata.json: ${z.prettifyError(result.error)}`);
  return result.data;
}

/** Reads and validates a package's `metadata.json` (shipped next to `dist/`). */
export function loadMetadata(url: URL): Metadata {
  return parseMetadata(JSON.parse(readFileSync(url, 'utf8')));
}
