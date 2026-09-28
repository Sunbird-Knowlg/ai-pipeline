import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';
import { TranscriptConfig } from './schemas.js';

/** This unit's identity and its validated configuration, read once at import. */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, TranscriptConfig);
