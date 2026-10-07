-- The RAG store: its own database, holding the collection registry, the document ledger, and one
-- vector table per collection incarnation (created at run time by Mastra's PgVector, in `vectors`).
--
-- Applied when Postgres is provisioned, like the catalogue (20-catalogue.sql). Re-runnable, but
-- `docker-entrypoint-initdb.d` only runs on an empty data directory; to apply it to an existing
-- volume:
--   docker compose exec -T postgres psql -U pipeline -d pipeline < infra/postgres/init/30-rag.sql
--
-- The vector tables are the one exception to "no DDL from the application": a collection is data,
-- created and dropped at run time, and each incarnation gets a table of its own dimension. The role
-- the RAG units connect as therefore needs CREATE on schema `vectors`; the `vector` extension itself
-- is created here, because creating an extension needs privileges the units should not have.

SELECT 'CREATE DATABASE rag'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'rag')\gexec

\connect rag

CREATE EXTENSION IF NOT EXISTS vector;
CREATE SCHEMA IF NOT EXISTS vectors;

-- One row per collection incarnation. `id` is the incarnation (a fresh one after every drop), and
-- names the vector table, so a process that cached the old table can never write into the new one.
CREATE TABLE IF NOT EXISTS rag_collections (
  id              uuid        PRIMARY KEY,
  name            text        NOT NULL UNIQUE,
  table_name      text        NOT NULL UNIQUE,
  status          text        NOT NULL CHECK (status IN ('creating', 'active', 'dropping')),
  embedding_model text        NOT NULL,
  dimension       integer     NOT NULL CHECK (dimension > 0),
  settings        jsonb       NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- The ledger: what is indexed for each document, and the order key of the last write or delete.
-- A deleted document keeps its row (a tombstone), so an older write that arrives late cannot bring
-- it back. Rows go with their collection.
CREATE TABLE IF NOT EXISTS rag_documents (
  collection_id uuid        NOT NULL REFERENCES rag_collections (id) ON DELETE CASCADE,
  document_id   text        NOT NULL,
  status        text        NOT NULL CHECK (status IN ('ready', 'deleted')),
  fingerprint   text,
  chunk_count   integer     NOT NULL DEFAULT 0,
  title         text,
  format        text,
  metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  seq           bigint      NOT NULL,
  run_id        text        NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (collection_id, document_id)
);
CREATE INDEX IF NOT EXISTS rag_documents_by_update ON rag_documents (collection_id, updated_at DESC);
