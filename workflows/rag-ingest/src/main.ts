import { embedFromEnv } from '@ai-pipeline/ai/embed';
import { languageModelFromEnv } from '@ai-pipeline/ai/language-model';
import { ragStoreFromEnv } from '@ai-pipeline/rag/store';
import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { ragIngestTrigger } from './trigger.js';
import { metadata } from './unit.js';
import { createRagIngest } from './workflow.js';

await serve({ metadata, contract }, [
  createRagIngest({
    store: ragStoreFromEnv(),
    embed: embedFromEnv(),
    languageModels: languageModelFromEnv(),
  }),
  ragIngestTrigger,
]);
