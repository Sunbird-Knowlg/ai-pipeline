import type { Metadata } from '@ai-pipeline/metadata/metadata';
import type { z } from 'zod';

/** Validates `metadata.config` against the unit's contract config schema at boot. */
export function loadConfig<T extends z.ZodType>(metadata: Metadata, schema: T): z.infer<T> {
  const result = schema.safeParse(metadata.config);
  if (!result.success)
    throw new Error(`invalid config in ${metadata.name}/metadata.json: ${result.error.message}`);
  return result.data;
}
