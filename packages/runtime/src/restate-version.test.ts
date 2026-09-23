import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The Restate version is pinned in two places that must not drift: the server the stack runs
 * (`compose.yaml`) and the server the always-replay tests start in Testcontainers.
 *
 * Nothing links them, so a stack upgrade would leave the tests proving the handlers replay
 * correctly on a version nobody runs — the failure being that the tests keep passing. The repo
 * already guards the provisioning SQL and the Postman collection this way; this is the third.
 */
const ROOT = new URL('../../../', import.meta.url);

const composeVersion = (): string => {
  const compose = readFileSync(new URL('compose.yaml', ROOT), 'utf8');
  const image = /restatedev\/restate:([0-9]+\.[0-9]+\.[0-9]+)/.exec(compose);
  expect(image, 'compose.yaml no longer pins a restate image').not.toBeNull();
  return image![1]!;
};

/** Every `new RestateContainer('x.y.z')` in the repo's replay tests, with the file it is in. */
function containerVersions(): { file: string; version: string }[] {
  const found: { file: string; version: string }[] = [];
  for (const group of ['workflows', 'services', 'packages']) {
    let entries: string[];
    try {
      entries = readdirSync(new URL(`${group}/`, ROOT));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const dir = new URL(`${group}/${entry}/src/`, ROOT);
      let files: string[];
      try {
        files = readdirSync(dir);
      } catch {
        continue;
      }
      for (const file of files.filter((f) => f.endsWith('.replay.test.ts'))) {
        const source = readFileSync(new URL(file, dir), 'utf8');
        for (const match of source.matchAll(/new RestateContainer\(\s*'([^']+)'/g))
          found.push({ file: `${group}/${entry}/src/${file}`, version: match[1]! });
      }
    }
  }
  return found;
}

describe('the pinned Restate version', () => {
  it('is the same in compose.yaml and in every replay test', () => {
    const expected = composeVersion();
    const used = containerVersions();
    expect(used.length, 'no replay test starts a RestateContainer').toBeGreaterThan(0);
    for (const { file, version } of used) expect(version, file).toBe(expected);
  });
});
