import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The provisioned schema, checked against the SQL the repositories actually run.
 *
 * The API creates nothing: the catalogue tables are created when Postgres is provisioned
 * (`infra/postgres/init`), and the service assumes they are already there. That split is the right
 * one — the API needs no DDL privileges — but it removes the feedback you get from an app that
 * creates its own tables: add a query against a table nobody provisioned, and you find out in
 * production.
 *
 * So this derives the table names from the repository sources and requires the provisioning SQL to
 * create each one.
 */
const STORE = new URL('./', import.meta.url);
const PROVISIONING = new URL('../../../../infra/postgres/init/', import.meta.url);

/**
 * SQL keywords that can follow FROM/INTO/UPDATE/JOIN in the shapes used here — `UPDATE … SET`, for
 * instance — and are not table names.
 */
const KEYWORDS = new Set(['set', 'select', 'values', 'where', 'only', 'distinct']);

/** Comments read like SQL often enough to matter — "taken from", "update the route" — so strip them. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Tables the repositories read or write, taken from the SQL in their string literals. */
function tablesQueried(): Set<string> {
  const tables = new Set<string>();
  for (const file of readdirSync(STORE).filter((f) => f.endsWith('.ts') && !f.includes('.test.'))) {
    const code = withoutComments(readFileSync(new URL(file, STORE), 'utf8'));
    // Only inside string literals: that is where the SQL is.
    for (const literal of code.matchAll(/(['"`])((?:\\.|(?!\1)[\s\S])*)\1/g)) {
      for (const match of literal[2]!.matchAll(
        /\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z0-9_]*)/gi,
      )) {
        const table = match[1]!.toLowerCase();
        // Restate owns `sys_*` and `state`; they are not ours to provision.
        if (table.startsWith('sys_') || table === 'state' || KEYWORDS.has(table)) continue;
        tables.add(table);
      }
    }
  }
  return tables;
}

const provisioningSql = (): string =>
  readdirSync(PROVISIONING)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, PROVISIONING), 'utf8'))
    .join('\n');

describe('the provisioned catalogue schema', () => {
  const sql = provisioningSql();

  it('creates every table the repositories query', () => {
    const missing = [...tablesQueried()].filter(
      (table) => !new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i').test(sql),
    );
    expect(missing, `queried but never provisioned: ${missing.join(', ')}`).toEqual([]);
  });

  it('creates the four catalogue tables', () => {
    for (const table of [
      'workflow_definitions',
      'workflow_deployments',
      'workflow_dependencies',
      'workflow_triggers',
    ])
      expect(sql, table).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  });

  it('is re-runnable, so applying it to an existing database is safe', () => {
    // Provisioning may be re-applied — a re-provisioned environment, a hand-applied change — and
    // `docker-entrypoint-initdb.d` gives no second chance to get this right.
    const creates = sql.match(/CREATE (TABLE|INDEX)[^;]*/gi) ?? [];
    expect(creates.length).toBeGreaterThan(4);
    for (const statement of creates)
      expect(statement.toUpperCase(), statement.slice(0, 60)).toContain('IF NOT EXISTS');
  });

  it('keeps execution state out of Postgres', () => {
    // Restate is the run store. A table that looks like a run table is a design regression.
    expect(sql).not.toMatch(/CREATE TABLE IF NOT EXISTS (runs|invocations|workflow_runs)\b/i);
  });

  it('is not created by the application', () => {
    const appSources = readdirSync(STORE).filter((f) => f.endsWith('.ts') && !f.includes('.test.'));
    for (const file of appSources) {
      const source = readFileSync(new URL(file, STORE), 'utf8');
      expect(source, `${file} must not create tables`).not.toMatch(/CREATE TABLE/i);
    }
  });
});
