import { generateFromEnv } from '@ai-pipeline/ai/generate';
import { serve } from '@ai-pipeline/runtime/serve';
import { createSummaryService } from './service.js';
import { metadata } from './unit.js';

await serve(metadata.name, [createSummaryService(generateFromEnv())]);
