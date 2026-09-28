import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { logPublisher } from './publish.js';
import { contentAuthoringTrigger } from './trigger.js';
import { metadata } from './unit.js';
import { createContentAuthoring } from './workflow.js';

await serve({ metadata, contract }, [
  createContentAuthoring(logPublisher(metadata.name)),
  contentAuthoringTrigger,
]);
