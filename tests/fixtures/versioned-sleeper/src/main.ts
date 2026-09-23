import { serve } from '@ai-pipeline/runtime/serve';
import { metadata } from './unit.js';
import { versionedSleeper } from './workflow.js';

await serve(metadata.name, [versionedSleeper]);
