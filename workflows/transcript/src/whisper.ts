import * as restate from '@restatedev/restate-sdk';
import { Agent, fetch as undiciFetch } from 'undici';
import { WhisperResult } from './schemas.js';

/**
 * Node's default `fetch` (undici) caps a non-streaming call at a 5-minute headers timeout,
 * regardless of any application-level abort signal — a full-length transcription blows through
 * that. A dedicated dispatcher, used only here, avoids raising this for every other HTTP call.
 */
const whisperDispatcher = new Agent({ headersTimeout: 900_000, bodyTimeout: 900_000 });

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
    throw new restate.TerminalError(`whisper ${url.pathname} failed (${response.status}): ${body}`);
  }
  return WhisperResult.parse(await response.json());
}
