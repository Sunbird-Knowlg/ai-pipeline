import { createLogger } from '@ai-pipeline/observability/logger';
import type { Difficulty } from '@ai-pipeline/contract-content-metadata';

/**
 * The one side effect this workflow owns itself.
 *
 * Everything else it does is a call to a service that owns its own I/O. This announces that a pack
 * is ready, and it must happen exactly once per run — not once per replay — which is what
 * `ctx.run` is for.
 *
 * It is injected rather than imported at the call site for the same reason `services/summary`
 * injects `generate`: a test can then count how often it really ran, which is how the replay test
 * proves a journaled step survives replay without repeating.
 */
export interface AuthoringPackReady {
  contentId: string;
  name: string;
  version: string;
  trigger: string;
  difficulty: Difficulty;
  keywords: number;
  questions: number;
  discarded: number;
}

export type PackSink = (pack: AuthoringPackReady) => void | Promise<void>;

/**
 * The production sink: one structured log line per pack, which the collector picks up and an
 * operator can alert on (`discarded` climbing, say).
 *
 * Note what it does not carry: no summary, no questions, no source text. This is a notification
 * that work finished, not a copy of it — the pack itself is the run's output, and the runs API
 * serves it.
 */
export function logPublisher(service: string): PackSink {
  const log = createLogger(service);
  return (pack) => {
    log.info(pack, 'authoring pack ready');
  };
}
