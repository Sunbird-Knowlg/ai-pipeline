import { describe, expect, it } from 'vitest';
import { loadConfig, MAX_RAG_TIMEOUT_MS, RAG_TIMEOUTS } from './config.js';

/** The variables core-api cannot start without. */
const REQUIRED = {
  DATABASE_URL: 'postgres://pipeline@postgres:5432/pipeline',
  RESTATE_INGRESS_URL: 'http://restate:8080',
  RESTATE_ADMIN_URL: 'http://restate:9070',
};

describe('the RAG timeouts', () => {
  it('default to 30 s for reads and searches, 240 s for answers', () => {
    expect(loadConfig(REQUIRED)).toMatchObject({
      RAG_QUERY_TIMEOUT_MS: RAG_TIMEOUTS.queryMs,
      RAG_ANSWER_TIMEOUT_MS: RAG_TIMEOUTS.answerMs,
    });
  });

  it('accept up to 290 s', () => {
    const config = loadConfig({
      ...REQUIRED,
      RAG_QUERY_TIMEOUT_MS: String(MAX_RAG_TIMEOUT_MS),
      RAG_ANSWER_TIMEOUT_MS: '290000',
    });
    expect(config).toMatchObject({ RAG_QUERY_TIMEOUT_MS: 290_000, RAG_ANSWER_TIMEOUT_MS: 290_000 });
  });

  // Node's fetch stops waiting for a response's headers after 300 s, and Restate sends none until
  // the call completes: a longer timeout would end there, reported as an outage instead of a 504.
  it.each(['RAG_QUERY_TIMEOUT_MS', 'RAG_ANSWER_TIMEOUT_MS'])(
    'refuse %s above 290 s at boot, naming it',
    (name) => {
      expect(() => loadConfig({ ...REQUIRED, [name]: '290001' })).toThrow(
        `invalid configuration: ${name}`,
      );
    },
  );

  it.each(['0', '-1', '1.5', 'thirty'])('refuse a timeout of %s', (value) => {
    expect(() => loadConfig({ ...REQUIRED, RAG_ANSWER_TIMEOUT_MS: value })).toThrow(
      'invalid configuration: RAG_ANSWER_TIMEOUT_MS',
    );
  });
});
