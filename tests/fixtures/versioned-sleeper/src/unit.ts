import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';
import { SleeperConfig } from './contract.js';

export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, SleeperConfig);
