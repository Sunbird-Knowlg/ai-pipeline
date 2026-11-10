import * as restate from '@restatedev/restate-sdk';
import { WhisperInput, WhisperOutput } from './schemas.js';

/** The Restate binding for the `whisper` contract: what implementations and callers share. */
export const whisperApi = restate.iface.service(
  'WhisperService',
  { transcribe: restate.iface.schemas({ input: WhisperInput, output: WhisperOutput }) },
  { description: 'Speech-to-text transcription via faster-whisper (private; called by workflows)' },
);
