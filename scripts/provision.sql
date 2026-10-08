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
--
-- The administrator need not be a superuser. It needs CREATEROLE, and it has to
-- own the database, or the revokes on the database below only warn. An
-- administrator that did not itself create the three roles needs the ADMIN
-- option on each of them.
--
-- What it cannot do from here: a role may still connect to another database of
-- the cluster, which is revoked on that database, and the backup role may still
-- create a large object, which is a privilege of the cluster and not of a schema.

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
-- PostgreSQL answers an empty password by clearing it with a notice.
SELECT :'migrate_password' = '' OR :'app_password' = '' OR :'backup_password' = '' AS empty_password \gset
\if :empty_password
  DO $$ BEGIN RAISE EXCEPTION 'a password is empty'; END $$;
\endif

-- NFR-I18-03: the database is UTF8 with the en_US.UTF-8 locale. Neither can be
-- changed here, so a database created otherwise is refused. The locale is read
-- from the libc provider's fields; a database of another provider is refused too.
SELECT pg_encoding_to_char(encoding) = 'UTF8' AS is_utf8,
       datlocprovider = 'c'
         AND replace(lower(datcollate), '-', '') = 'en_us.utf8'
         AND replace(lower(datctype), '-', '') = 'en_us.utf8' AS is_en_us
  FROM pg_database WHERE datname = current_database() \gset
\if :is_utf8
\else
  DO $$ BEGIN RAISE EXCEPTION 'the database is not UTF8'; END $$;
\endif
\if :is_en_us
\else
  DO $$ BEGIN RAISE EXCEPTION 'the locale of the database is not en_US.UTF-8'; END $$;
\endif

-- Roles belong to the cluster, so each is created only where it is missing.
SELECT 'CREATE ROLE ekdotico_migrate' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ekdotico_migrate') \gexec
SELECT 'CREATE ROLE ekdotico_app' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ekdotico_app') \gexec
SELECT 'CREATE ROLE ekdotico_backup' WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ekdotico_backup') \gexec

-- A new role holds no attribute. One that exists already and holds more than a
-- login is refused, before anything is changed: only a superuser may take an
-- attribute away, so this script does not try to.
SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS wide
  FROM pg_roles WHERE rolname IN ('ekdotico_migrate', 'ekdotico_app', 'ekdotico_backup') \gset
\if :wide
  DO $$ BEGIN RAISE EXCEPTION 'an application role holds more than a login'; END $$;
\endif

ALTER ROLE ekdotico_migrate LOGIN PASSWORD :'migrate_password';
ALTER ROLE ekdotico_app LOGIN PASSWORD :'app_password';
ALTER ROLE ekdotico_backup LOGIN PASSWORD :'backup_password';

-- An administrator that is not a superuser has to be a member of a role to
-- create a schema it owns and to set its default privileges. The membership is
-- taken away again by the last statement.
GRANT ekdotico_migrate TO CURRENT_USER;

-- `public` stays empty, no application role may create a schema, and none may
-- write a temporary table: each is confined to the application schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SELECT format('REVOKE CREATE, TEMPORARY ON DATABASE %I FROM PUBLIC, ekdotico_migrate, ekdotico_app, ekdotico_backup', current_database()) \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO ekdotico_migrate, ekdotico_app, ekdotico_backup', current_database()) \gexec

-- The migration role owns the schema; only the deployment pipeline uses it.
CREATE SCHEMA IF NOT EXISTS ekdotico AUTHORIZATION ekdotico_migrate;

-- PostgreSQL lets everyone execute a new function. Here nobody may unless it is
-- granted, or the backup role could write through a function of the schema.
-- The default has to be revoked for the role as a whole; one for the schema
-- alone cannot take away a default that holds everywhere.
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate REVOKE EXECUTE ON ROUTINES FROM PUBLIC;
REVOKE EXECUTE ON ALL ROUTINES IN SCHEMA ekdotico FROM PUBLIC;

-- The runtime role reads and writes rows and cannot change structure.
GRANT USAGE ON SCHEMA ekdotico TO ekdotico_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ekdotico TO ekdotico_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ekdotico TO ekdotico_app;
GRANT EXECUTE ON ALL ROUTINES IN SCHEMA ekdotico TO ekdotico_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ekdotico_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT USAGE, SELECT ON SEQUENCES TO ekdotico_app;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT EXECUTE ON ROUTINES TO ekdotico_app;

-- The backup role: select on the application schema, and nothing else.
GRANT USAGE ON SCHEMA ekdotico TO ekdotico_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA ekdotico TO ekdotico_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA ekdotico TO ekdotico_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT SELECT ON TABLES TO ekdotico_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE ekdotico_migrate IN SCHEMA ekdotico
  GRANT SELECT ON SEQUENCES TO ekdotico_backup;

-- The administrator leaves the migration role, so that nothing it creates
-- later lands in the schema under its own name, where no role could read it.
REVOKE ekdotico_migrate FROM CURRENT_USER;
