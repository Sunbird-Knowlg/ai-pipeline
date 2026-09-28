import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';

/**
 * A thin, typed client over the knowlg-platform HTTP APIs this workflow calls: reading a Content
 * item, and driving EnrichmentObject's create/update/approve. Every function here is meant to be
 * called from inside a single `ctx.run` step — none of it is durable on its own.
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

/**
 * Runs one knowlg-platform HTTP call and unwraps its response envelope.
 *
 * `responseCode !== "OK"` is a genuine application-level rejection (bad input, illegal status
 * transition, unregistered category) — never worth retrying, so it's raised as a `TerminalError`
 * immediately. A network failure or non-2xx transport error is thrown as a plain `Error` instead,
 * which Restate's own `ctx.run` retry policy handles.
 */
async function call(url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
  if (!response.ok && response.status < 500) {
    const body = await response.text();
    throw new restate.TerminalError(`knowlg ${url} rejected the request (${response.status}): ${body}`);
  }
  if (!response.ok) throw new Error(`knowlg ${url} failed with ${response.status}`);

  const body: unknown = await response.json();
  const envelope = Envelope.parse(body);
  if (envelope.responseCode !== 'OK') {
    throw new restate.TerminalError(
      `knowlg ${url} returned ${envelope.responseCode}: ${envelope.params.err ?? ''} ${envelope.params.errmsg ?? ''}`,
    );
  }
  return envelope.result;
}

export const ContentSummary = z.strictObject({
  identifier: z.string(),
  artifactUrl: z.string(),
  mimeType: z.string(),
  channel: z.string(),
  status: z.string(),
});
export type ContentSummary = z.infer<typeof ContentSummary>;

export async function readContent(baseUrl: string, identifier: string): Promise<ContentSummary> {
  const result = await call(
    `${baseUrl}/content/v3/read/${identifier}?fields=artifactUrl,mimeType,channel,status`,
    { method: 'GET' },
  );
  const content = z.looseObject({}).parse(result.content);
  return ContentSummary.parse({
    identifier,
    artifactUrl: content.artifactUrl,
    mimeType: content.mimeType,
    channel: content.channel,
    status: content.status,
  });
}

export interface CreateEnrichmentObjectRequest {
  enrichmentObjectType: string;
  parentId: string;
  channel?: string;
  sourceLanguage?: boolean;
  languageCode?: string;
}

export const EnrichmentObjectSummary = z.strictObject({
  identifier: z.string(),
  status: z.string(),
  /**
   * Only present when `create()`'s `uniqueOn` matching returned an *existing* sibling (the
   * platform's create response is the full node for a match, base fields only for a fresh one) —
   * absent means this is a brand-new node with nothing detected/generated yet.
   */
  languageCode: z.string().optional(),
});
export type EnrichmentObjectSummary = z.infer<typeof EnrichmentObjectSummary>;

export async function createEnrichmentObject(
  baseUrl: string,
  request: CreateEnrichmentObjectRequest,
): Promise<EnrichmentObjectSummary> {
  const result = await call(`${baseUrl}/object/enrichment/v4/create`, {
    method: 'POST',
    body: JSON.stringify({ request: { enrichmentObject: request } }),
  });
  return EnrichmentObjectSummary.parse({
    identifier: result.identifier,
    status: result.status,
    ...(typeof result.languageCode === 'string' ? { languageCode: result.languageCode } : {}),
  });
}

export async function updateEnrichmentObject(
  baseUrl: string,
  identifier: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await call(`${baseUrl}/object/enrichment/v4/update/${identifier}`, {
    method: 'PATCH',
    body: JSON.stringify({ request: { enrichmentObject: fields } }),
  });
}

export async function approveEnrichmentObject(
  baseUrl: string,
  identifier: string,
  status: 'Live' | 'Review',
): Promise<EnrichmentObjectSummary> {
  const result = await call(`${baseUrl}/object/enrichment/v4/approve/${identifier}`, {
    method: 'POST',
    body: JSON.stringify({ request: { enrichmentObject: { status } } }),
  });
  return EnrichmentObjectSummary.parse({ identifier: result.identifier, status: result.status });
}
