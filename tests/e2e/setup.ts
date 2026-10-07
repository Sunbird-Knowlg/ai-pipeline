import { execFileSync } from 'node:child_process';
import { cli } from './support.js';

/**
 * Builds and deploys the example units once per e2e run
 * (idempotent: unchanged artifacts are reused).
 *
 * Services before the workflows that call them: a workflow whose dependency is not yet registered
 * is refused by the control plane.
 */
export default async function setup() {
  execFileSync('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only'], {
    stdio: 'inherit',
  });
  cli('deploy', 'summary');
  cli('deploy', 'content-metadata');
  cli('deploy', 'quiz-generate');
  cli('deploy', 'content-enrichment');
  cli('deploy', 'content-authoring');
  cli('deploy', 'rag-query');
  cli('deploy', 'rag-ingest');
}
