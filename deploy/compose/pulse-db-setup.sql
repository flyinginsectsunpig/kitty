-- pulse's own database role: it owns schema "pulse" (exchange rates) and nothing else, so it never runs with access to
-- the ledger's money data. Safe to run on every start: run by the pulse-db-setup service in docker-compose.yml with
--   psql -v pulse_password=...
\set ON_ERROR_STOP on

SELECT format('CREATE ROLE pulse LOGIN PASSWORD %L', :'pulse_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pulse') \gexec
SELECT format('ALTER ROLE pulse WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'pulse_password') \gexec

CREATE SCHEMA IF NOT EXISTS pulse AUTHORIZATION pulse;
ALTER SCHEMA pulse OWNER TO pulse;
