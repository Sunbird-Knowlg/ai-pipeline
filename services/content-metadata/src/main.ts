import { generateFromEnv } from '@ai-pipeline/ai/generate';
import { serve } from '@ai-pipeline/runtime/serve';
import { createContentMetadataService } from './service.js';
import { metadata } from './unit.js';

await serve(metadata.name, [createContentMetadataService(generateFromEnv())]);
