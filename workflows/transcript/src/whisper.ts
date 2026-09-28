import * as restate from '@restatedev/restate-sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import { WhisperResult } from './schemas.js';

/**
 * Node's default `fetch` (undici) headers-timeout is 5 minutes — shorter than CPU-based
 * transcription of anything but a very short clip. `/transcribe` doesn't stream, so no bytes
 * arrive until the whole job is done; a dedicated, generously-timed dispatcher is needed for this
 * one call specifically, not a global change to every fetch (knowlg's own calls should still fail
 * fast if something's genuinely wrong).
 */
const whisperDispatcher = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

/**
 * Calls the Whisper transcription microservice (`services/whisper`) — a plain HTTP call, not a
 * Restate unit. It downloads `artifactUrl` itself and returns segmented JSON.
 */
export async function transcribe(
  baseUrl: string,
  artifactUrl: string,
  language?: string,
): Promise<WhisperResult> {
  const url = new URL('/transcribe', baseUrl);
  url.searchParams.set('url', artifactUrl);
  url.searchParams.set('fmt', 'json');
  if (language) url.searchParams.set('language', language);

  const response = await undiciFetch(url, { method: 'POST', dispatcher: whisperDispatcher });
  if (!response.ok) {
    const body = await response.text();
    if (response.status < 500)
      throw new restate.TerminalError(`whisper rejected ${artifactUrl} (${response.status}): ${body}`);
    throw new Error(`whisper transcription failed (${response.status}): ${body}`);
  }
  return WhisperResult.parse(await response.json());
}
