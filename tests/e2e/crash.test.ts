import type { StartRunAccepted } from '@ai-pipeline/api-contract/workflows';
import { describe, expect, it } from 'vitest';
import { api, docker, restateSql, uniq, waitForRun } from './support.js';

const running = (label: string) =>
  docker('ps', '--filter', `label=ai-pipeline.name=${label}`, '--format', '{{.Names}}')
    .split('\n')
    .filter(Boolean);

/** Durable execution: killing runtimes mid-run neither loses the run nor repeats journaled work. */
describe('crash recovery', () => {
  it('completes a run after both runtimes are killed while the summary call is in flight', async () => {
    const text = 'Durable execution means that a crash does not lose progress. '.repeat(30);
    const start = await api<StartRunAccepted>('POST', '/v1/workflows/content-enrichment/runs', {
      input: { contentId: `crash-${uniq()}`, text },
    });
    expect(start.status).toBe(202);
    const parent = start.body.invocationId;

    // Wait until the parent has called SummaryService, then kill both runtimes.
    await expect
      .poll(
        async () =>
          (await restateSql(`SELECT id FROM sys_invocation WHERE invoked_by_id = '${parent}'`))
            .length,
        {
          timeout: 60_000,
          interval: 200,
        },
      )
      .toBe(1);
    const containers = [...running('content-enrichment'), ...running('summary')];
    for (const c of containers) docker('kill', c);
    for (const c of containers) docker('start', c);

    const run = await waitForRun('content-enrichment', start.body.runId);
    expect(run.status).toBe('completed');
    expect((run.output as { summary: string }).summary.length).toBeGreaterThan(10);

    // The durable call was not re-issued by the replaying parent…
    const calls = await restateSql<{ id: string }>(
      `SELECT id FROM sys_invocation WHERE invoked_by_id = '${parent}'`,
    );
    expect(calls).toHaveLength(1);
    // …and the LLM step was journaled exactly once.
    const steps = await restateSql(
      `SELECT index FROM sys_journal WHERE id = '${calls[0]!.id}' AND entry_type = 'Command: Run' AND name = 'llm.generate-summary'`,
    );
    expect(steps).toHaveLength(1);
  });
});
