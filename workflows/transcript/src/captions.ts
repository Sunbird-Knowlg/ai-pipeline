import type { TranscriptSegment } from './schemas.js';

/**
 * Pure, deterministic formatting — safe to call directly in the handler body (not `ctx.run`),
 * since it does no I/O and always produces the same output for the same segments.
 */

function toVttTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms, 3)}`;
}

export function segmentsToVtt(segments: TranscriptSegment[]): string {
  const lines = ['WEBVTT', ''];
  for (const seg of segments) {
    lines.push(`${toVttTime(seg.start)} --> ${toVttTime(seg.end)}`);
    lines.push(seg.text.trim());
    lines.push('');
  }
  return lines.join('\n');
}

export function segmentsToJson(segments: TranscriptSegment[]): string {
  return JSON.stringify({ segments }, null, 2);
}
