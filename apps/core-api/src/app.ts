import type { Logger } from '@ai-pipeline/observability/logger';
import Fastify from 'fastify';
import type { ControlPlane } from './domain/deps.js';
import { controlPlanePlugin } from './plugins/control-plane.js';
import { errorsPlugin } from './plugins/errors.js';
import { securityPlugin } from './plugins/security.js';
import { deploymentRoutes } from './routes/deployments.js';
import { healthRoutes } from './routes/health.js';
import { runRoutes } from './routes/runs.js';
import { workflowRoutes } from './routes/workflows.js';
import type { RestateAdminPort } from './restate/admin.js';
import type { IngressPort } from './restate/ingress.js';
import { createStore } from './store/store.js';
import type { Db } from './store/db.js';

export interface AppDeps {
  db: Db;
  admin: RestateAdminPort;
  ingress: IngressPort;
  kafka: { cluster: string; bootstrapServers: string };
  log: Logger;
  allowedHosts: string[];
}

/**
 * Wires the HTTP surface: an instance, three plugins, four route groups. Nothing else belongs here
 * — the rules live in `domain/`, the SQL in `store/`, the Restate calls in `restate/`, and the
 * row-to-wire mapping in `views.ts`.
 */
export function buildApp(deps: AppDeps) {
  const app = Fastify({
    loggerInstance: deps.log,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
    routerOptions: { maxParamLength: 512 },
  });

  const controlPlane: ControlPlane = {
    store: createStore(deps.db),
    admin: deps.admin,
    ingress: deps.ingress,
    kafka: deps.kafka,
    log: deps.log,
  };

  void app.register(errorsPlugin);
  void app.register(securityPlugin, { allowedHosts: deps.allowedHosts });
  void app.register(controlPlanePlugin, controlPlane);

  void app.register(healthRoutes);
  void app.register(deploymentRoutes, { prefix: '/v1' });
  void app.register(workflowRoutes, { prefix: '/v1' });
  void app.register(runRoutes, { prefix: '/v1' });

  return app;
}
