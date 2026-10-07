import * as clients from '@restatedev/restate-sdk-clients';
import { PipelineError } from '../errors.js';

export interface Submission {
  invocationId: string;
  status: 'Accepted' | 'PreviouslyAccepted';
}

export interface ServiceCallOptions {
  /** Sent to Restate as is: a call that repeats one gets the first call's answer. */
  idempotencyKey?: string;
  /** How long to wait for the answer. The invocation is not cancelled; only the wait ends. */
  timeoutMs: number;
}

/**
 * Why a service call failed, classified by where the failure came from. This adapter does not
 * decide what a failure means for an API caller; the domain does.
 *
 * - `invocation`: the handler ran and failed. `status` is the `TerminalError`'s code, which Restate
 *   uses as the HTTP status. A handler input that fails its schema is a 400 here too.
 * - `ingress`: Restate refused the call before any handler ran (an unknown or private service, or
 *   overload), or answered with something that is not a result.
 * - `timeout`: no answer within `timeoutMs`.
 * - `network`: the ingress did not answer at all.
 *
 * Nothing else becomes one: an error that is not the call failing (a request JSON cannot encode,
 * a bug) is thrown as it is, so it is reported and logged as internal rather than as an outage.
 */
export class ServiceCallError extends Error {
  constructor(
    public readonly kind: 'invocation' | 'ingress' | 'timeout' | 'network',
    message: string,
    public readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ServiceCallError';
  }
}

/** What the control plane asks of the Restate ingress. Implemented by the class below. */
export interface IngressPort {
  submitWorkflow(restateName: string, runId: string, request: unknown): Promise<Submission>;
  /** The workflow's result once it is ready, else `undefined`. */
  workflowOutput(restateName: string, runId: string): Promise<unknown>;
  /**
   * Calls a service handler and waits for its answer. A failed call is a `ServiceCallError`;
   * anything else thrown is not a call failure and passes through.
   */
  callService(
    service: string,
    handler: string,
    request: unknown,
    options: ServiceCallOptions,
  ): Promise<unknown>;
}

/**
 * Starts workflows and calls services by Restate name through the official Restate client. The core
 * API never imports a unit's code or contract: it addresses units by their Restate name.
 */
export class RestateIngress implements IngressPort {
  private readonly ingress: clients.Ingress;

  /** `fetchImpl` is for tests; without it the client uses the global `fetch`. */
  constructor(url: string, fetchImpl?: typeof fetch) {
    this.ingress = clients.connect({ url, fetch: fetchImpl });
  }

  // The client is typed from workflow definitions; a by-name client is untyped by design.
  private workflow(name: string, key: string) {
    return this.ingress.workflowClient({ name } as never, key) as unknown as {
      workflowSubmit(request: unknown): Promise<Submission>;
      workflowOutput(): Promise<{ ready: boolean; result?: unknown }>;
    };
  }

  async submitWorkflow(restateName: string, runId: string, request: unknown): Promise<Submission> {
    try {
      const { invocationId, status } = await this.workflow(restateName, runId).workflowSubmit(
        request,
      );
      return { invocationId, status };
    } catch (error) {
      throw ingressError(error);
    }
  }

  async workflowOutput(restateName: string, runId: string): Promise<unknown> {
    try {
      const output = await this.workflow(restateName, runId).workflowOutput();
      return output.ready ? output.result : undefined;
    } catch (error) {
      throw ingressError(error);
    }
  }

  // `call` routes by name. The by-name `serviceClient` proxy is avoided: it answers every property,
  // `then` included, so awaiting it would invoke a handler called `then`.
  async callService(
    service: string,
    handler: string,
    request: unknown,
    options: ServiceCallOptions,
  ): Promise<unknown> {
    try {
      return await this.ingress.call<unknown, unknown>({
        service,
        handler,
        parameter: request,
        opts: clients.rpc.opts({
          // `timeout` aborts the fetch, waiting for the body included. The client takes no retry
          // policy here, so there is exactly one attempt.
          timeout: options.timeoutMs,
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        }),
      });
    } catch (error) {
      throw serviceCallError(error, options.timeoutMs) ?? error;
    }
  }
}

/**
 * Restate's ingress answers a failure with a JSON body whose `source` says whether the invocation
 * failed (`invocation`) or the ingress refused the call (`ingress`). A body without one is treated
 * as the ingress's: a failure that cannot be attributed to the handler must not be reported as the
 * caller's mistake.
 *
 * `undefined` when `error` is not the call failing at all.
 */
function serviceCallError(error: unknown, timeoutMs: number): ServiceCallError | undefined {
  if (error instanceof clients.HttpCallError) {
    const body = errorBody(error.responseText);
    const message = body.message ?? (error.responseText.trim() || `HTTP ${error.status}`);
    return new ServiceCallError(
      body.source === 'invocation' ? 'invocation' : 'ingress',
      message,
      error.status,
      { cause: error },
    );
  }
  const name = error instanceof Error ? error.name : undefined;
  // `AbortSignal.timeout` rejects with a `TimeoutError`; an abort while the body streams can surface
  // as an `AbortError` instead.
  if (name === 'TimeoutError' || name === 'AbortError')
    return new ServiceCallError('timeout', `no answer within ${timeoutMs} ms`, undefined, {
      cause: error,
    });
  // A 2xx whose body is not JSON: Restate answered, but not with a result.
  if (error instanceof SyntaxError)
    return new ServiceCallError('ingress', 'the answer is not JSON', undefined, { cause: error });
  if (isTransportFailure(error))
    return new ServiceCallError(
      'network',
      `no answer from the ingress: ${socketReason(error)}`,
      undefined,
      {
        cause: error,
      },
    );
  return undefined;
}

/**
 * `fetch`'s own failures, as Node's fetch (undici) raises them: `fetch failed` when no answer came
 * (refused, reset, DNS, a headers timeout), `terminated` when the connection dropped while the
 * answer's body streamed. Both are `TypeError`s carrying the socket error as `cause`.
 */
const isTransportFailure = (error: unknown): error is TypeError =>
  error instanceof TypeError &&
  (error.message === 'fetch failed' || error.message === 'terminated');

/** The socket error behind a transport failure, for the log: `ECONNREFUSED connect …`. */
function socketReason(error: TypeError): string {
  const cause = error.cause as { code?: unknown; message?: unknown } | undefined;
  const parts = [cause?.code, cause?.message].filter(
    (part): part is string => typeof part === 'string' && part !== '',
  );
  return parts.length > 0 ? parts.join(' ') : error.message;
}

function errorBody(text: string): { message?: string; source?: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return {};
    const { message, source } = parsed as Record<string, unknown>;
    return {
      ...(typeof message === 'string' && message ? { message } : {}),
      ...(typeof source === 'string' ? { source } : {}),
    };
  } catch {
    return {};
  }
}

function ingressError(error: unknown): PipelineError {
  if (error instanceof clients.HttpCallError) {
    const status = error.status === 404 ? 404 : 502;
    // Restate's own words when it gave any, rather than the client's "Request failed: 404\n{…}".
    const message = errorBody(error.responseText).message ?? error.message;
    return new PipelineError(
      'RESTATE_INGRESS_ERROR',
      `Restate ingress: ${message}`.slice(0, 500),
      status,
      { cause: error },
    );
  }
  return new PipelineError('RESTATE_UNAVAILABLE', 'Restate ingress is unavailable', 503, {
    cause: error,
  });
}
