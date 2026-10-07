-- Provisions the application's schema and its three roles (contract IC-51,
-- NFR-IC-16, NFR-IC-17; register A28 and A39, both assumed).
--
-- Run once for each environment, by an administrator, with the cluster's
-- administrative credential, against the application's database, before the
-- application is first deployed:
--
--   psql "$ADMIN_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v migrate_password="…" -v app_password="…" -v backup_password="…" \
--     -f scripts/provision.sql
--
-- It is not a migration, and no migration holds a schema, a role, or a grant.
-- It is safe to run again: the restore procedure runs it on an empty database.
-- It creates nothing of Istorico's, and it grants nothing for the `vector`
-- extension, which α 0.1.0 does not create (contract IC-23).

\set ON_ERROR_STOP on

-- Each refusal raises an error, so that psql stops and exits with a failure.
\if :{?migrate_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'migrate_password is not set'; END $$;
\endif
\if :{?app_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'app_password is not set'; END $$;
\endif
\if :{?backup_password}
\else
  DO $$ BEGIN RAISE EXCEPTION 'backup_password is not set'; END $$;
\endif

-- NFR-I18-03: the database is UTF8. An encoding cannot be changed here, so a
-- database created otherwise is refused.
SELECT pg_encoding_to_char(encoding) = 'UTF8' AS is_utf8
  FROM pg_database WHERE datname = current_database() \gset
\if :is_utf8
\else
  DO $$ BEGIN RAISE EXCEPTION 'the database is not UTF8'; END $$;
\endif

-- Roles belong to the cluster, so each is created only where it is missing.
SELECT 'CREATE ROLE ekdotico_migrate' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ekdotico_migrate') \gexec
SELECT 'CREATE ROLE ekdotico_app' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ekdotico_app') \gexec
SELECT 'CREATE ROLE ekdotico_backup' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ekdotico_backup') \gexec

ALTER ROLE ekdotico_migrate LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'migrate_password';
ALTER ROLE ekdotico_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
ALTER ROLE ekdotico_backup LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'backup_password';

-- An administrator that is not a superuser, as on a managed cluster, has to be
-- a member of a role to create a schema it owns and to set its default privileges.
GRANT ekdotico_migrate TO CURRENT_USER;

-- `public` stays empty, and no application role may create a schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE ON DATABASE %I FROM PUBLIC, ekdotico_migrate, ekdotico_app, ekdotico_backup', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ekdotico_migrate, ekdotico_app, ekdotico_backup', current_database()) \gexec

-- The migration role owns the schema; only the deployment pipeline uses it.
CREATE SCHEMA IF NOT EXISTS ekdotico AUTHORIZATION ekdotico_migrate;

-- The runtime role reads and writes rows and cannot change structure.
GRANT USAGE ON SCHEMA ekdotico TO ekdotico_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ekdotico TO ekdotico_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ekdotico TO ekdotico_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ekdotico_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT USAGE, SELECT ON SEQUENCES TO ekdotico_app;

-- The backup role: select on the application schema, and nothing else.
GRANT USAGE ON SCHEMA ekdotico TO ekdotico_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA ekdotico TO ekdotico_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA ekdotico TO ekdotico_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT SELECT ON TABLES TO ekdotico_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT SELECT ON SEQUENCES TO ekdotico_backup;
