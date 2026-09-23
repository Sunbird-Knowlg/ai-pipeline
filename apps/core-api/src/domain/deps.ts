import type { Logger } from '@ai-pipeline/observability/logger';
import type { RestateAdminPort } from '../restate/admin.js';
import type { IngressPort } from '../restate/ingress.js';
import type { Store } from '../store/store.js';

/**
 * What the control-plane rules are allowed to touch.
 *
 * Every domain function takes this explicitly instead of reaching for a module-level singleton,
 * which is what makes the registration, retirement and run-start rules testable with plain stubs —
 * no Fastify, no Postgres, no Restate.
 */
export interface ControlPlane {
  store: Store;
  admin: RestateAdminPort;
  ingress: IngressPort;
  /** The Kafka cluster core-api keeps registered in Restate (re-ensured before subscribing). */
  kafka?: { cluster: string; bootstrapServers: string };
  log: Logger;
}
