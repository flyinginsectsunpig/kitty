-- The ai service's own database role: it owns schema "ai" (its dedupe tables) and nothing else, so code that
-- decodes users' photos never runs with access to the ledger's money data. Safe to run on every start:
-- run by the ai-db-setup service in docker-compose.yml with  psql -v ai_password=...
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE ai LOGIN PASSWORD %L', :'ai_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ai') \gexec
SELECT format('ALTER ROLE ai WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'ai_password') \gexec

CREATE SCHEMA IF NOT EXISTS ai AUTHORIZATION ai;
ALTER SCHEMA ai OWNER TO ai;
-- Tables an earlier version created while connected as postgres.
DO $$
DECLARE t record;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'ai' LOOP
        EXECUTE format('ALTER TABLE ai.%I OWNER TO ai', t.tablename);
    END LOOP;
END $$;
