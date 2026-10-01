import type { Generate } from '@ai-pipeline/ai/generate';
import type { BlobDownloader, BlobUploader } from '@ai-pipeline/blob-storage/upload';
import { whisperApi } from '@ai-pipeline/contract-whisper/api';
import { workflowOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';
import { transcriptApi } from './api.js';
import { segmentsToJson, segmentsToVtt } from './captions.js';
import {
  approveEnrichmentObject,
  createEnrichmentObject,
  readContent,
  updateEnrichmentObject,
} from './knowlg.js';
import { TranscriptSegment } from './schemas.js';
import { translateSegments } from './translate.js';
import { config, metadata } from './unit.js';

export interface TranscriptDeps {
  knowlgBaseUrl: string;
  uploadBlob: BlobUploader;
  downloadBlob: BlobDownloader;
  generate: Generate;
}

function artifactBase(parentId: string, languageCode: string): string {
  return `content/${parentId}/transcripts/${languageCode}`;
}

async function uploadArtifacts(
  uploadBlob: BlobUploader,
  parentId: string,
  languageCode: string,
  segments: TranscriptSegment[],
): Promise<{ transcriptUrl: string; captionsUrl: string }> {
  const base = artifactBase(parentId, languageCode);
  // Sequential, not Promise.all: lint bans native combinators outright, with no exception for
  // "inside a single ctx.run step" — and two small uploads in a row cost nothing worth fighting it.
  const transcript = await uploadBlob({
    path: `${base}/transcript.json`,
    content: segmentsToJson(segments),
    contentType: 'application/json',
  });
  const captions = await uploadBlob({
    path: `${base}/captions.vtt`,
    content: segmentsToVtt(segments),
    contentType: 'text/vtt',
  });
  return { transcriptUrl: transcript.url, captionsUrl: captions.url };
}

const StoredTranscript = z.object({ segments: z.array(TranscriptSegment) });

/** Re-reads a previously-uploaded `transcript.json` — used to resume against an already-Live node. */
async function downloadSegments(
  downloadBlob: BlobDownloader,
  parentId: string,
  languageCode: string,
): Promise<TranscriptSegment[]> {
  const text = await downloadBlob(`${artifactBase(parentId, languageCode)}/transcript.json`);
  return StoredTranscript.parse(JSON.parse(text)).segments;
}

interface TranscriptResult {
  identifier: string;
  languageCode: string;
  status: string;
}

/**
 * Translates the source transcript into one target language, as its own Transcript sibling.
 *
 * `create()`'s `uniqueOn` matching may return an *existing* sibling already at `Live` — from an
 * earlier run of this same workflow for this same parent (a redelivered trigger, or simply
 * re-running it). When that happens, this skips straight to returning it: translating and
 * re-uploading again would just overwrite identical content, and re-`update()`ing an already-Live
 * node is rejected outright by the platform's edit-lock rule.
 */
async function buildTranslation(
  ctx: restate.Context,
  deps: TranscriptDeps,
  parentId: string,
  channel: string,
  sourceSegments: TranscriptSegment[],
  targetLanguage: string,
): Promise<TranscriptResult> {
  const created = await ctx.run(
    `knowlg.create-${targetLanguage}`,
    () =>
      createEnrichmentObject(deps.knowlgBaseUrl, {
        enrichmentObjectType: 'Transcript',
        parentId,
        channel,
        languageCode: targetLanguage,
      }),
    retry.http,
  );

  if (created.status === 'Live')
    return { identifier: created.identifier, languageCode: targetLanguage, status: created.status };

  const translated = await translateSegments(
    ctx,
    deps.generate,
    sourceSegments,
    targetLanguage,
    config.translationModel,
    config.translationBatchSize,
    config.translationBatchOverlap,
  );

  const urls = await ctx.run(
    `blob.upload-${targetLanguage}`,
    () => uploadArtifacts(deps.uploadBlob, parentId, targetLanguage, translated),
    retry.http,
  );

  await ctx.run(
    `knowlg.update-${targetLanguage}`,
    () =>
      updateEnrichmentObject(deps.knowlgBaseUrl, created.identifier, {
        artifactUrl: urls.transcriptUrl,
        captionsUrl: urls.captionsUrl,
        autoApproved: true,
        status: 'Processing',
      }),
    retry.http,
  );

  const approved = await ctx.run(
    `knowlg.approve-${targetLanguage}`,
    () => approveEnrichmentObject(deps.knowlgBaseUrl, created.identifier, 'Live'),
    retry.http,
  );

  return { identifier: created.identifier, languageCode: targetLanguage, status: approved.status };
}

/**
 * Generates a source-language transcript for a Content's video/audio artifact, then translates it
 * into every configured target language, each as its own Transcript sibling.
 *
 * 1. Read the Content for its artifact — the enrichment-request event itself never carries this,
 *    deliberately, so the event stays objectType-agnostic.
 * 2. Create the source Transcript (`sourceLanguage: true`) — `create()`'s own `uniqueOn` matching
 *    makes this idempotent on a redelivered/retried trigger. If that match is already `Live`
 *    (an earlier run finished it), re-download its stored segments instead of re-transcribing —
 *    same reasoning as `buildTranslation`'s own already-Live shortcut.
 * 3. Otherwise, transcribe via Whisper — no `language` hint, so the source language is detected,
 *    not assumed.
 * 4. Upload the transcript/captions, self-report `Processing`, then auto-approve to `Live` — no
 *    human review in this phase.
 * 5. Translate into every configured target language, sequentially (see `buildTranslation`'s own
 *    doc comment for why this isn't `RestatePromise.all`) — one language's failure doesn't corrupt
 *    another's already-written state.
 */
export function createTranscript(deps: TranscriptDeps) {
  return restate.implement(transcriptApi, {
    handlers: {
      run: async (ctx, { input, trigger }) => {
        ctx.set('trigger', trigger);
        ctx.set('version', metadata.version);

        const parentId = input.identifier;

        const source = await ctx.run(
          'knowlg.create-source',
          () =>
            createEnrichmentObject(deps.knowlgBaseUrl, {
              enrichmentObjectType: 'Transcript',
              parentId,
              channel: input.channel,
              sourceLanguage: true,
            }),
          retry.http,
        );

        let sourceLanguageCode: string;
        let sourceSegments: TranscriptSegment[];
        let sourceStatus: string;

        if (source.status === 'Live' && source.languageCode) {
          sourceLanguageCode = source.languageCode;
          sourceStatus = source.status;
          sourceSegments = await ctx.run(
            'blob.download-source',
            () => downloadSegments(deps.downloadBlob, parentId, sourceLanguageCode),
            retry.http,
          );
        } else {
          const content = await ctx.run(
            'knowlg.read-content',
            () => readContent(deps.knowlgBaseUrl, parentId),
            retry.http,
          );

          const whisperResult = await ctx
            .client(whisperApi)
            .transcribe({ artifactUrl: content.artifactUrl });

          const sourceUrls = await ctx.run(
            'blob.upload-source',
            () =>
              uploadArtifacts(deps.uploadBlob, parentId, whisperResult.language, whisperResult.segments),
            retry.http,
          );

          await ctx.run(
            'knowlg.update-source',
            () =>
              updateEnrichmentObject(deps.knowlgBaseUrl, source.identifier, {
                languageCode: whisperResult.language,
                artifactUrl: sourceUrls.transcriptUrl,
                captionsUrl: sourceUrls.captionsUrl,
                autoApproved: true,
                status: 'Processing',
              }),
            retry.http,
          );

          const approvedSource = await ctx.run(
            'knowlg.approve-source',
            () => approveEnrichmentObject(deps.knowlgBaseUrl, source.identifier, 'Live'),
            retry.http,
          );

          sourceLanguageCode = whisperResult.language;
          sourceSegments = whisperResult.segments;
          sourceStatus = approvedSource.status;
        }

        const targetLanguages = config.targetLanguages.filter((lang) => lang !== sourceLanguageCode);
        const translations: TranscriptResult[] = [];
        for (const lang of targetLanguages) {
          translations.push(
            await buildTranslation(ctx, deps, parentId, input.channel, sourceSegments, lang),
          );
        }

        return {
          parentId,
          source: { identifier: source.identifier, languageCode: sourceLanguageCode, status: sourceStatus },
          translations,
        };
      },
    },
    options: workflowOptions(metadata),
  });
}
