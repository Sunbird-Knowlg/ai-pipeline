import { describe, expect, it } from 'vitest';
import { toRunView } from '../views.js';
import { decodeCursor, encodeCursor, getRunSql, listRunsSql, mapStatus } from './invocations.js';
import { quote } from './sql.js';

describe('mapStatus', () => {
  it.each([
    [{ status: 'running' }, 'running'],
    [{ status: 'suspended' }, 'running'],
    [{ status: 'backing-off' }, 'running'],
    [{ status: 'paused' }, 'paused'],
    [{ status: 'completed', completion_result: 'success' }, 'completed'],
    [
      { status: 'completed', completion_result: 'failure', completion_failure: '[409] Cancelled' },
      'cancelled',
    ],
    [
      { status: 'completed', completion_result: 'failure', completion_failure: '[500] boom' },
      'failed',
    ],
  ] as const)('%j → %s', (row, expected) => expect(mapStatus(row)).toBe(expected));
});

describe('SQL builders', () => {
  it('quotes literals', () => expect(quote("a'b")).toBe("'a''b'"));

  it('builds a keyset page query', () => {
    const cursor = encodeCursor({ created_at: '2026-09-22T16:03:34.261Z', id: 'inv_abc' });
    const sql = listRunsSql({
      services: ['ContentEnrichment'],
      status: 'failed',
      limit: 20,
      cursor,
    });
    expect(sql).toContain("target_service_name IN ('ContentEnrichment')");
    expect(sql).toContain("created_at < CAST('2026-09-22T16:03:34.261Z' AS TIMESTAMP)");
    expect(sql).toContain("id < 'inv_abc'");
    expect(sql).toMatch(/LIMIT 21$/);
  });

  it('rejects injection attempts', () => {
    expect(() => listRunsSql({ services: ["X' OR '1'='1"], limit: 1 })).toThrow(/invalid workflow/);
    expect(() => getRunSql('ContentEnrichment', "a' OR 1=1 --")).toThrow(/invalid/);
    expect(() => decodeCursor(Buffer.from('["x","inv_1"]').toString('base64url'))).toThrow(
      /cursor/,
    );
  });

  it('round-trips cursors', () => {
    const c = encodeCursor({ created_at: '2026-09-22T16:03:34.261Z', id: 'inv_1' });
    expect(decodeCursor(c)).toEqual({ createdAt: '2026-09-22T16:03:34.261Z', id: 'inv_1' });
  });
});

describe('toRunView', () => {
  it('combines the invocation row with recorded trigger/version state', () => {
    const view = toRunView(
      {
        id: 'inv_1',
        target_service_name: 'ContentEnrichment',
        target_service_key: 'kf_1',
        status: 'completed',
        completion_result: 'success',
        created_at: 't0',
        completed_at: 't1',
        pinned_deployment_id: 'dp_1',
        trace_id: 'abc',
      },
      'content-enrichment',
      { trigger: { type: 'kafka', offset: 3 }, version: '0.1.0' },
    );
    expect(view).toEqual({
      runId: 'kf_1',
      invocationId: 'inv_1',
      workflow: 'content-enrichment',
      workflowVersion: '0.1.0',
      deploymentId: 'dp_1',
      status: 'completed',
      restateStatus: 'completed',
      trigger: { type: 'kafka', offset: 3 },
      createdAt: 't0',
      completedAt: 't1',
      traceId: 'abc',
    });
  });
});
