import { generateFromEnv } from '@ai-pipeline/ai/generate';
import { blobDownloaderFromEnv, blobUploaderFromEnv } from '@ai-pipeline/blob-storage/upload';
import { serve } from '@ai-pipeline/runtime/serve';
import { contract } from './contract.js';
import { transcriptTrigger } from './trigger.js';
import { metadata } from './unit.js';
import { createTranscript } from './workflow.js';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

await serve({ metadata, contract }, [
  createTranscript({
    knowlgBaseUrl: requireEnv('KNOWLG_BASE_URL'),
    uploadBlob: blobUploaderFromEnv(),
    downloadBlob: blobDownloaderFromEnv(),
    generate: generateFromEnv(),
  }),
  transcriptTrigger,
]);
