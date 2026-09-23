import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMetadata } from '@ai-pipeline/metadata/metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { scaffold, triggerIdFor } from './scaffold.js';

/**
 * A generator's failure mode is drifting away from the conventions it is supposed to encode, quietly,
 * until someone scaffolds a unit that does not deploy. So these tests check the generated unit
 * against the same rules the rest of the toolchain enforces: metadata that parses, a contract whose
 * Restate name matches it, the boundaries tag, and the subpath exports pointing at files that exist.
 */
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'ai-pipeline-scaffold-'));
  roots.push(root);
  mkdirSync(join(root, 'workflows'), { recursive: true });
  mkdirSync(join(root, 'services'), { recursive: true });
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - services/*\n  - workflows/*\n');
  return root;
}

const make = (kind: 'workflow' | 'service', name: string, kafkaTopic?: string) => {
  const root = workspace();
  const dir = scaffold({
    root,
    kind,
    name,
    ...(kafkaTopic ? { kafkaTopic } : {}),
    log: () => undefined,
  });
  const read = (path: string) => readFileSync(join(dir, path), 'utf8');
  return { root, dir, read, json: (path: string) => JSON.parse(read(path)) as Record<string, any> };
};

describe('scaffold: a workflow', () => {
  it('writes metadata that parses, with a REST trigger', () => {
    const { read } = make('workflow', 'order-fulfilment');
    const metadata = parseMetadata(JSON.parse(read('metadata.json')));
    expect(metadata).toMatchObject({
      kind: 'workflow',
      name: 'order-fulfilment',
      restateName: 'OrderFulfilment',
      visibility: 'public',
      version: '0.1.0',
    });
    expect(metadata.triggers).toEqual([{ id: 'api', type: 'rest' }]);
  });

  it('gives the unit its own contract, not an entry in a shared registry', () => {
    const { read } = make('workflow', 'order-fulfilment');
    const contract = read('src/contract.ts');
    // A shared registry would be a file every unit's digest depends on — see units.test.ts.
    expect(contract).toContain("restateName: 'OrderFulfilment'");
    expect(contract).toContain("handler: 'run'");
    expect(contract).toContain('ContractEntry');
  });

  it('declares the Restate name consistently across metadata, contract and iface', () => {
    const { read, json } = make('workflow', 'order-fulfilment');
    const restateName = json('metadata.json').restateName as string;
    expect(read('src/contract.ts')).toContain(`'${restateName}'`);
    expect(read('src/api.ts')).toContain(`'${restateName}'`);
  });

  it('exports every module it generates, and generates every module it exports', () => {
    const { json, read } = make('workflow', 'order-fulfilment');
    for (const [subpath, target] of Object.entries(json('package.json').exports)) {
      const source = (target as Record<string, string | undefined>)['@ai-pipeline/source'];
      expect(source, subpath).toMatch(/^\.\/src\/.+\.ts$/);
      // Would throw if the file were missing.
      expect(read(source!.replace('./', '')).length, source).toBeGreaterThan(0);
    }
  });

  it('is tagged so turbo boundaries keeps apps out of it', () => {
    const { json } = make('workflow', 'order-fulfilment');
    expect(json('turbo.json')).toEqual({ extends: ['//'], tags: ['unit'] });
  });

  it('applies the handler determinism rules, not just the base lint config', () => {
    const { read } = make('workflow', 'order-fulfilment');
    expect(read('eslint.config.js')).toContain('handlers()');
  });

  it('separates emit from typecheck so tests are checked but not shipped', () => {
    const { json } = make('workflow', 'order-fulfilment');
    expect(json('tsconfig.json').include).toEqual(['src']);
    expect(json('tsconfig.build.json').exclude).toEqual(['src/**/*.test.ts']);
  });

  it('records the trigger context in the handler, which the runs API reads back', () => {
    const { read } = make('workflow', 'order-fulfilment');
    const workflow = read('src/workflow.ts');
    expect(workflow).toContain("ctx.set('trigger', trigger)");
    expect(workflow).toContain("ctx.set('version', metadata.version)");
  });

  it('serves only the workflow when it has no Kafka trigger', () => {
    const { read } = make('workflow', 'order-fulfilment');
    expect(read('src/main.ts')).toContain('serve(metadata.name, [orderFulfilment])');
  });
});

describe('scaffold: a workflow with a Kafka trigger', () => {
  it('adds the trigger to metadata, with an adapter that the trigger service exports', () => {
    const { read } = make('workflow', 'order-fulfilment', 'orders.placed');
    const metadata = parseMetadata(JSON.parse(read('metadata.json')));
    expect(metadata.triggers).toEqual([
      { id: 'api', type: 'rest' },
      {
        id: 'orders-placed',
        type: 'kafka',
        cluster: 'local',
        topic: 'orders.placed',
        adapter: 'orderFulfilmentEvent',
      },
    ]);
    // The adapter named in metadata must be the one the adapters module exports, or the trigger
    // service throws at construction.
    expect(read('src/adapters.ts')).toContain('orderFulfilmentEvent(event: unknown)');
  });

  it('serves the trigger service alongside the workflow', () => {
    const { read } = make('workflow', 'order-fulfilment', 'orders.placed');
    expect(read('src/main.ts')).toContain('[orderFulfilment, orderFulfilmentTrigger]');
  });

  it('documents that the topic still has to be created', () => {
    const lines: string[] = [];
    const root = workspace();
    scaffold({
      root,
      kind: 'workflow',
      name: 'order-fulfilment',
      kafkaTopic: 'orders.placed',
      log: (line) => lines.push(line),
    });
    expect(lines.join('\n')).toContain('orders.placed');
  });
});

describe('scaffold: a service', () => {
  it('is private, since a service is called by other units rather than triggered', () => {
    const { read } = make('service', 'embedding');
    const metadata = parseMetadata(JSON.parse(read('metadata.json')));
    expect(metadata).toMatchObject({ kind: 'service', visibility: 'private' });
    expect(metadata.triggers).toEqual([]);
  });

  it('injects nothing by default but is shaped for it', () => {
    const { read } = make('service', 'embedding');
    expect(read('src/service.ts')).toContain('export function createEmbeddingService()');
  });
});

describe('scaffold: refusals', () => {
  it('rejects a name that metadata.json would reject', () => {
    for (const bad of ['OrderFulfilment', 'order_fulfilment', '1order', 'order-']) {
      expect(() => make('workflow', bad), bad).toThrow(/lower-case kebab/);
    }
  });

  it('refuses a trigger on a service', () => {
    expect(() => make('service', 'embedding', 'orders.placed')).toThrow(
      /only workflows declare triggers/,
    );
  });

  it('refuses to overwrite an existing unit', () => {
    const root = workspace();
    const options = { root, kind: 'workflow' as const, name: 'dup', log: () => undefined };
    scaffold(options);
    expect(() => scaffold(options)).toThrow(/already exists/);
  });
});

describe('triggerIdFor', () => {
  it('derives a valid trigger id from topic names Kafka allows but metadata.json does not', () => {
    // Each of these is a legal Kafka topic whose naive `.replace(/[._]/g, '-')` produces an id the
    // metadata schema rejects — and one such unit used to block `deploy` for every other unit.
    expect(triggerIdFor('content.published', 'content-enrichment')).toBe('content-published');
    expect(triggerIdFor('Orders.Placed', 'order-fulfilment')).toBe('orders-placed');
    expect(triggerIdFor('orders..placed', 'order-fulfilment')).toBe('orders-placed');
    expect(triggerIdFor('orders_placed_', 'order-fulfilment')).toBe('orders-placed');
    expect(triggerIdFor('__orders__', 'order-fulfilment')).toBe('orders');
  });

  it('falls back to the unit name when nothing valid can be derived', () => {
    // A metadata name must start with a letter, so a numeric topic has no valid derivation.
    expect(triggerIdFor('2024.events', 'order-fulfilment')).toBe('order-fulfilment-events');
    expect(triggerIdFor('...', 'order-fulfilment')).toBe('order-fulfilment-events');
  });

  it('always produces something metadata.json accepts', () => {
    const topics = ['a', 'A.B_c-D', '1', '---', 'x'.repeat(200), 'Orders.Placed.v2'];
    for (const topic of topics)
      expect(triggerIdFor(topic, 'unit'), topic).toMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);
  });
});
