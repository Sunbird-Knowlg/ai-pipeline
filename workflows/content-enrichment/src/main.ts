import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { contentEnrichmentTrigger } from './trigger.js';
import { metadata } from './unit.js';
import { contentEnrichment } from './workflow.js';

await serve({ metadata, contract }, [contentEnrichment, contentEnrichmentTrigger]);
