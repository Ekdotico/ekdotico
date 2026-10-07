// Runs scripts/provision.sql against a throwaway database on a real PostgreSQL
// server and asserts each privilege of NFR-IC-17 by exercising it. Needs `psql`
// and ADMIN_DATABASE_URL, a superuser connection to any database of the server.
//
// Roles belong to the cluster, so the three roles outlive the test; it drops
// only the database it created. The passwords are the local ones of .env.example.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set; see README.md, "Local services".');

const database = `ekdotico_test_${randomBytes(4).toString('hex')}`;
const testUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
})();

function psql(url: string, args: string[]) {
  const result = spawnSync('psql', [url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr };
}
const sql = (statement: string) => psql(testUrl, ['-c', statement]);
const as = (role: string, statement: string) => sql(`SET ROLE ${role}; ${statement}`);
const provision = (extra: string[] = []) =>
  psql(testUrl, [
    '-v',
    'migrate_password=local-migrate',
    '-v',
    'app_password=local-app',
    '-v',
    'backup_password=local-backup',
    ...extra,
    '-f',
    'scripts/provision.sql',
  ]);

let deployed: SpawnSyncReturns<string>;

beforeAll(() => {
  const created = psql(adminUrl, ['-c', `CREATE DATABASE ${database} ENCODING 'UTF8' TEMPLATE template0`]);
  expect(created.err).toBe('');
  expect(provision().ok).toBe(true);
  // The migrations are deployed on the schema as provisioned, before anything else is in it.
  const url = new URL(testUrl);
  url.username = 'ekdotico_migrate';
  url.password = 'local-migrate';
  url.searchParams.set('schema', 'ekdotico');
  deployed = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    encoding: 'utf8',
    env: { ...process.env, MIGRATE_DATABASE_URL: url.toString() },
  });
  expect(as('ekdotico_migrate', 'CREATE TABLE ekdotico.probe (id serial PRIMARY KEY, body text)').ok).toBe(
    true,
  );
});

afterAll(() => {
  psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`]);
});

describe('the provisioning script (contract IC-51)', () => {
  it('can be run again without error', () => {
    expect(provision().ok).toBe(true);
  });

  it('refuses to run without a password', () => {
    const result = psql(testUrl, ['-v', 'app_password=x', '-f', 'scripts/provision.sql']);
    expect(result.ok).toBe(false);
    expect(result.err).toContain('migrate_password is not set');
  });

  it('refuses a database that is not UTF8', () => {
    const latin = `${database}_latin1`;
    psql(adminUrl, ['-c', `CREATE DATABASE ${latin} ENCODING 'LATIN1' LOCALE 'C' TEMPLATE template0`]);
    const url = new URL(testUrl);
    url.pathname = `/${latin}`;
    const result = psql(url.toString(), [
      '-v',
      'migrate_password=a',
      '-v',
      'app_password=b',
      '-v',
      'backup_password=c',
      '-f',
      'scripts/provision.sql',
    ]);
    psql(adminUrl, ['-c', `DROP DATABASE IF EXISTS ${latin} WITH (FORCE)`]);
    expect(result.ok).toBe(false);
    expect(result.err).toContain('the database is not UTF8');
  });

  it('creates the ekdotico schema, owned by the migration role, in a UTF8 database', () => {
    expect(sql(`SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'ekdotico'`).out).toBe(
      'ekdotico_migrate',
    );
    expect(sql('SHOW server_encoding').out).toBe('UTF8');
  });

  it('creates nothing of Istorico and no vector extension', () => {
    expect(sql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'istorico'`).out).toBe('0');
    expect(sql(`SELECT count(*) FROM pg_roles WHERE rolname LIKE 'istorico%'`).out).toBe('0');
    expect(sql(`SELECT count(*) FROM pg_extension WHERE extname = 'vector'`).out).toBe('0');
  });

  it('gives no application role more than a login', () => {
    const flags = sql(
      `SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
         FROM pg_roles WHERE rolname IN ('ekdotico_migrate', 'ekdotico_app', 'ekdotico_backup')`,
    );
    expect(flags.out).toBe('f');
  });
});

describe('the migration history (contract IC-23)', () => {
  it('is created by the migration role inside the ekdotico schema, and public stays empty', () => {
    expect(deployed.stdout + deployed.stderr).toContain('20261007000000_init');
    expect(deployed.status).toBe(0);
    expect(
      sql(
        `SELECT tableowner FROM pg_tables WHERE schemaname = 'ekdotico' AND tablename = '_prisma_migrations'`,
      ).out,
    ).toBe('ekdotico_migrate');
    expect(sql(`SELECT count(*) FROM pg_tables WHERE schemaname = 'public'`).out).toBe('0');
  });
});

describe('ekdotico_migrate (NFR-IC-17)', () => {
  it('changes structure in its schema', () => {
    expect(as('ekdotico_migrate', 'ALTER TABLE ekdotico.probe ADD COLUMN extra int').ok).toBe(true);
  });
  it('cannot create a schema', () => {
    expect(as('ekdotico_migrate', 'CREATE SCHEMA other').ok).toBe(false);
  });
  it('cannot create anything in public', () => {
    expect(as('ekdotico_migrate', 'CREATE TABLE public.t (id int)').ok).toBe(false);
  });
});

describe('ekdotico_app (NFR-IC-17)', () => {
  it('reads and writes rows of a table the migration role created', () => {
    expect(as('ekdotico_app', `INSERT INTO ekdotico.probe (body) VALUES ('a')`).ok).toBe(true);
    expect(as('ekdotico_app', `UPDATE ekdotico.probe SET body = 'b'`).ok).toBe(true);
    expect(as('ekdotico_app', 'SELECT body FROM ekdotico.probe').out).toContain('b');
    expect(as('ekdotico_app', 'DELETE FROM ekdotico.probe').ok).toBe(true);
  });
  it.each([
    'CREATE TABLE ekdotico.t (id int)',
    'ALTER TABLE ekdotico.probe ADD COLUMN x int',
    'DROP TABLE ekdotico.probe',
    'TRUNCATE ekdotico.probe',
    'CREATE SCHEMA other',
    'CREATE TABLE public.t (id int)',
  ])('cannot change structure: %s', (statement) => {
    expect(as('ekdotico_app', statement).ok).toBe(false);
  });
});

describe('ekdotico_backup (NFR-IC-17; register A28)', () => {
  it('selects from the application schema', () => {
    expect(as('ekdotico_backup', 'SELECT count(*) FROM ekdotico.probe').ok).toBe(true);
  });
  it.each([
    `INSERT INTO ekdotico.probe (body) VALUES ('a')`,
    `UPDATE ekdotico.probe SET body = 'c'`,
    'DELETE FROM ekdotico.probe',
    'TRUNCATE ekdotico.probe',
    'CREATE TABLE ekdotico.t (id int)',
    'ALTER TABLE ekdotico.probe ADD COLUMN y int',
    'CREATE TABLE public.t (id int)',
  ])('can do nothing else: %s', (statement) => {
    expect(as('ekdotico_backup', statement).ok).toBe(false);
  });
});
