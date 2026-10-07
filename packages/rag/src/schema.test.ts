import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The RAG store's SQL, checked against what provisioning creates (`infra/postgres/init/30-rag.sql`),
 * as `apps/core-api/src/store/schema.test.ts` does for the catalogue: a query against a table nobody
 * provisioned fails here, not in production.
 */
/** Comments read like SQL often enough to matter, and their apostrophes look like strings. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const SOURCE = withoutComments(readFileSync(new URL('./store.ts', import.meta.url), 'utf8'));
const SQL = readFileSync(
  new URL('../../../infra/postgres/init/30-rag.sql', import.meta.url),
  'utf8',
);

/** Vector tables are created at run time by PgVector, in the `vectors` schema, never named here. */
const RUNTIME = new Set(['set', 'select', 'values', 'where', 'only', 'distinct']);

function tablesQueried(): Set<string> {
  const tables = new Set<string>();
  for (const literal of SOURCE.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g))
    for (const match of literal[2]!.matchAll(
      /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi,
    )) {
      const table = match[1]!.toLowerCase();
      if (!RUNTIME.has(table)) tables.add(table);
    }
  return tables;
}

describe('the provisioned RAG schema', () => {
  it('creates every table the store queries', () => {
    const queried = [...tablesQueried()];
    expect(queried.sort()).toEqual(['rag_collections', 'rag_documents']);
    for (const table of queried)
      expect(SQL, table).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  });

  it('is re-runnable', () => {
    for (const statement of SQL.match(/CREATE (TABLE|INDEX|SCHEMA|EXTENSION)[^;]*/gi) ?? [])
      expect(statement.toUpperCase(), statement.slice(0, 60)).toContain('IF NOT EXISTS');
    expect(SQL).toContain('WHERE NOT EXISTS (SELECT FROM pg_database');
  });

  it('creates the extension and the vectors schema, so the units need no superuser', () => {
    expect(SQL).toContain('CREATE EXTENSION IF NOT EXISTS vector');
    expect(SQL).toContain('CREATE SCHEMA IF NOT EXISTS vectors');
  });
});
