import { createHash } from 'node:crypto';
import { canonicalJson } from '@ai-pipeline/contracts/schemas';

/**
 * Deterministic identity for what the RAG units write. Pure — safe in a handler body as well as
 * inside `ctx.run`.
 */

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * A chunk's vector id: UUID-shaped (some stores accept nothing else) and derived from where the
 * chunk sits, so a retried write overwrites itself instead of adding a second copy.
 */
export function chunkId(collectionId: string, documentId: string, index: number): string {
  const hex = sha256(`${collectionId}\0${documentId}\0${index}`);
  // RFC 4122 layout with the version nibble set to 5 (name-based) and the variant bits to 10xx.
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** sha256 over canonical (key-sorted) JSON: the same parts always give the same fingerprint. */
export function fingerprint(parts: unknown): string {
  return `sha256:${sha256(canonicalJson(parts))}`;
}

/** The vector table of one collection incarnation: unique, short, and a valid SQL identifier. */
export function tableName(incarnation: string): string {
  const hex = incarnation.toLowerCase().replace(/[^0-9a-f]/g, '');
  if (hex.length < 16) throw new Error(`incarnation "${incarnation}" carries too little entropy`);
  return `c_${hex.slice(0, 16)}`;
}

/**
 * Fills `{name}` placeholders; a placeholder with no value becomes empty. Leading and trailing
 * blank space is trimmed, so `{title}\n\n{text}` without a title is just the text.
 */
export function renderTemplate(
  template: string,
  values: Readonly<Record<string, unknown>>,
): string {
  return template
    .replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key: string) => text(values[key]))
    .trim();
}

function text(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return `${value}`;
  if (Array.isArray(value)) return value.map(text).join(', ');
  return JSON.stringify(value);
}
