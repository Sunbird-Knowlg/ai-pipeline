import { serve } from '@ai-pipeline/runtime/serve';
import { contentEnrichmentTrigger } from './trigger.js';
import { metadata } from './unit.js';
import { contentEnrichment } from './workflow.js';

await serve(metadata.name, [contentEnrichment, contentEnrichmentTrigger]);
