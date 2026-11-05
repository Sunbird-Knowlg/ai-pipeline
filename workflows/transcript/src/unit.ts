import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';
import { TranscriptConfig } from './schemas.js';

/**
 * This unit's identity and its validated configuration, read once at import. A bad `config` value in
 * `metadata.json` fails here, at boot, rather than part-way through a run.
 */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, TranscriptConfig);

// Cross-field/semantic checks that can't live on TranscriptConfig itself: the schema doubles as
// this unit's published contract (contract.ts), and a `.refine()` there would be silently dropped
// by `z.toJSONSchema` -- `contractSchemas()` refuses to build a contract that does that (see
// packages/contracts/src/schemas.ts) rather than publish a catalogue schema weaker than what boot
// actually enforces.
if (config.translationBatchOverlap >= config.translationBatchSize) {
  throw new Error(
    `invalid config in ${metadata.name}/metadata.json: translationBatchOverlap ` +
      `(${config.translationBatchOverlap}) must be smaller than translationBatchSize ` +
      `(${config.translationBatchSize}) -- makeBatches never terminates otherwise`,
  );
}
if (new Set(config.targetLanguages).size !== config.targetLanguages.length) {
  throw new Error(
    `invalid config in ${metadata.name}/metadata.json: targetLanguages must not contain duplicates`,
  );
}
for (const tag of config.targetLanguages) {
  try {
    Intl.getCanonicalLocales(tag);
  } catch {
    throw new Error(
      `invalid config in ${metadata.name}/metadata.json: targetLanguages contains ` +
        `"${tag}", which is not a valid BCP-47 language tag`,
    );
  }
}
