import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';
import { RagQueryConfig, configProblems } from './schemas.js';

/**
 * This unit's identity and its validated configuration, read once at import, so a bad value fails
 * at boot rather than on a request.
 */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, RagQueryConfig);

const problems = configProblems(config);
if (problems.length > 0)
  throw new Error(`invalid config in ${metadata.name}/metadata.json: ${problems.join('; ')}`);
