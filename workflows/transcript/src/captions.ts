import type { TranscriptSegment } from './schemas.js';

function timestamp(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`;
}

/**
 * Renders segments as a WebVTT cue file (`WEBVTT` header + one cue per segment).
 * Deterministic, no I/O — safe to call directly in a handler body, never inside `ctx.run`.
 */
export function segmentsToVtt(segments: TranscriptSegment[]): string {
  const cues = segments.map(
    (segment) =>
      `${timestamp(segment.start)} --> ${timestamp(segment.end)}\n${segment.text.trim()}`,
  );
  return ['WEBVTT', '', ...cues].join('\n\n');
}

/**
 * Renders segments as the exact JSON shape `workflow.ts`'s `downloadSegments` re-parses later,
 * to resume an already-`Live` node without re-transcribing.
 * Deterministic, no I/O — safe to call directly in a handler body, never inside `ctx.run`.
 */
export function segmentsToJson(segments: TranscriptSegment[]): string {
  return JSON.stringify({ segments }, null, 2);
}
