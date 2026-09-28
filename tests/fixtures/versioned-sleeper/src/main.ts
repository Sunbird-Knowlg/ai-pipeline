import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { metadata } from './unit.js';
import { versionedSleeper } from './workflow.js';

await serve({ metadata, contract }, [versionedSleeper]);
