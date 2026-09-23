import { ContentConfig } from '@ai-pipeline/contracts/content-enrichment';
import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';

/**
 * This unit's identity and its validated configuration, read once at import. A bad `config` value in
 * `metadata.json` fails here, at boot, rather than part-way through a run.
 */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, ContentConfig);
