import { generateFromEnv } from '@ai-pipeline/ai/generate';
import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { createSummaryService } from './service.js';
import { metadata } from './unit.js';

await serve({ metadata, contract }, [createSummaryService(generateFromEnv())]);
