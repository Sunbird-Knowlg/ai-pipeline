import { PipelineError } from '../errors.js';

export interface Subscription {
  id: string;
  source: string;
  sink: string;
  options: Record<string, string>;
}

export interface RegisteredDeployment {
  id: string;
  services: { name: string }[];
}

/**
 * Everything the control plane asks of the Restate admin API.
 *
 * The domain depends on this interface, not on the class below, so the registration, retirement and
 * trigger rules can be tested against an in-memory Restate instead of a live one.
 */
export interface RestateAdminPort {
  /** Whether Restate's admin API answers (readiness). */
  health(): Promise<boolean>;
  /** Idempotent: a cluster that already exists is not an error. */
  ensureKafkaCluster(name: string, bootstrapServers: string): Promise<void>;
  /** Discovers an endpoint without registering it, to check what it serves. */
  dryRunDeployment(uri: string, force: boolean): Promise<RegisteredDeployment>;
  registerDeployment(uri: string, force: boolean): Promise<RegisteredDeployment>;
  deleteDeployment(id: string): Promise<void>;
  serviceExists(name: string): Promise<boolean>;
  /** The deployment Restate currently routes new invocations of a service to. */
  service(name: string): Promise<{ deployment_id: string; revision: number } | undefined>;
  listSubscriptions(): Promise<Subscription[]>;
  createSubscription(
    source: string,
    sink: string,
    options: Record<string, string>,
  ): Promise<Subscription>;
  deleteSubscription(id: string): Promise<void>;
  /** SQL introspection (DataFusion). Callers must only interpolate quoted/validated values. */
  query<T>(sql: string): Promise<T[]>;
  cancelInvocation(id: string): Promise<'requested' | 'completed' | 'not_found'>;
  /** Kills an invocation without letting it unwind. */
  killInvocation(id: string): Promise<'requested' | 'completed' | 'not_found'>;
  /** Resumes a paused invocation. `not_paused` covers running, completed and unknown-state. */
  resumeInvocation(id: string): Promise<'requested' | 'not_paused' | 'not_found'>;
}

/** Thin typed client for the Restate Admin API (control plane only; ingress uses the SDK client). */
export class RestateAdmin implements RestateAdminPort {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    allow: number[] = [],
  ): Promise<{ status: number; body: T }> {
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      text = await response.text();
    } catch (error) {
      throw new PipelineError(
        'RESTATE_UNAVAILABLE',
        `Restate ${method} ${path}: ${(error as Error).message}`.slice(0, 500),
        502,
        { cause: error },
      );
    }
    let parsed: T;
    try {
      parsed = text ? (JSON.parse(text) as T) : (undefined as T);
    } catch {
      parsed = { message: text.slice(0, 300) } as T;
    }
    if (!response.ok && !allow.includes(response.status)) {
      const message = (parsed as { message?: string } | undefined)?.message ?? response.statusText;
      throw new PipelineError(
        'RESTATE_ADMIN_ERROR',
        `Restate ${method} ${path}: ${message}`.slice(0, 500),
        502,
      );
    }
    return { status: response.status, body: parsed };
  }

  async health(): Promise<boolean> {
    try {
      return (
        await this.fetchImpl(new URL('/health', this.baseUrl), {
          signal: AbortSignal.timeout(1500),
        })
      ).ok;
    } catch {
      return false;
    }
  }

  /** Idempotent: 409 means the cluster already exists. */
  async ensureKafkaCluster(name: string, bootstrapServers: string): Promise<void> {
    await this.call(
      'POST',
      '/kafka-clusters',
      { name, properties: { 'bootstrap.servers': bootstrapServers } },
      [409],
    );
  }

  /** Discovers an endpoint without registering it (validates what it serves). */
  async dryRunDeployment(uri: string, force: boolean): Promise<RegisteredDeployment> {
    return (
      await this.call<RegisteredDeployment>('POST', '/deployments', { uri, force, dry_run: true })
    ).body;
  }

  /** `force` overwrites an existing URI in place — local development only. */
  async registerDeployment(uri: string, force: boolean): Promise<RegisteredDeployment> {
    return (await this.call<RegisteredDeployment>('POST', '/deployments', { uri, force })).body;
  }

  async deleteDeployment(id: string): Promise<void> {
    await this.call(
      'DELETE',
      `/deployments/${encodeURIComponent(id)}?force=true`,
      undefined,
      [404],
    );
  }

  async serviceExists(name: string): Promise<boolean> {
    return (await this.service(name)) !== undefined;
  }

  /** The deployment Restate currently routes new invocations of a service to. */
  async service(name: string): Promise<{ deployment_id: string; revision: number } | undefined> {
    const { status, body } = await this.call<{ deployment_id: string; revision: number }>(
      'GET',
      `/services/${encodeURIComponent(name)}`,
      undefined,
      [404],
    );
    return status === 404 ? undefined : body;
  }

  async listSubscriptions(): Promise<Subscription[]> {
    return (await this.call<{ subscriptions: Subscription[] }>('GET', '/subscriptions')).body
      .subscriptions;
  }

  async createSubscription(
    source: string,
    sink: string,
    options: Record<string, string>,
  ): Promise<Subscription> {
    return (await this.call<Subscription>('POST', '/subscriptions', { source, sink, options }))
      .body;
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.call('DELETE', `/subscriptions/${encodeURIComponent(id)}`, undefined, [404]);
  }

  /** SQL introspection (DataFusion). Callers must only interpolate quoted/validated values. */
  async query<T>(sql: string): Promise<T[]> {
    return (await this.call<{ rows: T[] }>('POST', '/query', { query: sql })).body.rows;
  }

  /** 'requested' | 'completed' (already finished) | 'not_found' */
  async cancelInvocation(id: string): Promise<'requested' | 'completed' | 'not_found'> {
    return this.lifecycle(id, 'cancel');
  }

  async killInvocation(id: string): Promise<'requested' | 'completed' | 'not_found'> {
    return this.lifecycle(id, 'kill');
  }

  /**
   * Resumes a paused invocation. Restate answers 409 when it is not paused — already running,
   * or completed — and 400/404 when the id is not one it knows.
   */
  async resumeInvocation(id: string): Promise<'requested' | 'not_paused' | 'not_found'> {
    const { status } = await this.call(
      'PATCH',
      `/invocations/${encodeURIComponent(id)}/resume`,
      undefined,
      [400, 404, 409],
    );
    if (status === 409) return 'not_paused';
    return status === 400 || status === 404 ? 'not_found' : 'requested';
  }

  private async lifecycle(
    id: string,
    action: 'cancel' | 'kill',
  ): Promise<'requested' | 'completed' | 'not_found'> {
    const { status } = await this.call(
      'PATCH',
      `/invocations/${encodeURIComponent(id)}/${action}`,
      undefined,
      [404, 409],
    );
    return status === 404 ? 'not_found' : status === 409 ? 'completed' : 'requested';
  }
}
