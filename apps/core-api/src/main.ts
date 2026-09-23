import { createLogger } from '@ai-pipeline/observability/logger';
import { startTelemetry } from '@ai-pipeline/observability/telemetry';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { RestateAdmin } from './restate/admin.js';
import { RestateIngress } from './restate/ingress.js';
import { createDb } from './store/db.js';

/**
 * The composition root: read config, build the adapters, wait for dependencies, serve. It is the
 * only place that touches the process — everything below it is passed its collaborators.
 */
const telemetry = startTelemetry('core-api');
const log = createLogger('core-api');
const config = loadConfig();
const db = createDb(config.DATABASE_URL, (err) => log.warn({ err }, 'idle postgres client error'));
const admin = new RestateAdmin(config.RESTATE_ADMIN_URL);

/** Boot waits for its dependencies instead of crash-looping on ordering races. */
async function retrying(what: string, fn: () => Promise<void>, attempts = 60): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i >= attempts) throw error;
      log.warn({ err: error, attempt: i }, `waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000 * i, 5000)));
    }
  }
}

// Wait for Postgres to answer. The catalogue schema is created when Postgres is provisioned
// (`infra/postgres/init`), not here — the API holds no DDL privileges and creates nothing.
await retrying('postgres', async () => {
  await db.query('SELECT 1');
});
await retrying('restate', () =>
  admin.ensureKafkaCluster(config.KAFKA_CLUSTER_NAME, config.KAFKA_BOOTSTRAP_SERVERS),
);

const app = buildApp({
  db,
  admin,
  ingress: new RestateIngress(config.RESTATE_INGRESS_URL),
  kafka: { cluster: config.KAFKA_CLUSTER_NAME, bootstrapServers: config.KAFKA_BOOTSTRAP_SERVERS },
  log,
  allowedHosts: config.ALLOWED_HOSTS,
});
await app.listen({ host: config.HOST, port: config.PORT });

const shutdown = async () => {
  await app.close();
  await db.end();
  await telemetry.shutdown();
  process.exit(0);
};
process.once('SIGTERM', () => void shutdown());
process.once('SIGINT', () => void shutdown());
