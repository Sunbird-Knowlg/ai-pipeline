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
import { languageName } from './language.js';
import { EnrichmentObjectResult, isTranscriptEligible, TranscriptSegment } from './schemas.js';
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

/** Parses a knowlg EnrichmentObject response, naming the failing operation in the error. A bad
 *  shape here is knowlg returning something this workflow doesn't understand — not a transient
 *  fault worth retrying blind against the same journaled bytes, so it fails the run terminally
 *  instead of retrying 10 times and pausing. */
function parseEnrichmentObjectResult(raw: unknown, operation: string): EnrichmentObjectResult {
  const parsed = EnrichmentObjectResult.safeParse(raw);
  if (!parsed.success) {
    throw new restate.TerminalError(
      `${operation}: knowlg response does not match the expected EnrichmentObject shape: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * True when this publish event itself reports the Content's artifact changing -- i.e. knowlg-publish
 * computed a different hash for this publish than it read off the node immediately before. Both
 * values come from the *same* event (see `schemas.ts`'s `TranscriptInput`), so this needs nothing
 * stored anywhere on the Transcript side: no write to knowlg (its `EnrichmentObject` schema is
 * deliberately strict about unknown fields), and no denormalized copy of a Content-level fact onto
 * a child object (the kind of copy the project's own design doc traces a past production incident
 * to). `artifactHash` undefined means knowlg-publish has no hash to report (not yet deployed, or
 * this publish's hashing failed) -- no signal, so treated as "unchanged" rather than guessed at.
 */
function isArtifactReplaced(input: { artifactHash?: string; prevArtifactHash?: string }): boolean {
  return input.artifactHash !== undefined && input.artifactHash !== input.prevArtifactHash;
}

/**
 * Creates (or resumes) one EnrichmentObject sibling for a logical key — the source, or one target
 * language. `create()`'s `uniqueOn` matching can return an *existing* sibling instead of a new
 * node; if that sibling is already `Live` and this same publish event reports the Content's artifact
 * replaced (`isArtifactReplaced`), it was transcribed from a video that has since been replaced.
 * Retire it (`Live` -> `Retired`, which `searchSiblings` then ignores) and create fresh in its
 * place, rather than resuming or skipping translation against stale content.
 */
async function createOrRefreshNode(
  ctx: restate.Context,
  deps: TranscriptDeps,
  stepPrefix: string,
  createBody: Record<string, unknown>,
  artifactReplaced: boolean,
): Promise<EnrichmentObjectResult> {
  const first = parseEnrichmentObjectResult(
    await ctx.run(
      `${stepPrefix}-create`,
      () => deps.knowlg.createEnrichmentObject(createBody),
      retry.http,
    ),
    `${stepPrefix}-create`,
  );
  if (first.status !== 'Live' || !artifactReplaced) return first;

  ctx.console.info(
    { event: 'transcript.stale', identifier: first.identifier },
    'this publish reports the artifact replaced; retiring and recreating the existing node',
  );
  await ctx.run(
    `${stepPrefix}-retire-stale`,
    () => deps.knowlg.rejectEnrichmentObject(first.identifier, { status: 'Retired' }),
    retry.http,
  );
  return parseEnrichmentObjectResult(
    await ctx.run(
      `${stepPrefix}-recreate`,
      () => deps.knowlg.createEnrichmentObject(createBody),
      retry.http,
    ),
    `${stepPrefix}-recreate`,
  );
}

/**
 * Translates the source transcript into one target language, as its own Transcript sibling.
 *
 * `create()`'s `uniqueOn` matching may return an *existing* sibling already at `Live` — from an
 * earlier run of this same workflow for this same parent (a redelivered trigger, or simply
 * re-running it). When that happens, and this publish doesn't report the artifact replaced, this
 * skips straight to returning it: translating and re-uploading again would just overwrite identical
 * content, and re-`update()`ing an already-Live node is rejected outright by the platform's
 * edit-lock rule. When the artifact was replaced, `createOrRefreshNode` has already retired it and
 * handed back a fresh node, so this falls through to translating again.
 */
async function buildTranslation(
  ctx: restate.Context,
  deps: TranscriptDeps,
  parentId: string,
  channel: string,
  sourceSegments: TranscriptSegment[],
  targetLanguage: string,
  artifactReplaced: boolean,
): Promise<TranscriptResult> {
  const createBody = {
    enrichmentObjectType: 'Transcript',
    parentId,
    channel,
    languageCode: targetLanguage,
  };
  ctx.console.debug(
    { event: 'knowlg.request', operation: `knowlg.create-${targetLanguage}`, body: createBody },
    'calling knowlg',
  );
  const created = await createOrRefreshNode(
    ctx,
    deps,
    `knowlg.${targetLanguage}`,
    createBody,
    artifactReplaced,
  );
  ctx.console.debug(
    {
      event: 'knowlg.response',
      operation: `knowlg.create-${targetLanguage}`,
      identifier: created.identifier,
      status: created.status,
    },
    'knowlg responded',
  );

  if (created.status === 'Live') {
    ctx.console.info(
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

  ctx.console.debug(
    {
      event: 'blob.upload.start',
      operation: `blob.upload-${targetLanguage}`,
      parentId,
      targetLanguage,
    },
    'uploading translated transcript and captions',
  );
  // Uncapped from here on: an outage now would throw away this language's already-completed,
  // expensive LLM translation, not just a cheap call worth retrying fresh.
  const urls = await ctx.run(
    `blob.upload-${targetLanguage}`,
    () => uploadArtifacts(deps.uploadBlob, parentId, targetLanguage, translated),
    retry.httpResumable,
  );
  ctx.console.debug(
    {
      event: 'blob.upload.complete',
      operation: `blob.upload-${targetLanguage}`,
      transcriptUrl: urls.transcriptUrl,
      captionsUrl: urls.captionsUrl,
    },
    'upload complete',
  );

  const updateBody = {
    language: languageName(targetLanguage),
    artifactUrl: urls.transcriptUrl,
    captionsUrl: urls.captionsUrl,
    autoApproved: true,
    status: 'Processing',
  };
  ctx.console.debug(
    { event: 'knowlg.request', operation: `knowlg.update-${targetLanguage}`, body: updateBody },
    'calling knowlg',
  );
  await ctx.run(
    `knowlg.update-${targetLanguage}`,
    () => deps.knowlg.updateEnrichmentObject(created.identifier, updateBody),
    retry.httpResumable,
  );
  ctx.console.debug(
    {
      event: 'knowlg.response',
      operation: `knowlg.update-${targetLanguage}`,
      identifier: created.identifier,
    },
    'knowlg responded',
  );

  const approveBody = { status: 'Live' };
  ctx.console.debug(
    { event: 'knowlg.request', operation: `knowlg.approve-${targetLanguage}`, body: approveBody },
    'calling knowlg',
  );
  const approved = parseEnrichmentObjectResult(
    await ctx.run(
      `knowlg.approve-${targetLanguage}`,
      () => deps.knowlg.approveEnrichmentObject(created.identifier, approveBody),
      retry.httpResumable,
    ),
    `knowlg.approve-${targetLanguage}`,
  );
  ctx.console.info(
    {
      event: 'transcript.language.complete',
      parentId,
      targetLanguage,
      identifier: approved.identifier,
      status: approved.status,
    },
    'language complete',
  );

  return { identifier: created.identifier, languageCode: targetLanguage, status: approved.status };
}

/**
 * Generates a source-language transcript for a Content's video artifact, then translates it
 * into every configured target language, each as its own Transcript sibling.
 *
 * 1. Read the Content for its artifact — the enrichment-request event itself never carries this,
 *    deliberately, so the event stays objectType-agnostic.
 * 2. Create the source Transcript (`sourceLanguage: true`) — `create()`'s own `uniqueOn` matching
 *    makes this idempotent on a redelivered/retried trigger. If that match is already `Live` and
 *    this publish doesn't report the artifact replaced (`isArtifactReplaced`), re-download its
 *    stored segments instead of re-transcribing (same reasoning as `buildTranslation`'s own
 *    already-Live shortcut). If the artifact was replaced, `createOrRefreshNode` retires the stale
 *    node and hands back a fresh one, so this transcribes again.
 * 3. Otherwise, transcribe via Whisper — no `language` hint, so the source language is detected,
 *    not assumed.
 * 4. Upload the transcript/captions, self-report `Processing`, then auto-approve to `Live` — no
 *    human review in this phase.
 * 5. Translate into every configured target language, sequentially (see `buildTranslation`'s own
 *    doc comment for why this isn't `RestatePromise.all`) — one language's failure doesn't corrupt
 *    another's already-written state.
 *
 * Known gap (PR #4 review, "two runs for the same Content can overlap"): two triggers for the same
 * Content — a re-publish arriving while the first run is still in Whisper, which can take minutes —
 * are not serialized against each other. A Virtual Object keyed by `identifier` was tried and
 * reverted: it conflicts with core-api's rule that one deployment endpoint may serve only a unit's
 * own service and its trigger sink, nothing else (`checkEndpointServes`,
 * apps/core-api/src/domain/registration.ts). A proper fix needs its own deployable unit (so the
 * lock lives behind a separate endpoint) and is deferred.
 */
export function createTranscript(deps: TranscriptDeps) {
  return restate.implement(transcriptApi, {
    handlers: {
      run: async (ctx, { input, trigger }) => {
        ctx.set('trigger', trigger);
        ctx.set('version', metadata.version);

        // The Kafka adapter already applies this; the REST trigger has no adapter of its own, so
        // without this a REST caller could push a non-video Content all the way to Whisper.
        if (!isTranscriptEligible(input.objectType, input.mimeType)) {
          throw new restate.TerminalError(
            `Transcript does not support objectType "${input.objectType}" / mimeType "${input.mimeType}"`,
          );
        }

        const parentId = input.identifier;
        const artifactReplaced = isArtifactReplaced(input);
        ctx.console.info(
          { event: 'transcript.start', parentId, channel: input.channel },
          'transcript run started',
        );

        const sourceCreateBody = {
          enrichmentObjectType: 'Transcript',
          parentId,
          channel: input.channel,
          sourceLanguage: true,
        };
        ctx.console.debug(
          { event: 'knowlg.request', operation: 'knowlg.create-source', body: sourceCreateBody },
          'calling knowlg',
        );
        const source = await createOrRefreshNode(
          ctx,
          deps,
          'knowlg.source',
          sourceCreateBody,
          artifactReplaced,
        );
        ctx.console.debug(
          {
            event: 'knowlg.response',
            operation: 'knowlg.create-source',
            identifier: source.identifier,
            status: source.status,
          },
          'knowlg responded',
        );

        let sourceLanguageCode: string;
        let sourceSegments: TranscriptSegment[];
        let sourceStatus: string;

        if (source.status === 'Live' && source.languageCode) {
          sourceLanguageCode = source.languageCode;
          sourceStatus = source.status;
          ctx.console.info(
            { event: 'transcript.resume', parentId, languageCode: sourceLanguageCode },
            'source already Live, resuming from stored segments',
          );
          ctx.console.debug(
            {
              event: 'blob.download.start',
              operation: 'blob.download-source',
              parentId,
              languageCode: sourceLanguageCode,
            },
            'downloading stored source segments',
          );
          sourceSegments = await ctx.run(
            'blob.download-source',
            () => downloadSegments(deps.downloadBlob, parentId, sourceLanguageCode),
            retry.http,
          );
          ctx.console.debug(
            {
              event: 'blob.download.complete',
              operation: 'blob.download-source',
              segments: sourceSegments.length,
            },
            'download complete',
          );
        } else {
          ctx.console.info(
            { event: 'transcript.transcribe', parentId },
            'no existing Live source, transcribing fresh',
          );

          ctx.console.debug(
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
          const artifactUrlResult = z.url().safeParse(content.artifactUrl);
          if (!artifactUrlResult.success) {
            // Bad input, not a bug to retry against: an upload that never finished, or a link-only
            // video. The journaled `content` never changes, so retrying would just pause after 10
            // attempts (CLAUDE.md: malformed input fails the run terminally, not retried blind).
            throw new restate.TerminalError(
              `knowlg.read-content: Content ${parentId} has no usable artifactUrl`,
            );
          }
          const artifactUrl = artifactUrlResult.data;
          ctx.console.debug(
            { event: 'knowlg.response', operation: 'knowlg.read-content', artifactUrl },
            'knowlg responded',
          );

          ctx.console.debug(
            { event: 'whisper.request', operation: 'whisper.transcribe', body: { artifactUrl } },
            'calling whisper',
          );
          const whisperResult = await ctx.client(whisperApi).transcribe({ artifactUrl });
          ctx.console.info(
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

          ctx.console.debug(
            {
              event: 'blob.upload.start',
              operation: 'blob.upload-source',
              parentId,
              languageCode: whisperResult.language,
              segments: whisperResult.segments.length,
            },
            'uploading source transcript and captions',
          );
          // Uncapped from here on: an outage now would throw away the already-completed,
          // multi-minute Whisper transcription, not just a cheap call worth retrying fresh.
          const sourceUrls = await ctx.run(
            'blob.upload-source',
            () =>
              uploadArtifacts(
                deps.uploadBlob,
                parentId,
                whisperResult.language,
                whisperResult.segments,
              ),
            retry.httpResumable,
          );
          ctx.console.debug(
            {
              event: 'blob.upload.complete',
              operation: 'blob.upload-source',
              transcriptUrl: sourceUrls.transcriptUrl,
              captionsUrl: sourceUrls.captionsUrl,
            },
            'upload complete',
          );

          const sourceUpdateBody = {
            languageCode: whisperResult.language,
            language: languageName(whisperResult.language),
            artifactUrl: sourceUrls.transcriptUrl,
            captionsUrl: sourceUrls.captionsUrl,
            autoApproved: true,
            status: 'Processing',
          };
          ctx.console.debug(
            { event: 'knowlg.request', operation: 'knowlg.update-source', body: sourceUpdateBody },
            'calling knowlg',
          );
          await ctx.run(
            'knowlg.update-source',
            () => deps.knowlg.updateEnrichmentObject(source.identifier, sourceUpdateBody),
            retry.httpResumable,
          );
          ctx.console.debug(
            {
              event: 'knowlg.response',
              operation: 'knowlg.update-source',
              identifier: source.identifier,
            },
            'knowlg responded',
          );

          const sourceApproveBody = { status: 'Live' };
          ctx.console.debug(
            {
              event: 'knowlg.request',
              operation: 'knowlg.approve-source',
              body: sourceApproveBody,
            },
            'calling knowlg',
          );
          const approvedSource = parseEnrichmentObjectResult(
            await ctx.run(
              'knowlg.approve-source',
              () => deps.knowlg.approveEnrichmentObject(source.identifier, sourceApproveBody),
              retry.httpResumable,
            ),
            'knowlg.approve-source',
          );
          ctx.console.info(
            {
              event: 'transcript.source.complete',
              parentId,
              identifier: approvedSource.identifier,
              status: approvedSource.status,
              languageCode: whisperResult.language,
            },
            'source language complete',
          );

          sourceLanguageCode = whisperResult.language;
          sourceSegments = whisperResult.segments;
          sourceStatus = approvedSource.status;
        }

        const targetLanguages = config.targetLanguages.filter(
          (lang) => lang !== sourceLanguageCode,
        );
        ctx.console.info(
          { event: 'transcript.languages', parentId, targetLanguages },
          'target languages planned',
        );
        const translations: TranscriptResult[] = [];
        for (const [index, lang] of targetLanguages.entries()) {
          ctx.console.info(
            {
              event: 'transcript.language.start',
              parentId,
              targetLanguage: lang,
              index,
              total: targetLanguages.length,
            },
            'starting language',
          );
          translations.push(
            await buildTranslation(
              ctx,
              deps,
              parentId,
              input.channel,
              sourceSegments,
              lang,
              artifactReplaced,
            ),
          );
        }

        ctx.console.info(
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
