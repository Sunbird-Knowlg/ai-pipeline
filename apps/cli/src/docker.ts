import { execFileSync } from 'node:child_process';

export interface RunContainer {
  name: string;
  image: string;
  network: string;
  env: Record<string, string>;
  labels: Record<string, string>;
}

export type ContainerState = 'running' | 'stopped' | 'missing';

/**
 * What `deploy` needs from Docker.
 *
 * It is an interface because the interesting part of a deploy is *which* of these calls it makes:
 * whether it rebuilds, whether it reuses a container, and — the one that matters most — whether it
 * is allowed to tear a container down again after a refusal. A test can only check that against a
 * recording double.
 */
export interface Docker {
  imageExists(tag: string): boolean;
  buildImage(root: string, packageName: string, tag: string): void;
  removeImage(tag: string): void;
  containerState(name: string): ContainerState;
  containerLabel(name: string, label: string): string | undefined;
  runContainer(options: RunContainer): void;
  removeContainer(name: string): void;
  startContainer(name: string): void;
}

const docker = (
  args: string[],
  opts: { quiet?: boolean; cwd?: string; env?: Record<string, string> } = {},
) =>
  execFileSync('docker', args, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'],
  }).trim();

export function imageExists(tag: string): boolean {
  try {
    docker(['image', 'inspect', tag], { quiet: true });
    return true;
  } catch {
    return false;
  }
}

/** Builds the unit's image (tagged with its source digest, so an unchanged unit is never rebuilt). */
export function buildImage(root: string, packageName: string, tag: string): void {
  execFileSync('docker', ['build', '--build-arg', `PACKAGE=${packageName}`, '-t', tag, '.'], {
    cwd: root,
    stdio: ['ignore', 'inherit', 'inherit'],
  });
}

export function containerState(name: string): ContainerState {
  try {
    return docker(['inspect', '-f', '{{.State.Running}}', name], { quiet: true }) === 'true'
      ? 'running'
      : 'stopped';
  } catch {
    return 'missing';
  }
}

export function removeContainer(name: string): void {
  if (containerState(name) !== 'missing') docker(['rm', '-f', name], { quiet: true });
}

export function removeImage(tag: string): void {
  try {
    docker(['image', 'rm', tag], { quiet: true });
  } catch {
    // still used by a container, or already gone
  }
}

export function containerLabel(name: string, label: string): string | undefined {
  try {
    const value = docker(['inspect', '-f', `{{index .Config.Labels "${label}"}}`, name], {
      quiet: true,
    });
    return value && value !== '<no value>' ? value : undefined;
  } catch {
    return undefined;
  }
}

export function runContainer(opts: RunContainer): void {
  const args = [
    'run',
    '-d',
    '--name',
    opts.name,
    '--network',
    opts.network,
    '--restart',
    'unless-stopped',
  ];
  // Values travel in docker's environment, not its argv (keeps secrets out of `ps` and errors).
  for (const k of Object.keys(opts.env)) args.push('-e', k);
  for (const [k, v] of Object.entries(opts.labels)) args.push('--label', `${k}=${v}`);
  args.push(opts.image);
  docker(args, { quiet: true, env: opts.env });
}

export function startContainer(name: string): void {
  docker(['start', name], { quiet: true });
}

/** The real Docker CLI. `deploy` takes this in production and a recording double in tests. */
export const dockerCli: Docker = {
  imageExists,
  buildImage,
  removeImage,
  containerState,
  containerLabel,
  runContainer,
  removeContainer,
  startContainer,
};
