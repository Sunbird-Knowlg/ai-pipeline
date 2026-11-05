import { execFileSync } from 'node:child_process';
import { cli } from './support.js';

/**
 * Builds and deploys the example units once per e2e run
 * (idempotent: unchanged artifacts are reused).
 *
 * `whisper` is not deployed here: it is a Python service with no `package.json`/`src/main.ts`, so
 * the CLI's unit discovery (`apps/cli/src/units.ts`) does not see it as a deployable unit at all —
 * a pre-existing gap, not something this file can paper over.
 */
export default async function setup() {
  execFileSync('pnpm', ['turbo', 'run', 'build', '--output-logs=errors-only'], {
    stdio: 'inherit',
  });
  cli('deploy', 'transcript');
}
