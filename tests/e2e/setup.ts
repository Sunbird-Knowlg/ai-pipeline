import { execFileSync } from 'node:child_process';
import { cli } from './support.js';

/**
 * Builds (the CLI reads contracts from dist/) and deploys the example units once per e2e run
 * (idempotent: unchanged artifacts are reused).
 */
export default async function setup() {
  execFileSync('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only'], {
    stdio: 'inherit',
  });
  cli('deploy', 'summary');
  cli('deploy', 'content-enrichment');
}
