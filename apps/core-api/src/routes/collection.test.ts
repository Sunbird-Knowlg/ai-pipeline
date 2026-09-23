import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Postman collection, checked against the routes it claims to document.
 *
 * A hand-maintained collection's normal fate is to drift: a route is added, nobody updates the
 * collection, and it quietly documents an API that no longer exists. This makes that a build failure
 * — in both directions, since a request for a route that was removed is just as misleading.
 */
const ROUTES = new URL('./', import.meta.url);
const COLLECTION = new URL(
  '../../../../manifests/ai-pipeline.postman_collection.json',
  import.meta.url,
);

interface PostmanItem {
  name: string;
  item?: PostmanItem[];
  request?: { method: string; url: { path?: string[] }; description?: string };
}

/** Every `METHOD /path` the route modules register, with Fastify params normalised to `:param`. */
function declaredRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of readdirSync(ROUTES).filter(
    (f) => f.endsWith('.ts') && !f.includes('.test.'),
  )) {
    const source = readFileSync(new URL(file, ROUTES), 'utf8');
    // `app.get('/runs/:workflow/:runId', …)`. The prefix is applied in app.ts, not here.
    for (const match of source.matchAll(/app\.(get|post|patch|delete|put)\(\s*'([^']+)'/g)) {
      const prefix = file === 'health.ts' ? '' : '/v1';
      routes.add(`${match[1]!.toUpperCase()} ${prefix}${match[2]!}`);
    }
  }
  return routes;
}

/**
 * Every `METHOD /path` the collection exercises, with Postman variables normalised to `:param`.
 *
 * Deliberate error-path probes are excluded: a request named with a parenthesised status (`(404)`)
 * or filed under `Guards` exists to show a refusal, and may point at a path the router does not
 * serve — which is the whole point of it.
 */
function collectionRoutes(): Map<string, string> {
  const collection = JSON.parse(readFileSync(COLLECTION, 'utf8')) as { item: PostmanItem[] };
  const found = new Map<string, string>();

  const walk = (items: PostmanItem[], folder = '') => {
    for (const item of items) {
      if (item.item) walk(item.item, item.name);
      if (!item.request) continue;
      if (folder === 'Guards' || /\(\d{3}\)/.test(item.name)) continue;
      const segments = (item.request.url.path ?? []).map((segment) => {
        // `{{runId}}` and a literal id both stand for the same path parameter.
        if (/^\{\{.+\}\}$/.test(segment)) return `:${segment.slice(2, -2)}`;
        if (/^(api|kf)_[0-9a-f]+$/.test(segment)) return ':runId';
        if (segment.startsWith('dp_')) return ':id';
        return segment;
      });
      found.set(`${item.request.method} /${segments.join('/')}`, item.name);
    }
  };
  walk(collection.item);
  return found;
}

/** Requests that deliberately probe a refusal, so the collection documents failures too. */
function negativeProbes(): string[] {
  const collection = JSON.parse(readFileSync(COLLECTION, 'utf8')) as { item: PostmanItem[] };
  const walk = (items: PostmanItem[], folder = ''): string[] =>
    items.flatMap((item) => [
      ...(item.item ? walk(item.item, item.name) : []),
      ...(item.request && (folder === 'Guards' || /\(\d{3}\)/.test(item.name)) ? [item.name] : []),
    ]);
  return walk(collection.item);
}

/** `:workflow` and `:name` are the same position; compare shapes, not parameter spellings. */
const shape = (route: string) => route.replace(/:[A-Za-z]+/g, ':param');

describe('the Postman collection', () => {
  const declared = declaredRoutes();
  const collected = collectionRoutes();

  it('found the routes and the collection', () => {
    expect(declared.size).toBeGreaterThan(8);
    expect(collected.size).toBeGreaterThan(8);
  });

  it('exercises every route the API registers', () => {
    const shapes = new Set([...collected.keys()].map(shape));
    const missing = [...declared].filter((route) => !shapes.has(shape(route)));
    expect(
      missing,
      `not in manifests/ai-pipeline.postman_collection.json: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('has no request for a route the API does not serve', () => {
    const shapes = new Set([...declared].map(shape));
    const extra = [...collected].filter(([route]) => !shapes.has(shape(route)));
    expect(extra.map(([route, name]) => `${name} → ${route}`)).toEqual([]);
  });

  it('documents the refusals too, not only the happy paths', () => {
    // An API reference that only shows success teaches callers nothing about the error envelope.
    expect(negativeProbes().length).toBeGreaterThanOrEqual(3);
  });

  it('describes every request, since the collection doubles as the API reference', () => {
    const walk = (items: PostmanItem[]): string[] =>
      items.flatMap((item) => [
        ...(item.item ? walk(item.item) : []),
        ...(item.request && !item.request.description ? [item.name] : []),
      ]);
    const collection = JSON.parse(readFileSync(COLLECTION, 'utf8')) as { item: PostmanItem[] };
    expect(walk(collection.item)).toEqual([]);
  });
});
