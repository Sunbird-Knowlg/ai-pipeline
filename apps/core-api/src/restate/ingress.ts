import * as clients from '@restatedev/restate-sdk-clients';
import { PipelineError } from '../errors.js';

export interface Submission {
  invocationId: string;
  status: 'Accepted' | 'PreviouslyAccepted';
}

/** What the control plane asks of the Restate ingress. Implemented by the class below. */
export interface IngressPort {
  submitWorkflow(restateName: string, runId: string, request: unknown): Promise<Submission>;
  /** The workflow's result once it is ready, else `undefined`. */
  workflowOutput(restateName: string, runId: string): Promise<unknown>;
}

/**
 * Starts workflows by catalogue name through the official Restate client. The core API never
 * imports workflow code or contracts: it addresses workflows by their Restate name.
 */
export class RestateIngress implements IngressPort {
  private readonly ingress: clients.Ingress;

  constructor(url: string) {
    this.ingress = clients.connect({ url });
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
}

function ingressError(error: unknown): PipelineError {
  if (error instanceof clients.HttpCallError) {
    const status = error.status === 404 ? 404 : 502;
    return new PipelineError(
      'RESTATE_INGRESS_ERROR',
      `Restate ingress: ${error.message}`.slice(0, 500),
      status,
      { cause: error },
    );
  }
  return new PipelineError('RESTATE_UNAVAILABLE', 'Restate ingress is unavailable', 503, {
    cause: error,
  });
}
