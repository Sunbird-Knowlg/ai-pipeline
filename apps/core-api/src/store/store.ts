import { definitionStore, type DefinitionStore } from './definitions.js';
import { dependencyStore, type DependencyStore } from './dependencies.js';
import { deploymentStore, type DeploymentStore } from './deployments.js';
import { transaction, transactionOn, withLock, type Db, type Queryable } from './db.js';
import { triggerStore, type TriggerStore } from './triggers.js';

/** The four catalogue repositories, bound to a pool or to one transaction. */
export interface Repositories {
  definitions: DefinitionStore;
  dependencies: DependencyStore;
  deployments: DeploymentStore;
  triggers: TriggerStore;
}

/**
 * The catalogue as a section of work sees it.
 *
 * Inside `withLock` this is bound to the locked connection, so the section needs no second one;
 * outside it, the `Store` itself satisfies it and the queries go through the pool. Domain functions
 * that can run either way take this rather than the whole `Store`.
 */
export interface Catalogue extends Repositories {
  /** Runs `fn` inside one transaction, with the repositories bound to it. */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
}

/**
 * The control plane's whole view of Postgres.
 *
 * The domain depends on this interface, never on `pg`: that is what makes the registration and
 * retirement rules testable without a database, and it keeps SQL from drifting into route handlers.
 */
export interface Store extends Catalogue {
  /**
   * Serialises control-plane work across requests. Registration and trigger reconciliation need it:
   * `POST /subscriptions` is not idempotent, so two concurrent reconciles would otherwise each
   * create one.
   *
   * The section runs against the catalogue bound to the locked connection. Take every key the
   * section needs in one call — see `withLock` in `./db.ts` for why nesting is a deadlock.
   */
  withLock<T>(keys: readonly string[], fn: (locked: Catalogue) => Promise<T>): Promise<T>;
  /** Whether Postgres answers at all (readiness). */
  reachable(): Promise<boolean>;
}

const repositories = (db: Queryable): Repositories => ({
  definitions: definitionStore(db),
  dependencies: dependencyStore(db),
  deployments: deploymentStore(db),
  triggers: triggerStore(db),
});

export function createStore(db: Db): Store {
  return {
    ...repositories(db),
    transaction: (fn) => transaction(db, (tx) => fn(repositories(tx))),
    withLock: (keys, fn) =>
      withLock(db, keys, (client) =>
        fn({
          ...repositories(client),
          transaction: (inner) => transactionOn(client, () => inner(repositories(client))),
        }),
      ),
    reachable: () =>
      db.query('SELECT 1').then(
        () => true,
        () => false,
      ),
  };
}
