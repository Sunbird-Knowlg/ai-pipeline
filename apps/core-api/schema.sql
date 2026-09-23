-- Catalogue (control-plane) store. Idempotent; applied by core-api on boot.
-- Execution state lives in Restate; nothing here tracks runs.

CREATE TABLE IF NOT EXISTS workflow_definitions (
  name          text        NOT NULL,
  version       text        NOT NULL,
  kind          text        NOT NULL CHECK (kind IN ('workflow', 'service')),
  restate_name  text        NOT NULL,
  visibility    text        NOT NULL CHECK (visibility IN ('public', 'private')),
  description   text        NOT NULL DEFAULT '',
  metadata      jsonb       NOT NULL,
  input_schema  jsonb       NOT NULL,
  output_schema jsonb       NOT NULL,
  config_schema jsonb       NOT NULL,
  contract_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS workflow_definitions_latest ON workflow_definitions (name, updated_at DESC);

CREATE TABLE IF NOT EXISTS workflow_deployments (
  deployment_id   text        PRIMARY KEY,
  name            text        NOT NULL,
  version         text        NOT NULL,
  endpoint_uri    text        NOT NULL,
  artifact_digest text        NOT NULL,
  mode            text        NOT NULL CHECK (mode IN ('dev', 'immutable')),
  status          text        NOT NULL CHECK (status IN ('active', 'draining', 'retired')),
  registered_at   timestamptz NOT NULL DEFAULT now(),
  drained_at      timestamptz,
  FOREIGN KEY (name, version) REFERENCES workflow_definitions (name, version)
);
CREATE INDEX IF NOT EXISTS workflow_deployments_by_name ON workflow_deployments (name, registered_at DESC);

CREATE TABLE IF NOT EXISTS workflow_dependencies (
  name            text NOT NULL,
  version         text NOT NULL,
  dependency_name text NOT NULL,
  dependency_kind text NOT NULL CHECK (dependency_kind IN ('workflow', 'service')),
  PRIMARY KEY (name, version, dependency_name),
  FOREIGN KEY (name, version) REFERENCES workflow_definitions (name, version)
);

CREATE TABLE IF NOT EXISTS workflow_triggers (
  name            text        NOT NULL,
  trigger_id      text        NOT NULL,
  type            text        NOT NULL CHECK (type IN ('rest', 'kafka')),
  definition      jsonb       NOT NULL,
  desired_enabled boolean     NOT NULL DEFAULT true,
  subscription_id text,
  observed_status text        NOT NULL DEFAULT 'pending',
  last_error      text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (name, trigger_id)
);
