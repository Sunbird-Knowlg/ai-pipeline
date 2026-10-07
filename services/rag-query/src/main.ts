import { embedFromEnv } from '@ai-pipeline/ai/embed';
import { generateFromEnv } from '@ai-pipeline/ai/generate';
import { ragStoreFromEnv } from '@ai-pipeline/rag/store';
import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { createRagQueryService } from './service.js';
import { metadata } from './unit.js';

await serve({ metadata, contract }, [
  createRagQueryService({
    store: ragStoreFromEnv(),
    embed: embedFromEnv(),
    generate: generateFromEnv(),
  }),
]);
