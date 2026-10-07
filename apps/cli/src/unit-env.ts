import { workspaceClosure } from './artifact.js';

export type Lookup = (key: string) => string | undefined;

/**
 * A value that is set and not blank: CI often exports a variable empty (`X=`), meaning unset. Kept
 * as it is otherwise — a password may begin or end with a space.
 */
const present = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

/**
 * Environment a unit gets only when its closure includes the package that needs it.
 *
 * Everything else in a unit's environment is shared (`unitEnv` in `main.ts`). This part is not, for
 * two reasons: credentials should reach only the units that use them, and the container config hash
 * covers the environment — a key added for every unit would replace every unit's container on its
 * next deploy.
 */
export function scopedUnitEnv(
  root: string,
  packageName: string,
  lookup: Lookup,
): Record<string, string> {
  const closure = workspaceClosure(root, packageName);
  const env: Record<string, string> = {};
  if (closure.has('@ai-pipeline/rag')) {
    // The RAG store: its own database on the compose Postgres, unless pointed elsewhere.
    const url = present(lookup('UNIT_RAG_DATABASE_URL'));
    const password = present(lookup('POSTGRES_PASSWORD'));
    if (!url && !password)
      throw new Error('POSTGRES_PASSWORD (or UNIT_RAG_DATABASE_URL) is not set (env or .env)');
    env.RAG_DATABASE_URL =
      url ?? `postgres://pipeline:${encodeURIComponent(password!)}@postgres:5432/rag`;
    // Mastra reports feature telemetry unless told not to.
    env.MASTRA_TELEMETRY_DISABLED = '1';
  }
  return env;
}
