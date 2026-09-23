import { createLogger } from '@ai-pipeline/observability/logger';
import { startTelemetry } from '@ai-pipeline/observability/telemetry';
import * as restate from '@restatedev/restate-sdk';

/**
 * Serves Restate handlers over HTTP/2 and nothing else: registration with Restate and the
 * catalogue is the control plane's job (`pipeline deploy`).
 */
export async function serve(
  name: string,
  services: restate.ServeOptions['services'],
): Promise<number> {
  const telemetry = startTelemetry(name);
  const log = createLogger(name);
  const port = await restate.serve({ services, port: Number(process.env.PORT ?? 9080) });
  log.info({ port }, 'serving restate handlers');
  const stop = () => void telemetry.shutdown().finally(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return port;
}
