import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * The parts of a workspace `package.json` the CLI reads. Parsing it rather than casting
 * `JSON.parse` keeps a malformed manifest from surfacing as `undefined is not a function` deep
 * inside the artifact digest or unit discovery.
 */
const manifestSchema = z.looseObject({
  name: z.string().min(1),
  dependencies: z.record(z.string(), z.string()).default({}),
  devDependencies: z.record(z.string(), z.string()).default({}),
});

export type Manifest = z.infer<typeof manifestSchema>;

export function readManifest(path: string): Manifest {
  const result = manifestSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')) as unknown);
  if (!result.success) throw new Error(`invalid ${path}: ${z.prettifyError(result.error)}`);
  return result.data;
}
