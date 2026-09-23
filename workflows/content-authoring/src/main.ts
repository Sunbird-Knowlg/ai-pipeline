import { serve } from '@ai-pipeline/runtime/serve';
import { logPublisher } from './publish.js';
import { contentAuthoringTrigger } from './trigger.js';
import { metadata } from './unit.js';
import { createContentAuthoring } from './workflow.js';

await serve(metadata.name, [
  createContentAuthoring(logPublisher(metadata.name)),
  contentAuthoringTrigger,
]);
