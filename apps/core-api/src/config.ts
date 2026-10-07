import { z } from 'zod';

const list = z.string().transform((s) =>
  s
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean),
);

/**
 * How long to wait on Restate for an answer, in ms. Below 300 s: Node's `fetch` gives up on a
 * response whose headers have not arrived after 300 s (undici's `headersTimeout`), and Restate sends
 * none until the call completes. A longer setting would be cut there anyway, and reported as Restate
 * being unreachable (503) instead of a timeout (504) — so it is refused at boot.
 */
export const MAX_RAG_TIMEOUT_MS = 290_000;
const timeoutMs = z.coerce.number().int().positive().max(MAX_RAG_TIMEOUT_MS);

/**
 * How long the RAG routes wait for `RagQuery` before answering 504. Exported because `buildApp`
 * falls back to the same values when it is given none.
 */
export const RAG_TIMEOUTS = { queryMs: 30_000, answerMs: 240_000 };

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
  /** RAG reads and searches: a retrieval and an embedding call. */
  RAG_QUERY_TIMEOUT_MS: timeoutMs.default(RAG_TIMEOUTS.queryMs),
  /** RAG answers, and searches that rerank: model calls on top of the retrieval. */
  RAG_ANSWER_TIMEOUT_MS: timeoutMs.default(RAG_TIMEOUTS.answerMs),
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
