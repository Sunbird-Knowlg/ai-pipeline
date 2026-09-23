import { z } from 'zod';

const list = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

export const configSchema = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  RESTATE_INGRESS_URL: z.url(),
  RESTATE_ADMIN_URL: z.url(),
  KAFKA_CLUSTER_NAME: z.string().default('local'),
  KAFKA_BOOTSTRAP_SERVERS: z.string().default('kafka:9092'),
  /** Host-header allow-list; the only DNS-rebinding guard since v1 has no auth. */
  ALLOWED_HOSTS: list.default(['localhost', '127.0.0.1', '::1', 'core-api']),
});
export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success)
    throw new Error(
      `invalid configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return result.data;
}
