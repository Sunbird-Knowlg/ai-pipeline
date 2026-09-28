// A wall-clock delay is fine here: this runs once at boot, before and outside any Restate handler,
// so there is no journal to replay. Imported rather than global so the handler lint still catches
// timers everywhere else.
import { setTimeout as delay } from 'node:timers/promises';
import type {
  DeploymentRegistered,
  DeploymentRequest,
} from '@ai-pipeline/api-contract/deployments';
import { errorEnvelope } from '@ai-pipeline/api-contract/errors';
import { deploymentMode } from '@ai-pipeline/api-contract/params';
import type { RegistrationOutcome } from '@ai-pipeline/api-contract/registration';
import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { contractHash, contractSchemas } from '@ai-pipeline/contracts/schemas';
import type { Metadata } from '@ai-pipeline/metadata/metadata';
import { z } from 'zod';

/**
 * Self-registration: a unit registers its own build with core-api once it is serving.
 *
 * core-api does the registering — dry-run discovery, Restate registration, catalogue and triggers —
 * exactly as before; this only builds the request and delivers it. It has to run *after* the
 * endpoint is listening, because core-api's discovery calls straight back into it.
 */

export interface DeployableUnit {
  metadata: Metadata;
  contract: ContractEntry;
}

/**
 * What the process needs to know about where it runs. `ARTIFACT_DIGEST` is baked into the image at
 * build time (`--build-arg ARTIFACT_DIGEST`): the digest is computed over the source, which the
 * image does not carry.
 */
const registrationEnv = z.object({
  CORE_API_URL: z.url(),
  ADVERTISED_ENDPOINT: z.url(),
  DEPLOYMENT_MODE: deploymentMode.default('immutable'),
  ARTIFACT_DIGEST: z.string().min(1).max(200),
});

/** A request this process refuses to send. Nothing was registered. */
export class InvalidRegistration extends Error {
  override name = 'InvalidRegistration';
}

/** core-api answered with an error envelope. */
export class RegistrationRefused extends Error {
  override name = 'RegistrationRefused';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** core-api was unreachable or kept answering 502/503 until the attempts ran out. */
export class RegistrationFailed extends Error {
  override name = 'RegistrationFailed';
}

export interface RegistrationTarget {
  coreApiUrl: string;
  request: DeploymentRequest;
}

/** Builds the registration request, refusing anything core-api would only refuse later. */
export function registrationTarget(
  unit: DeployableUnit,
  env: Record<string, string | undefined> = process.env,
): RegistrationTarget {
  const { metadata, contract } = unit;
  const parsed = registrationEnv.safeParse(env);
  if (!parsed.success)
    throw new InvalidRegistration(
      `${metadata.name} cannot register: ${z.prettifyError(parsed.error)}`,
    );
  if (contract.restateName !== metadata.restateName)
    throw new InvalidRegistration(
      `contract restateName ${contract.restateName} ≠ metadata restateName ${metadata.restateName}`,
    );
  // The runs API reads invocations by handler name, so a workflow's entry point must be `run`.
  if (metadata.kind === 'workflow' && contract.handler !== 'run')
    throw new InvalidRegistration(
      `a workflow's contract handler must be "run" (${metadata.name} declares "${contract.handler}"); ` +
        'the runs API selects invocations by that name.',
    );

  let schemas: ReturnType<typeof contractSchemas>;
  try {
    schemas = contractSchemas(contract);
  } catch (error) {
    throw new InvalidRegistration((error as Error).message);
  }
  const e = parsed.data;
  return {
    coreApiUrl: e.CORE_API_URL,
    request: {
      metadata,
      schemas,
      contractHash: contractHash(schemas),
      artifactDigest: e.ARTIFACT_DIGEST,
      endpoint: e.ADVERTISED_ENDPOINT,
      mode: e.DEPLOYMENT_MODE,
    },
  };
}

// Restate is still discovering the endpoint (502), or the catalogue sync after registration needs
// another idempotent pass (503).
const RETRYABLE_STATUS = new Set([502, 503]);

export interface RegisterOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}

/**
 * `POST /v1/deployments`, retried while the answer may still change: a 502/503, or core-api not
 * being reachable yet (it may be starting alongside this unit). Any other refusal is final.
 */
export async function register(
  target: RegistrationTarget,
  o: RegisterOptions = {},
): Promise<DeploymentRegistered> {
  const send = o.fetch ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => delay(ms));
  const maxAttempts = o.maxAttempts ?? 20;
  const url = new URL('/v1/deployments', target.coreApiUrl);

  for (let attempt = 1; ; attempt++) {
    let last: string;
    try {
      const response = await send(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(target.request),
      });
      const text = await response.text();
      const body: unknown = text ? JSON.parse(text) : undefined;
      if (response.ok) return body as DeploymentRegistered;

      const envelope = errorEnvelope.safeParse(body);
      const error = envelope.success
        ? envelope.data.error
        : { code: 'HTTP_ERROR', message: response.statusText };
      if (!RETRYABLE_STATUS.has(response.status))
        throw new RegistrationRefused(
          response.status,
          error.code,
          `${error.code}: ${error.message}`,
        );
      last = `${error.code}: ${error.message}`;
    } catch (error) {
      if (error instanceof RegistrationRefused) throw error;
      last = (error as Error).message;
    }
    if (attempt >= maxAttempts)
      throw new RegistrationFailed(
        `gave up registering after ${attempt} attempts; last error: ${last}`,
      );
    await sleep(Math.min(1000 * 2 ** (attempt - 1), 5000));
  }
}

/** The log-line form of a registration's result (see `@ai-pipeline/api-contract/registration`). */
export function outcomeOf(result: DeploymentRegistered | Error): RegistrationOutcome {
  if (result instanceof RegistrationRefused)
    return {
      outcome: 'refused',
      status: result.status,
      code: result.code,
      message: result.message,
    };
  if (result instanceof InvalidRegistration) return { outcome: 'invalid', message: result.message };
  if (result instanceof Error) return { outcome: 'failed', message: result.message };
  return { outcome: 'registered', result };
}
