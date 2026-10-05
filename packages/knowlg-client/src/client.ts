import type { Logger } from '@ai-pipeline/observability/logger';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';

/**
 * A generic client over the knowlg-platform HTTP APIs: reading a Content item, and driving
 * EnrichmentObject's create/update/approve/reject. Every one of these endpoints is flat and
 * category-agnostic on the server side (see knowledge-platform's own EnrichmentObjectController) —
 * this client stays exactly as generic: callers send whatever request body they need and read
 * whatever fields they need off the raw response themselves, via their own local schema. This
 * client never assumes or validates a specific shape beyond the envelope every response shares.
 *
 * Every function here is meant to be called from inside a single `ctx.run` step — none of it is
 * durable on its own.
 */

const Envelope = z.looseObject({
  responseCode: z.string(),
  params: z.looseObject({
    status: z.string(),
    err: z.string().nullable().optional(),
    errmsg: z.string().nullable().optional(),
  }),
  result: z.looseObject({}),
});

export interface KnowlgClientOptions {
  baseUrl: string;
  log: Logger;
}

/**
 * Runs one knowlg-platform HTTP call and unwraps its response envelope.
 *
 * `responseCode !== "OK"` is a genuine application-level rejection (bad input, illegal status
 * transition, unregistered category) — never worth retrying, so it's raised as a `TerminalError`
 * immediately. A network failure or non-2xx transport error is thrown as a plain `Error` instead,
 * which Restate's own `ctx.run` retry policy handles.
 */
async function call(
  baseUrl: string,
  log: Logger,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  const url = `${baseUrl}${path}`;
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok && response.status < 500) {
    const body = await response.text();
    log.error(
      { event: 'knowlg.rejected', url, status: response.status },
      'knowlg rejected the request',
    );
    throw new restate.TerminalError(
      `knowlg ${url} rejected the request (${response.status}): ${body}`,
    );
  }
  if (!response.ok) {
    log.warn(
      { event: 'knowlg.transport_error', url, status: response.status },
      'knowlg call failed',
    );
    throw new Error(`knowlg ${url} failed with ${response.status}`);
  }

  const body: unknown = await response.json();
  const envelope = Envelope.parse(body);
  if (envelope.responseCode !== 'OK') {
    log.error(
      { event: 'knowlg.rejected', url, responseCode: envelope.responseCode },
      'knowlg rejected the request',
    );
    throw new restate.TerminalError(
      `knowlg ${url} returned ${envelope.responseCode}: ${envelope.params.err ?? ''} ${envelope.params.errmsg ?? ''}`,
    );
  }
  log.debug({ event: 'knowlg.ok', url }, 'knowlg call succeeded');
  return envelope.result;
}

/**
 * Builds a client bound to one knowlg-platform instance. Constructed once, at a unit's boot
 * (alongside its other dependencies), and reused for every run that unit ever handles — never
 * rebuilt per call or per request.
 */
export function createKnowlgClient({ baseUrl, log }: KnowlgClientOptions) {
  return {
    /** `GET /content/v3/read/:identifier`, optionally scoped to only the given fields. */
    async readContent(identifier: string, fields?: string[]): Promise<Record<string, unknown>> {
      const query = fields && fields.length > 0 ? `?fields=${fields.join(',')}` : '';
      const result = await call(baseUrl, log, `/content/v3/read/${identifier}${query}`, {
        method: 'GET',
      });
      return z.looseObject({}).parse(result.content);
    },

    /**
     * `POST /object/enrichment/v4/create`. Not guaranteed to create anything: the platform's own
     * `uniqueOn` matching (on the registered category definition) can return an *existing* sibling
     * instead, if one already matches — the caller tells the two apart from whatever fields its
     * own schema expects on the result (e.g. a already-populated `languageCode`). This is what
     * makes a redelivered or re-run trigger safe to call again without creating a duplicate node.
     */
    createEnrichmentObject(body: Record<string, unknown>): Promise<Record<string, unknown>> {
      return call(baseUrl, log, '/object/enrichment/v4/create', {
        method: 'POST',
        body: JSON.stringify({ request: { enrichmentObject: body } }),
      });
    },

    /** `PATCH /object/enrichment/v4/update/:identifier`. */
    updateEnrichmentObject(
      identifier: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return call(baseUrl, log, `/object/enrichment/v4/update/${identifier}`, {
        method: 'PATCH',
        body: JSON.stringify({ request: { enrichmentObject: body } }),
      });
    },

    /** `POST /object/enrichment/v4/approve/:identifier` — moves toward `Live` or `Review`. */
    approveEnrichmentObject(
      identifier: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return call(baseUrl, log, `/object/enrichment/v4/approve/${identifier}`, {
        method: 'POST',
        body: JSON.stringify({ request: { enrichmentObject: body } }),
      });
    },

    /** `POST /object/enrichment/v4/reject/:identifier` — resets to `Draft` or retires to `Retired`. */
    rejectEnrichmentObject(
      identifier: string,
      body: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      return call(baseUrl, log, `/object/enrichment/v4/reject/${identifier}`, {
        method: 'POST',
        body: JSON.stringify({ request: { enrichmentObject: body } }),
      });
    },
  };
}

export type KnowlgClient = ReturnType<typeof createKnowlgClient>;
