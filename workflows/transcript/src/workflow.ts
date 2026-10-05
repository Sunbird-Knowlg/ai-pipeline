import type { Generate } from '@ai-pipeline/ai/generate';
import type { BlobDownloader, BlobUploader } from '@ai-pipeline/blob-storage/upload';
import { whisperApi } from '@ai-pipeline/contract-whisper/api';
import type { KnowlgClient } from '@ai-pipeline/knowlg-client/client';
import type { Logger } from '@ai-pipeline/observability/logger';
import { workflowOptions } from '@ai-pipeline/runtime/options';
import { retry } from '@ai-pipeline/runtime/retry';
import * as restate from '@restatedev/restate-sdk';
import { z } from 'zod';
import { transcriptApi } from './api.js';
import { segmentsToJson, segmentsToVtt } from './captions.js';
import { EnrichmentObjectResult, TranscriptSegment } from './schemas.js';
import { translateSegments } from './translate.js';
import { config, metadata } from './unit.js';

export interface TranscriptDeps {
  knowlg: KnowlgClient;
  uploadBlob: BlobUploader;
  downloadBlob: BlobDownloader;
  generate: Generate;
  log: Logger;
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
  const createBody = {
    enrichmentObjectType: 'Transcript',
    parentId,
    channel,
    languageCode: targetLanguage,
  };
  deps.log.debug(
    { event: 'knowlg.request', operation: `knowlg.create-${targetLanguage}`, body: createBody },
    'calling knowlg',
  );
  const created = EnrichmentObjectResult.parse(
    await ctx.run(
      `knowlg.create-${targetLanguage}`,
      () => deps.knowlg.createEnrichmentObject(createBody),
      retry.http,
    ),
  );

  if (created.status === 'Live') {
    deps.log.info(
      {
        event: 'transcript.translation.skip',
        parentId,
        targetLanguage,
        identifier: created.identifier,
      },
      'target language already Live, skipping translation',
    );
    return { identifier: created.identifier, languageCode: targetLanguage, status: created.status };
  }

  const translated = await translateSegments(
    ctx,
    deps.generate,
    deps.log,
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

  const updateBody = {
    artifactUrl: urls.transcriptUrl,
    captionsUrl: urls.captionsUrl,
    autoApproved: true,
    status: 'Processing',
  };
  deps.log.debug(
    { event: 'knowlg.request', operation: `knowlg.update-${targetLanguage}`, body: updateBody },
    'calling knowlg',
  );
  await ctx.run(
    `knowlg.update-${targetLanguage}`,
    () => deps.knowlg.updateEnrichmentObject(created.identifier, updateBody),
    retry.http,
  );

  const approveBody = { status: 'Live' };
  deps.log.debug(
    { event: 'knowlg.request', operation: `knowlg.approve-${targetLanguage}`, body: approveBody },
    'calling knowlg',
  );
  const approved = EnrichmentObjectResult.parse(
    await ctx.run(
      `knowlg.approve-${targetLanguage}`,
      () => deps.knowlg.approveEnrichmentObject(created.identifier, approveBody),
      retry.http,
    ),
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
        deps.log.info(
          { event: 'transcript.start', parentId, channel: input.channel },
          'transcript run started',
        );

        const sourceCreateBody = {
          enrichmentObjectType: 'Transcript',
          parentId,
          channel: input.channel,
          sourceLanguage: true,
        };
        deps.log.debug(
          { event: 'knowlg.request', operation: 'knowlg.create-source', body: sourceCreateBody },
          'calling knowlg',
        );
        const source = EnrichmentObjectResult.parse(
          await ctx.run(
            'knowlg.create-source',
            () => deps.knowlg.createEnrichmentObject(sourceCreateBody),
            retry.http,
          ),
        );

        let sourceLanguageCode: string;
        let sourceSegments: TranscriptSegment[];
        let sourceStatus: string;

        if (source.status === 'Live' && source.languageCode) {
          sourceLanguageCode = source.languageCode;
          sourceStatus = source.status;
          deps.log.info(
            { event: 'transcript.resume', parentId, languageCode: sourceLanguageCode },
            'source already Live, resuming from stored segments',
          );
          sourceSegments = await ctx.run(
            'blob.download-source',
            () => downloadSegments(deps.downloadBlob, parentId, sourceLanguageCode),
            retry.http,
          );
        } else {
          deps.log.info(
            { event: 'transcript.transcribe', parentId },
            'no existing Live source, transcribing fresh',
          );

          deps.log.debug(
            {
              event: 'knowlg.request',
              operation: 'knowlg.read-content',
              body: { identifier: parentId, fields: ['artifactUrl'] },
            },
            'calling knowlg',
          );
          const content = await ctx.run(
            'knowlg.read-content',
            () => deps.knowlg.readContent(parentId, ['artifactUrl']),
            retry.http,
          );
          const artifactUrl = z.string().parse(content.artifactUrl);

          deps.log.debug(
            { event: 'whisper.request', operation: 'whisper.transcribe', body: { artifactUrl } },
            'calling whisper',
          );
          const whisperResult = await ctx.client(whisperApi).transcribe({ artifactUrl });
          deps.log.info(
            {
              event: 'transcript.transcribed',
              parentId,
              language: whisperResult.language,
              languageProbability: whisperResult.languageProbability,
              duration: whisperResult.duration,
              segments: whisperResult.segments.length,
            },
            'transcription complete',
          );

          const sourceUrls = await ctx.run(
            'blob.upload-source',
            () =>
              uploadArtifacts(
                deps.uploadBlob,
                parentId,
                whisperResult.language,
                whisperResult.segments,
              ),
            retry.http,
          );

          const sourceUpdateBody = {
            languageCode: whisperResult.language,
            artifactUrl: sourceUrls.transcriptUrl,
            captionsUrl: sourceUrls.captionsUrl,
            autoApproved: true,
            status: 'Processing',
          };
          deps.log.debug(
            { event: 'knowlg.request', operation: 'knowlg.update-source', body: sourceUpdateBody },
            'calling knowlg',
          );
          await ctx.run(
            'knowlg.update-source',
            () => deps.knowlg.updateEnrichmentObject(source.identifier, sourceUpdateBody),
            retry.http,
          );

          const sourceApproveBody = { status: 'Live' };
          deps.log.debug(
            {
              event: 'knowlg.request',
              operation: 'knowlg.approve-source',
              body: sourceApproveBody,
            },
            'calling knowlg',
          );
          const approvedSource = EnrichmentObjectResult.parse(
            await ctx.run(
              'knowlg.approve-source',
              () => deps.knowlg.approveEnrichmentObject(source.identifier, sourceApproveBody),
              retry.http,
            ),
          );

          sourceLanguageCode = whisperResult.language;
          sourceSegments = whisperResult.segments;
          sourceStatus = approvedSource.status;
        }

        const targetLanguages = config.targetLanguages.filter(
          (lang) => lang !== sourceLanguageCode,
        );
        const translations: TranscriptResult[] = [];
        for (const lang of targetLanguages) {
          translations.push(
            await buildTranslation(ctx, deps, parentId, input.channel, sourceSegments, lang),
          );
        }

        deps.log.info(
          { event: 'transcript.complete', parentId, translations: translations.length },
          'transcript run complete',
        );
        return {
          parentId,
          source: {
            identifier: source.identifier,
            languageCode: sourceLanguageCode,
            status: sourceStatus,
          },
          translations,
        };
      },
    },
    options: workflowOptions(metadata),
  });
}
