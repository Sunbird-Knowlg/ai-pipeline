-- Runs once on an empty data volume. The catalogue DB (`pipeline`) comes from POSTGRES_DB;
-- Langfuse (observability overlay) gets its own database.
CREATE DATABASE langfuse;
