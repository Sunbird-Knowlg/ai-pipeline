import { REGISTRATION_EVENT } from '@ai-pipeline/api-contract/registration';
import { createLogger } from '@ai-pipeline/observability/logger';
import { startTelemetry } from '@ai-pipeline/observability/telemetry';
import * as restate from '@restatedev/restate-sdk';
import { type DeployableUnit, outcomeOf, register, registrationTarget } from './register.js';

/**
 * Serves Restate handlers over HTTP/2, then registers this build with core-api.
 *
 * Everything that can be wrong with the request is checked before serving. Registration follows
 * once the endpoint is listening, because core-api's discovery calls back into it. The outcome is
 * logged once, as `REGISTRATION_EVENT`, which is how `pipeline deploy` (or anyone reading the
 * logs) learns it. A build that is already registered — this container restarted, or another
 * replica registered the same endpoint first — is reported as such by core-api, not registered
 * again. A build that is not registered exits non-zero rather than serving code nothing routes to:
 * its supervisor restarts it, so a dependency deployed later is picked up on a later boot.
 */
export async function serve(
  unit: DeployableUnit,
  services: restate.ServeOptions['services'],
): Promise<number> {
  const { name } = unit.metadata;
  const telemetry = startTelemetry(name);
  const log = createLogger(name);
  const fail = async (error: Error): Promise<never> => {
    log.error({ event: REGISTRATION_EVENT, ...outcomeOf(error) }, 'deployment not registered');
    await new Promise<void>((resolve) => {
      log.flush(() => {
        resolve();
      });
    });
    await telemetry.shutdown().catch(() => undefined);
    process.exit(1);
  };

  let target: ReturnType<typeof registrationTarget>;
  try {
    target = registrationTarget(unit);
  } catch (error) {
    return fail(error as Error);
  }

  const port = await restate.serve({ services, port: Number(process.env.PORT ?? 9080) });
  log.info({ port }, 'serving restate handlers');
  const stop = () => void telemetry.shutdown().finally(() => process.exit(0));
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  try {
    const result = await register(target);
    log.info(
      { event: REGISTRATION_EVENT, ...outcomeOf(result) },
      result.alreadyRegistered ? 'deployment already registered' : 'deployment registered',
    );
  } catch (error) {
    return fail(error as Error);
  }
  return port;
}
