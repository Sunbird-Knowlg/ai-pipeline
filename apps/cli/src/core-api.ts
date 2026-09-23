import { errorEnvelope } from '@ai-pipeline/api-contract/errors';

/**
 * A refusal from core-api, with its wire code intact. `deploy` branches on `code`, so it must not be
 * flattened into the message.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Calls core-api and returns the body as `T`, where callers name `T` from
 * `@ai-pipeline/api-contract` — so a change to a response shape is a type error here rather than a
 * surprise at runtime.
 */
export type CoreApi = <T>(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
) => Promise<T>;

export function coreApi(baseUrl: string): CoreApi {
  return async function request<T>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await fetch(new URL(path, baseUrl), {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (!response.ok) {
      const envelope = errorEnvelope.safeParse(parsed);
      const error = envelope.success
        ? envelope.data.error
        : { code: 'HTTP_ERROR', message: response.statusText };
      throw new ApiError(response.status, error.code, `${error.code}: ${error.message}`);
    }
    return parsed as T;
  };
}
