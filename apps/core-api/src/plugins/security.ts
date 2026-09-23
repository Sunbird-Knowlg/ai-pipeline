import fp from 'fastify-plugin';
import { PipelineError } from '../errors.js';

/**
 * The only access control v1 has.
 *
 * There is no auth, and every port binds to 127.0.0.1, so two guards carry the weight:
 *
 *  - a Host allow-list, which is what stops DNS rebinding (a page on the public internet resolving
 *    a name it controls to 127.0.0.1 and talking to this API from the victim's browser);
 *  - a cross-site check on unsafe methods, so a foreign page cannot make the browser start or
 *    cancel runs. The CLI and curl send neither `Origin` nor `Sec-Fetch-Site`, so they pass.
 */
export interface SecurityOptions {
  allowedHosts: string[];
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const securityPlugin = fp(
  async (app, { allowedHosts }: SecurityOptions) => {
    app.addHook('onRequest', async (request) => {
      if (!allowedHosts.includes(hostname(request.headers.host ?? '')))
        throw new PipelineError('INVALID_HOST', 'Host is not allowed', 403);
      if (!SAFE_METHODS.has(request.method) && isCrossSite(request.headers, allowedHosts))
        throw new PipelineError('CROSS_SITE_REQUEST', 'Cross-site requests are not allowed', 403);
    });
  },
  { name: 'security' },
);

function isCrossSite(
  headers: Record<string, string | string[] | undefined>,
  allowedHosts: string[],
): boolean {
  const site = headers['sec-fetch-site'];
  if (site === 'cross-site' || site === 'same-site') return true;
  const origin = headers.origin;
  if (typeof origin !== 'string') return false;
  try {
    return !allowedHosts.includes(hostname(new URL(origin).host));
  } catch {
    return true;
  }
}

/** Host header → hostname (handles `[::1]:3000`). */
export function hostname(host: string): string {
  if (host.startsWith('[')) return host.slice(1, host.indexOf(']'));
  return host.split(':')[0]!.toLowerCase();
}
