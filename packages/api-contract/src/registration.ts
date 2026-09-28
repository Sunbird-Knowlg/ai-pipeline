import { z } from 'zod';
import { deploymentRegistered } from './deployments.js';

/**
 * How a unit's runtime reports its own registration.
 *
 * A unit registers itself on boot (`@ai-pipeline/runtime/serve`), so whoever started it — `pipeline
 * deploy` locally, a Deployment in a cluster — learns the outcome from the process, not from a
 * response. The runtime writes exactly one structured log line tagged `event: REGISTRATION_EVENT`
 * per boot, and `pipeline deploy` reads it back from the container's logs. Both sides import this
 * file, so renaming a field breaks the build on both rather than making deploys hang.
 *
 * - `registered`: core-api accepted the build; `result` is its reply.
 * - `refused`: core-api answered with an error envelope. Whether anything was registered depends on
 *   the code (`PRE_REGISTRATION_CODES`), exactly as for a direct `POST /v1/deployments`.
 * - `invalid`: the runtime refused its own request before sending it — a missing setting, or a
 *   contract that disagrees with `metadata.json`. Nothing was registered.
 * - `failed`: core-api could not be reached, or kept answering 502/503. Registration may or may not
 *   have happened.
 */
export const REGISTRATION_EVENT = 'ai-pipeline.registration';

export const registrationOutcome = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('registered'), result: deploymentRegistered }),
  z.object({
    outcome: z.literal('refused'),
    status: z.number().int(),
    code: z.string(),
    message: z.string(),
  }),
  z.object({ outcome: z.literal('invalid'), message: z.string() }),
  z.object({ outcome: z.literal('failed'), message: z.string() }),
]);
export type RegistrationOutcome = z.infer<typeof registrationOutcome>;
