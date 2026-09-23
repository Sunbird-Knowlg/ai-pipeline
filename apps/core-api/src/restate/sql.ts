/** DataFusion string literal. Values are also validated by the callers' patterns. */
export function quote(literal: string): string {
  return `'${literal.replaceAll("'", "''")}'`;
}

export const RESTATE_NAME = /^[A-Z][A-Za-z0-9]{0,62}$/;
export const RUN_KEY = /^[A-Za-z0-9_.:-]{1,256}$/;
