#!/usr/bin/env node
import { sep } from 'node:path';
import { parseArgs } from 'node:util';
import { cancelRun, getRun, listRuns, listUnits, startRun } from './commands/runs.js';
import { deploy } from './commands/deploy.js';
import { listDeployments, retireDeployment } from './commands/deployments.js';
import { scaffold } from './commands/scaffold.js';
import { coreApi } from './core-api.js';
import { dockerCli } from './docker.js';
import { readDotEnv, root, setting } from './env.js';
import { discoverUnits } from './units.js';

/**
 * `pnpm pipeline …`. This file does argument handling and printing only; each command is a function
 * in `commands/` that takes its collaborators, so the interesting behaviour is testable without a
 * Docker daemon or a running API.
 */
const USAGE = `pipeline <command>

  new <workflow|service> <name> [--kafka <topic>]
                                  scaffold a deployable unit, ready to build and deploy
  deploy <name...> [--dev]        build, start and register immutable deployment(s)
  deployments [name]              list deployments with in-flight counts
  retire <deploymentId>           retire a drained deployment and stop its container
  workflows                       list the catalogue
  units                           list deployable units (local only, for CI)
  start <workflow> --input <json> [--key <idempotency-key>]
  runs [workflow] [--status s] [--limit n] [--cursor c]
                                  list runs (one page; the reply carries nextCursor)
  run <workflow> <runId>          show one run
  cancel <workflow> <runId>       cancel a run

env: CORE_API_URL (http://127.0.0.1:3000), DOCKER_NETWORK (ai-pipeline)`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dev: { type: 'boolean', default: false },
    input: { type: 'string' },
    key: { type: 'string' },
    status: { type: 'string' },
    limit: { type: 'string' },
    cursor: { type: 'string' },
    kafka: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

const [command, ...args] = positionals;
const repo = root();
const dotEnv = readDotEnv(repo);
const api = coreApi(setting(dotEnv, 'CORE_API_URL', 'http://127.0.0.1:3000'));
const print = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2));
};

/** The environment a unit's container runs with. Secrets travel in the environment, not in argv. */
const unitEnv = () => ({
  LITELLM_URL: setting(dotEnv, 'UNIT_LITELLM_URL', 'http://litellm:4000'),
  LITELLM_API_KEY: setting(dotEnv, 'LITELLM_MASTER_KEY'),
  // Local Ollama is much slower than a hosted model, especially for a large translation batch's
  // JSON output — @ai-pipeline/ai's own default (3 min) is too short for that here.
  LLM_TIMEOUT_MS: setting(dotEnv, 'UNIT_LLM_TIMEOUT_MS', '600000'),
  OTEL_EXPORTER_OTLP_ENDPOINT: setting(dotEnv, 'UNIT_OTEL_ENDPOINT', 'http://otel:4318'),
  // knowlg-platform is reached via the host's own port-forward to the cluster, not a compose
  // service — host.docker.internal needs `--add-host` on the container (see docker.ts).
  KNOWLG_BASE_URL: setting(dotEnv, 'UNIT_KNOWLG_BASE_URL', 'http://host.docker.internal:9000'),
  WHISPER_BASE_URL: setting(dotEnv, 'UNIT_WHISPER_BASE_URL', 'http://whisper:8000'),
  AZURE_STORAGE_ACCOUNT: setting(dotEnv, 'UNIT_AZURE_STORAGE_ACCOUNT', 'devstoreaccount1'),
  AZURE_STORAGE_CONTAINER: setting(dotEnv, 'UNIT_AZURE_STORAGE_CONTAINER', 'transcripts'),
  AZURE_STORAGE_AUTH_TYPE: setting(dotEnv, 'UNIT_AZURE_STORAGE_AUTH_TYPE', 'ACCESS_KEY'),
  AZURE_STORAGE_CONNECTION_STRING: setting(
    dotEnv,
    'UNIT_AZURE_STORAGE_CONNECTION_STRING',
    'DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;',
  ),
});

const required = (value: string | undefined, what: string): string => {
  if (!value) throw new Error(what);
  return value;
};

async function main(): Promise<void> {
  switch (command) {
    case 'new': {
      const kind = required(args[0], 'new needs <workflow|service> <name>');
      if (kind !== 'workflow' && kind !== 'service')
        throw new Error(`the kind must be "workflow" or "service", not "${kind}"`);
      scaffold({
        root: repo,
        kind,
        name: required(args[1], 'new needs <workflow|service> <name>'),
        ...(values.kafka ? { kafkaTopic: values.kafka } : {}),
        log: (line) => {
          console.error(line);
        },
      });
      return;
    }

    case 'deploy': {
      if (args.length === 0) throw new Error('deploy needs at least one unit name');
      const env = unitEnv();
      const network = setting(dotEnv, 'DOCKER_NETWORK', 'ai-pipeline');
      for (const name of args)
        print(
          await deploy({
            root: repo,
            name,
            dev: values.dev ?? false,
            network,
            env,
            api,
            docker: dockerCli,
            log: (line) => {
              console.error(line);
            },
          }),
        );
      return;
    }

    case 'deployments':
      return print(await listDeployments(api, args[0]));

    case 'retire':
      return print(
        await retireDeployment(api, dockerCli, required(args[0], 'retire needs a deployment id')),
      );

    case 'workflows':
      return print(await listUnits(api));

    // Local discovery, no core-api call — so CI can use this before anything is deployed.
    case 'units': {
      const { units, broken } = discoverUnits(repo);
      for (const b of broken) console.error(`✖ ${b.dir} has an invalid metadata.json: ${b.error}`);
      return print(
        units
          // tests/fixtures/* are real units for deploy/vitest, but not for CI to push images of.
          .filter((u) => !u.dir.includes(`${sep}tests${sep}fixtures${sep}`))
          .map((u) => ({
            name: u.metadata.name,
            image: u.packageName.replace(/^@ai-pipeline\//, ''),
            package: u.packageName,
          })),
      );
    }

    case 'start': {
      const workflow = required(args[0], 'start needs <workflow> --input <json>');
      const input = required(values.input, 'start needs <workflow> --input <json>');
      return print(await startRun(api, workflow, JSON.parse(input) as unknown, values.key));
    }

    case 'runs':
      return print(
        await listRuns(api, {
          ...(args[0] ? { workflow: args[0] } : {}),
          ...(values.status ? { status: values.status } : {}),
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values.cursor ? { cursor: values.cursor } : {}),
        }),
      );

    case 'run':
      return print(
        await getRun(
          api,
          required(args[0], 'run needs <workflow> <runId>'),
          required(args[1], 'run needs <workflow> <runId>'),
        ),
      );

    case 'cancel':
      return print(
        await cancelRun(
          api,
          required(args[0], 'cancel needs <workflow> <runId>'),
          required(args[1], 'cancel needs <workflow> <runId>'),
        ),
      );

    default:
      console.log(USAGE);
      if (command && !values.help) process.exitCode = 1;
  }
}

main().catch((error: Error) => {
  console.error(`✖ ${error.message}`);
  process.exitCode = 1;
});
