import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

/** Reads `.env` with Node's dotenv parser (comments, quotes, `export`) so CLI and compose agree. */
export function readDotEnv(root: string): Record<string, string> {
  const file = join(root, '.env');
  if (!existsSync(file)) return {};
  return parseEnv(readFileSync(file, 'utf8')) as Record<string, string>;
}

export const setting = (dotEnv: Record<string, string>, key: string, fallback?: string): string => {
  const value = process.env[key] ?? dotEnv[key] ?? fallback;
  if (value === undefined) throw new Error(`${key} is not set (env or .env)`);
  return value;
};

export const root = (): string => {
  const here = fileURLToPath(new URL('../../..', import.meta.url));
  return process.env.PIPELINE_ROOT ?? here;
};

export { join };
