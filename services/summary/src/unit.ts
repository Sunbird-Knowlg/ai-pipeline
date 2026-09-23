import { SummaryConfig } from '@ai-pipeline/contracts/summary';
import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';

/**
 * This unit's identity and its validated configuration, read once at import.
 *
 * `metadata.json` ships next to `dist/`, and its `config` is checked against the contract's config
 * schema here — so a bad value fails at boot rather than mid-run.
 */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, SummaryConfig);
