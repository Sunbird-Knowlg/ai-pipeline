import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';
import { configProblems } from './plan.js';
import { RagIngestConfig } from './schemas.js';

/** This unit's identity and its validated configuration, read once at import. */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, RagIngestConfig);

const problems = configProblems(config);
if (problems.length > 0)
  throw new Error(`invalid config in ${metadata.name}/metadata.json: ${problems.join('; ')}`);
