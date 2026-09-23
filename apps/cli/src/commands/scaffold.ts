import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UnitKind } from '@ai-pipeline/api-contract/params';

/**
 * `pipeline new <workflow|service> <name> [--kafka <topic>]`.
 *
 * Adding a unit by hand means a dozen files that all have to agree: the manifest's subpath exports,
 * two tsconfigs, the lint config, the boundaries tag, `metadata.json`, and a contract whose Restate
 * name matches it. Each one is easy to get subtly wrong, and the failure shows up at deploy time.
 *
 * So the conventions live here instead, applied once. What this generates is a unit that builds,
 * lints, typechecks and deploys as-is — the handler body is the only thing left to write.
 *
 * Note what it deliberately does *not* generate: an entry in a shared registry. Each unit owns its
 * contract, which is what lets a new unit be added without changing any existing one's artifact.
 */
export interface ScaffoldOptions {
  root: string;
  kind: UnitKind;
  /** Lower-case kebab, as `metadata.json` requires. */
  name: string;
  /** When given, the unit gets a Kafka trigger on this topic, with an adapter. */
  kafkaTopic?: string;
  log: (line: string) => void;
}

const NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** `content-enrichment` → `ContentEnrichment`; the Restate service name. */
const pascal = (name: string): string =>
  name.replace(/(^|-)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase());

/** `content-enrichment` → `contentEnrichment`; an identifier. */
const camel = (name: string): string => {
  const p = pascal(name);
  return p.charAt(0).toLowerCase() + p.slice(1);
};

export function scaffold(o: ScaffoldOptions): string {
  if (!NAME.test(o.name))
    throw new Error(`"${o.name}" is not a lower-case kebab name (e.g. order-fulfilment)`);
  if (o.kind === 'service' && o.kafkaTopic)
    throw new Error('only workflows declare triggers; a service is called by other units');

  const group = o.kind === 'workflow' ? 'workflows' : 'services';
  const dir = join(o.root, group, o.name);
  if (existsSync(dir)) throw new Error(`${group}/${o.name} already exists`);

  const restateName = pascal(o.name);
  const files =
    o.kind === 'workflow' ? workflowFiles(o, restateName) : serviceFiles(o, restateName);

  mkdirSync(join(dir, 'src'), { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
    o.log(`  + ${group}/${o.name}/${path}`);
  }

  o.log('');
  o.log(
    `Next: pnpm install${o.kafkaTopic ? `, add the topic "${o.kafkaTopic}" to kafka-init in compose.yaml` : ''}`,
  );
  o.log(`      write the handler in ${group}/${o.name}/src/${o.kind}.ts`);
  o.log(`      pnpm pipeline deploy ${o.name}`);
  return dir;
}

// ── shared pieces ─────────────────────────────────────────────────────────────

const tsconfig = () =>
  `${JSON.stringify(
    {
      extends: '@ai-pipeline/typescript-config/library.json',
      compilerOptions: { rootDir: 'src', outDir: 'dist' },
      include: ['src'],
    },
    null,
    2,
  )}\n`;

const tsconfigBuild = () =>
  `${JSON.stringify({ extends: './tsconfig.json', exclude: ['src/**/*.test.ts'] }, null, 2)}\n`;

/** Every unit is tagged `unit`, which is how `turbo boundaries` keeps apps out of it. */
const turboJson = () => `${JSON.stringify({ extends: ['//'], tags: ['unit'] }, null, 2)}\n`;

/** Handler code gets the determinism rules on top of the base config. */
const eslintConfig = () =>
  `import { base } from '@ai-pipeline/eslint-config/base';\nimport { handlers } from '@ai-pipeline/eslint-config/handlers';\n\nexport default [...base(import.meta.dirname), ...handlers()];\n`;

const exportsMap = (names: string[]) =>
  Object.fromEntries(
    names.map((n) => [
      `./${n}`,
      {
        '@ai-pipeline/source': `./src/${n}.ts`,
        types: `./dist/${n}.d.ts`,
        default: `./dist/${n}.js`,
      },
    ]),
  );

const manifest = (o: ScaffoldOptions, modules: string[], extraDeps: Record<string, string> = {}) =>
  `${JSON.stringify(
    {
      name: `@ai-pipeline/${o.kind === 'workflow' ? 'wf' : 'svc'}-${o.name}`,
      version: '0.1.0',
      private: true,
      type: 'module',
      exports: exportsMap(modules),
      files: ['dist', 'metadata.json'],
      scripts: {
        build:
          "node -e \"require('fs').rmSync('dist',{recursive:true,force:true})\" && tsc -p tsconfig.build.json",
        typecheck: 'tsc -p tsconfig.json --noEmit',
        lint: 'eslint .',
        start: 'node dist/main.js',
      },
      dependencies: {
        '@ai-pipeline/contracts': 'workspace:*',
        '@ai-pipeline/metadata': 'workspace:*',
        '@ai-pipeline/runtime': 'workspace:*',
        '@restatedev/restate-sdk': 'catalog:',
        zod: 'catalog:',
        ...extraDeps,
      },
      devDependencies: {
        '@ai-pipeline/eslint-config': 'workspace:*',
        '@ai-pipeline/typescript-config': 'workspace:*',
        '@types/node': 'catalog:',
        eslint: 'catalog:',
        typescript: 'catalog:',
        vitest: 'catalog:',
      },
    },
    null,
    2,
  )}\n`;

const metadataJson = (o: ScaffoldOptions, restateName: string) => {
  const triggers: Record<string, unknown>[] =
    o.kind === 'workflow' ? [{ id: 'api', type: 'rest' }] : [];
  if (o.kafkaTopic)
    triggers.push({
      id: o.kafkaTopic.replace(/[._]/g, '-'),
      type: 'kafka',
      cluster: 'local',
      topic: o.kafkaTopic,
      adapter: `${camel(o.name)}Event`,
    });
  return `${JSON.stringify(
    {
      apiVersion: 'ai-pipeline/v1alpha1',
      kind: o.kind,
      name: o.name,
      restateName,
      version: '0.1.0',
      description: `TODO: what ${o.name} does`,
      ...(o.kind === 'service' ? { visibility: 'private' } : {}),
      config: {},
      ...(triggers.length > 0 ? { triggers } : {}),
    },
    null,
    2,
  )}\n`;
};

const unitTs = (o: ScaffoldOptions) =>
  `import { loadMetadata } from '@ai-pipeline/metadata/metadata';
import { loadConfig } from '@ai-pipeline/runtime/config';
import { ${pascal(o.name)}Config } from './schemas.js';

/** This unit's identity and its validated configuration, read once at import. */
export const metadata = loadMetadata(new URL('../metadata.json', import.meta.url));
export const config = loadConfig(metadata, ${pascal(o.name)}Config);
`;

const contractTs = (o: ScaffoldOptions, restateName: string, handler: string) =>
  `import type { ContractEntry } from '@ai-pipeline/contracts/entry';
import { ${pascal(o.name)}Config, ${pascal(o.name)}Input, ${pascal(o.name)}Output } from './schemas.js';

/**
 * The catalogue view of this unit's contract, loaded by \`pipeline deploy\` from \`dist/contract.js\`.
 *
 * It lives here rather than in a shared package because nothing else calls this unit yet. Move the
 * schemas into their own \`packages/contract-${o.name}\` only when a second unit needs them.
 */
export const contract: ContractEntry = {
  restateName: '${restateName}',
  handler: '${handler}',
  input: ${pascal(o.name)}Input,
  output: ${pascal(o.name)}Output,
  config: ${pascal(o.name)}Config,
};
`;

// ── workflow ──────────────────────────────────────────────────────────────────

function workflowFiles(o: ScaffoldOptions, restateName: string): Record<string, string> {
  const P = pascal(o.name);
  const c = camel(o.name);
  const modules = ['api', 'contract', 'schemas', 'unit', 'workflow'];
  if (o.kafkaTopic) modules.push('adapters', 'trigger');

  const files: Record<string, string> = {
    'package.json': manifest(o, modules.sort()),
    'tsconfig.json': tsconfig(),
    'tsconfig.build.json': tsconfigBuild(),
    'turbo.json': turboJson(),
    'eslint.config.js': eslintConfig(),
    'metadata.json': metadataJson(o, restateName),
    'src/unit.ts': unitTs(o),
    'src/contract.ts': contractTs(o, restateName, 'run'),

    'src/schemas.ts': `import { runRequest } from '@ai-pipeline/contracts/trigger';
import { z } from 'zod';

/** This workflow's data shapes. Kept apart from \`./api.ts\` so the catalogue side needs no SDK. */
export const ${P}Input = z.strictObject({
  // TODO: the canonical input a caller supplies.
  id: z.string().min(1).max(256),
});
export type ${P}Input = z.infer<typeof ${P}Input>;

export const ${P}Output = z.strictObject({
  // TODO: what the workflow returns.
  id: z.string(),
});
export type ${P}Output = z.infer<typeof ${P}Output>;

export const ${P}Config = z.strictObject({
  // TODO: settings this unit reads from metadata.json.
});
export type ${P}Config = z.infer<typeof ${P}Config>;

/** The \`run\` request: canonical input plus the trigger context the control plane attaches. */
export const ${P}Request = runRequest(${P}Input);
export type ${P}Request = z.infer<typeof ${P}Request>;
`,

    'src/api.ts': `import * as restate from '@restatedev/restate-sdk';
import { ${P}Output, ${P}Request } from './schemas.js';

/** The Restate binding. The handler must be \`run\`: the runs API selects invocations by that name. */
export const ${c}Api = restate.iface.workflow(
  '${restateName}',
  { run: restate.iface.schemas({ input: ${P}Request, output: ${P}Output }) },
  { description: 'TODO: what ${o.name} does' },
);
`,

    'src/workflow.ts': `import { workflowOptions } from '@ai-pipeline/runtime/options';
import * as restate from '@restatedev/restate-sdk';
import { ${c}Api } from './api.js';
import { metadata } from './unit.js';

/**
 * TODO: the workflow body.
 *
 * Handler rules (enforced by lint, and by the always-replay test): all I/O inside
 * \`ctx.run(name, fn, retry.<profile>)\`; no wall clock, randomness or timers outside it — use
 * \`ctx.date.now()\`, \`ctx.rand\`, \`ctx.sleep()\`; \`RestatePromise\` rather than \`Promise.all\` over
 * durable work; \`TerminalError\` for anything not worth retrying.
 */
export const ${c} = restate.implement(${c}Api, {
  handlers: {
    run: async (ctx, { input, trigger }) => {
      // The runs API reads these back, and they survive replay because the handler records them.
      ctx.set('trigger', trigger);
      ctx.set('version', metadata.version);

      return { id: input.id };
    },
  },
  options: workflowOptions(metadata),
});
`,
  };

  if (o.kafkaTopic) {
    files['src/adapters.ts'] = `import { z } from 'zod';
import type { ${P}Input } from './schemas.js';

/** The event as producers emit it. Loose, so an added producer field does not break the consumer. */
const Event = z.looseObject({ id: z.string().min(1) });

/**
 * Trigger adapters: pure maps from an event to this workflow's canonical input. Returning \`null\`
 * drops the record without starting a run — use it for events that are not this workflow's business.
 * Throwing fails the record terminally, so it never blocks the partition.
 */
export const adapters = {
  ${c}Event(event: unknown): ${P}Input | null {
    const parsed = Event.parse(event);
    return { id: parsed.id };
  },
};
`;
    files['src/trigger.ts'] = `import { kafkaTrigger } from '@ai-pipeline/runtime/kafka-trigger';
import { adapters } from './adapters.js';
import { ${P}Input } from './schemas.js';
import { metadata } from './unit.js';

/**
 * \`${restateName}Trigger\`: the sink of this workflow's Kafka subscriptions, one handler per Kafka
 * trigger in \`metadata.json\`. The control plane creates the subscriptions; this only adapts records.
 */
export const ${c}Trigger = kafkaTrigger({ metadata, input: ${P}Input, adapters });
`;
    files['src/main.ts'] = `import { serve } from '@ai-pipeline/runtime/serve';
import { ${c}Trigger } from './trigger.js';
import { metadata } from './unit.js';
import { ${c} } from './workflow.js';

await serve(metadata.name, [${c}, ${c}Trigger]);
`;
  } else {
    files['src/main.ts'] = `import { serve } from '@ai-pipeline/runtime/serve';
import { metadata } from './unit.js';
import { ${c} } from './workflow.js';

await serve(metadata.name, [${c}]);
`;
  }

  return files;
}

// ── service ───────────────────────────────────────────────────────────────────

function serviceFiles(o: ScaffoldOptions, restateName: string): Record<string, string> {
  const P = pascal(o.name);
  const c = camel(o.name);
  return {
    'package.json': manifest(o, ['contract', 'schemas', 'service', 'unit', 'api']),
    'tsconfig.json': tsconfig(),
    'tsconfig.build.json': tsconfigBuild(),
    'turbo.json': turboJson(),
    'eslint.config.js': eslintConfig(),
    'metadata.json': metadataJson(o, restateName),
    'src/unit.ts': unitTs(o),
    'src/contract.ts': contractTs(o, restateName, 'handle'),

    'src/schemas.ts': `import { z } from 'zod';

/** This service's data shapes. Kept apart from \`./api.ts\` so the catalogue side needs no SDK. */
export const ${P}Input = z.strictObject({
  // TODO: what a caller sends.
  id: z.string().min(1).max(256),
});
export type ${P}Input = z.infer<typeof ${P}Input>;

export const ${P}Output = z.strictObject({
  // TODO: what this service returns.
  id: z.string(),
});
export type ${P}Output = z.infer<typeof ${P}Output>;

export const ${P}Config = z.strictObject({
  // TODO: settings this unit reads from metadata.json.
});
export type ${P}Config = z.infer<typeof ${P}Config>;
`,

    'src/api.ts': `import * as restate from '@restatedev/restate-sdk';
import { ${P}Input, ${P}Output } from './schemas.js';

/**
 * The Restate binding. A caller in another unit needs this, so once a second unit calls this
 * service, move these schemas into \`packages/contract-${o.name}\` and import them from both sides.
 */
export const ${c}Api = restate.iface.service(
  '${restateName}',
  { handle: restate.iface.schemas({ input: ${P}Input, output: ${P}Output }) },
  { description: 'TODO: what ${o.name} does' },
);
`,

    'src/service.ts': `import { serviceOptions } from '@ai-pipeline/runtime/options';
import * as restate from '@restatedev/restate-sdk';
import { ${c}Api } from './api.js';
import { metadata } from './unit.js';

/**
 * TODO: the service body.
 *
 * All I/O goes inside \`ctx.run(name, fn, retry.<profile>)\`. Inject anything that talks to the
 * outside world as a parameter, so a test can run this against a fake.
 */
export function create${P}Service() {
  return restate.implement(${c}Api, {
    handlers: {
      handle: async (ctx, input) => ({ id: input.id }),
    },
    options: serviceOptions(metadata),
  });
}
`,

    'src/main.ts': `import { serve } from '@ai-pipeline/runtime/serve';
import { create${P}Service } from './service.js';
import { metadata } from './unit.js';

await serve(metadata.name, [create${P}Service()]);
`,
  };
}
