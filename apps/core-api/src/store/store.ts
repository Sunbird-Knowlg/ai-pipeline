import { definitionStore, type DefinitionStore } from './definitions.js';
import { dependencyStore, type DependencyStore } from './dependencies.js';
import { deploymentStore, type DeploymentStore } from './deployments.js';
import { transaction, withLock, type Db, type Queryable } from './db.js';
import { triggerStore, type TriggerStore } from './triggers.js';

/** The four catalogue repositories, bound to a pool or to one transaction. */
export interface Repositories {
  definitions: DefinitionStore;
  dependencies: DependencyStore;
  deployments: DeploymentStore;
  triggers: TriggerStore;
}

/**
 * The control plane's whole view of Postgres.
 *
 * The domain depends on this interface, never on `pg`: that is what makes the registration and
 * retirement rules testable without a database, and it keeps SQL from drifting into route handlers.
 */
export interface Store extends Repositories {
  /** Runs `fn` inside one transaction, with the repositories bound to it. */
  transaction<T>(fn: (tx: Repositories) => Promise<T>): Promise<T>;
  /**
   * Serialises control-plane work on one key across requests. Registration and trigger
   * reconciliation need it: `POST /subscriptions` is not idempotent, so two concurrent reconciles
   * would otherwise each create one.
   */
  withLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
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
    withLock: (key, fn) => withLock(db, key, fn),
    reachable: () =>
      db.query('SELECT 1').then(
        () => true,
        () => false,
      ),
  };
}
