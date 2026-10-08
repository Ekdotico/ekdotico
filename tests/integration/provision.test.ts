// Runs scripts/provision.sql against throwaway databases on a real PostgreSQL
// server and asserts each privilege of NFR-IC-17 by exercising it. Needs `psql`
// and ADMIN_DATABASE_URL, a superuser connection to any database of a LOCAL server.
//
// Roles belong to the cluster, so the three roles outlive the test, with the
// local passwords of .env.example; it drops the databases and the one extra
// role it creates.
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set; see README.md, "Local services".');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(adminUrl).hostname)) {
  throw new Error(
    'ADMIN_DATABASE_URL must point at a local server: this test resets the passwords of the three roles.',
  );
}

const suffix = randomBytes(4).toString('hex');
const database = `ekdotico_test_${suffix}`;
const urlFor = (name: string, user?: string, password?: string) => {
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  if (user) url.username = user;
  if (password) url.password = password;
  return url.toString();
};
const testUrl = urlFor(database);
const CREATE_OPTIONS = `ENCODING 'UTF8' LOCALE 'en_US.UTF-8' LOCALE_PROVIDER libc TEMPLATE template0`;
const PASSWORDS = { migrate: 'local-migrate', app: 'local-app', backup: 'local-backup' };
const REFUSED = /permission denied|must be owner/;

function psql(url: string, args: string[]) {
  const result = spawnSync('psql', [url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  return { ok: result.status === 0, out: result.stdout.trim(), err: result.stderr };
}
const admin = (statement: string) => psql(adminUrl, ['-c', statement]);
const sql = (statement: string) => psql(testUrl, ['-c', statement]);
const as = (role: string, statement: string) => sql(`SET ROLE ${role}; ${statement}`);
function provision(url = testUrl, passwords: Partial<typeof PASSWORDS> = PASSWORDS) {
  const variables = Object.entries(passwords).flatMap(([role, password]) => [
    '-v',
    `${role}_password=${password}`,
  ]);
  return psql(url, [...variables, '-f', 'scripts/provision.sql']);
}
/** Provisions a database created with the given options, drops it, and returns the result. */
function provisionScratch(name: string, options: string) {
  const scratch = `${database}_${name}`;
  admin(`CREATE DATABASE ${scratch} ${options}`);
  const result = provision(urlFor(scratch));
  admin(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`);
  return result;
}

let deployed: SpawnSyncReturns<string>;

beforeAll(() => {
  expect(admin(`CREATE DATABASE ${database} ${CREATE_OPTIONS}`).err).toBe('');
  expect(provision().err).not.toContain('ERROR');
  // The migrations are deployed on the schema as provisioned, before anything else is in it.
  const url = new URL(urlFor(database, 'ekdotico_migrate', PASSWORDS.migrate));
  url.searchParams.set('schema', 'ekdotico');
  deployed = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    encoding: 'utf8',
    env: { ...process.env, MIGRATE_DATABASE_URL: url.toString() },
  });
});

afterAll(() => {
  admin(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
});

describe('the provisioning script (contract IC-51)', () => {
  it('can be run again without error', () => {
    expect(provision().ok).toBe(true);
  });

  it('refuses to run without a password', () => {
    const result = provision(testUrl, { app: 'x' });
    expect(result.ok).toBe(false);
    expect(result.err).toContain('migrate_password is not set');
  });

  it('refuses an empty password, which PostgreSQL would answer by clearing it', () => {
    const result = provision(testUrl, { ...PASSWORDS, app: '' });
    expect(result.ok).toBe(false);
    expect(result.err).toContain('a password is empty');
  });

  it('refuses a database that is not UTF8 (NFR-I18-03)', () => {
    const result = provisionScratch('latin1', `ENCODING 'LATIN1' LOCALE 'C' TEMPLATE template0`);
    expect(result.ok).toBe(false);
    expect(result.err).toContain('the database is not UTF8');
  });

  it('refuses a database whose locale is not en_US.UTF-8 (NFR-I18-03)', () => {
    const result = provisionScratch('c', `ENCODING 'UTF8' LOCALE 'C' TEMPLATE template0`);
    expect(result.ok).toBe(false);
    expect(result.err).toContain('the locale of the database is not en_US.UTF-8');
  });

  it('creates the ekdotico schema, owned by the migration role', () => {
    expect(sql(`SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'ekdotico'`).out).toBe(
      'ekdotico_migrate',
    );
  });

  it('creates nothing of Istorico and no vector extension', () => {
    expect(sql(`SELECT count(*) FROM pg_namespace WHERE nspname = 'istorico'`).out).toBe('0');
    expect(sql(`SELECT count(*) FROM pg_roles WHERE rolname LIKE 'istorico%'`).out).toBe('0');
    expect(sql(`SELECT count(*) FROM pg_extension WHERE extname = 'vector'`).out).toBe('0');
  });

  it('gives no application role an attribute or a membership', () => {
    const flags = sql(
      `SELECT bool_or(rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)
         FROM pg_roles WHERE rolname IN ('ekdotico_migrate', 'ekdotico_app', 'ekdotico_backup')`,
    );
    expect(flags.out).toBe('f');
    const memberships = sql(
      `SELECT count(*) FROM pg_auth_members
        WHERE member::regrole::text IN ('ekdotico_migrate', 'ekdotico_app', 'ekdotico_backup')`,
    );
    expect(memberships.out).toBe('0');
  });

  // The row itself is counted: `pg_has_role` answers true of a superuser
  // whatever the script did. Other runs on this server add rows for
  // administrators of their own, so only this session's is looked for.
  it('leaves the administrator outside the migration role', () => {
    const rows = sql(`SELECT count(*) FROM pg_auth_members
                       WHERE roleid = 'ekdotico_migrate'::regrole AND member = session_user::regrole`);
    expect(rows.out).toBe('0');
  });

  // Lines 69 to 76 of the script. The attribute is given and the script run in
  // one transaction, which ends unfinished when psql stops: the roles belong to
  // the server, and no other session ever sees the attribute.
  it('refuses a role that holds more than a login, before it changes anything', () => {
    const variables = Object.entries(PASSWORDS).flatMap(([role, password]) => [
      '-v',
      `${role}_password=${password}`,
    ]);
    const result = psql(testUrl, [
      '-c',
      'BEGIN',
      '-c',
      'ALTER ROLE ekdotico_backup CREATEDB',
      ...variables,
      '-f',
      'scripts/provision.sql',
    ]);
    expect(result.ok).toBe(false);
    expect(result.err).toContain('an application role holds more than a login');
    expect(sql(`SELECT rolcreatedb FROM pg_roles WHERE rolname = 'ekdotico_backup'`).out).toBe('f');
  });

  it.each(Object.entries(PASSWORDS))('lets ekdotico_%s log in to the database', (role, password) => {
    const login = psql(urlFor(database, `ekdotico_${role}`, password), ['-c', 'SELECT current_user']);
    expect(login.out).toBe(`ekdotico_${role}`);
  });
});

// A managed cluster gives its administrator CREATEROLE and no superuser. Such an
// administrator holds the ADMIN option on the roles it created, and owns the database.
describe('the provisioning script, run by an administrator that is not a superuser', () => {
  const administrator = `ekdotico_test_admin_${suffix}`;
  const owned = `${database}_owned`;

  beforeAll(() => {
    admin(`CREATE ROLE ${administrator} LOGIN CREATEROLE PASSWORD 'local-administrator'`);
    admin(`GRANT ekdotico_migrate, ekdotico_app, ekdotico_backup TO ${administrator}
             WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`);
    admin(`CREATE DATABASE ${owned} OWNER ${administrator} ${CREATE_OPTIONS}`);
  });
  afterAll(() => {
    admin(`DROP DATABASE IF EXISTS ${owned} WITH (FORCE)`);
    admin(`DROP ROLE IF EXISTS ${administrator}`);
  });

  it('completes, and completes again', () => {
    const url = urlFor(owned, administrator, 'local-administrator');
    expect(psql(url, ['-c', 'SELECT rolsuper FROM pg_roles WHERE rolname = current_user']).out).toBe('f');
    const first = provision(url);
    expect(first.err).not.toContain('ERROR');
    expect(first.ok).toBe(true);
    expect(provision(url).ok).toBe(true);
    const owner = psql(url, ['-c', `SELECT nspowner::regrole FROM pg_namespace WHERE nspname = 'ekdotico'`]);
    expect(owner.out).toBe('ekdotico_migrate');
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

// These objects are created by the migration role after the script last ran, so
// each role reaches them through the default privileges alone. A test above runs
// the script again, which would otherwise grant on everything that then exists.
describe('privileges on what the migration role creates later (NFR-IC-17)', () => {
  beforeAll(() => {
    const created = as(
      'ekdotico_migrate',
      `CREATE TABLE ekdotico.late (id serial PRIMARY KEY, body text);
       CREATE FUNCTION ekdotico.wipe() RETURNS void LANGUAGE sql SECURITY DEFINER
         AS 'DELETE FROM ekdotico.late';
       CREATE PROCEDURE ekdotico.wipe_too() LANGUAGE sql SECURITY DEFINER
         AS 'DELETE FROM ekdotico.late';`,
    );
    expect(created.err).toBe('');
  });

  describe('ekdotico_migrate', () => {
    it('changes structure in its schema', () => {
      expect(as('ekdotico_migrate', 'ALTER TABLE ekdotico.late ADD COLUMN extra int').ok).toBe(true);
    });
    it.each(['CREATE SCHEMA other', 'CREATE TABLE public.t (id int)', 'CREATE TEMP TABLE t (id int)'])(
      'is confined to its schema: %s',
      (statement) => {
        const result = as('ekdotico_migrate', statement);
        expect(result.ok).toBe(false);
        expect(result.err).toMatch(REFUSED);
      },
    );
  });

  describe('ekdotico_app', () => {
    it('reads and writes rows, uses the sequence, and executes a function', () => {
      expect(as('ekdotico_app', `INSERT INTO ekdotico.late (body) VALUES ('a')`).err).toBe('');
      expect(as('ekdotico_app', `UPDATE ekdotico.late SET body = 'b'`).ok).toBe(true);
      expect(as('ekdotico_app', 'SELECT body FROM ekdotico.late').out).toContain('b');
      expect(as('ekdotico_app', 'DELETE FROM ekdotico.late').ok).toBe(true);
      expect(as('ekdotico_app', 'SELECT ekdotico.wipe()').ok).toBe(true);
      expect(as('ekdotico_app', 'CALL ekdotico.wipe_too()').ok).toBe(true);
    });
    it.each([
      'CREATE TABLE ekdotico.t (id int)',
      'ALTER TABLE ekdotico.late ADD COLUMN x int',
      'DROP TABLE ekdotico.late',
      'TRUNCATE ekdotico.late',
      'CREATE SCHEMA other',
      'CREATE TABLE public.t (id int)',
      'CREATE TEMP TABLE t (id int)',
    ])('cannot change structure: %s', (statement) => {
      const result = as('ekdotico_app', statement);
      expect(result.ok).toBe(false);
      expect(result.err).toMatch(REFUSED);
    });
  });

  describe('ekdotico_backup (register A28)', () => {
    it('selects from the application schema', () => {
      expect(as('ekdotico_backup', 'SELECT count(*) FROM ekdotico.late').err).toBe('');
      expect(as('ekdotico_backup', 'SELECT last_value FROM ekdotico.late_id_seq').ok).toBe(true);
    });
    it.each([
      `INSERT INTO ekdotico.late (body) VALUES ('a')`,
      `UPDATE ekdotico.late SET body = 'c'`,
      'DELETE FROM ekdotico.late',
      'TRUNCATE ekdotico.late',
      'SELECT ekdotico.wipe()',
      'CALL ekdotico.wipe_too()',
      `SELECT nextval('ekdotico.late_id_seq')`,
      `SELECT setval('ekdotico.late_id_seq', 5)`,
      'CREATE TEMP TABLE t (id int)',
      'CREATE TABLE ekdotico.t (id int)',
      'ALTER TABLE ekdotico.late ADD COLUMN y int',
      'DROP TABLE ekdotico.late',
      'CREATE SCHEMA other',
      'CREATE TABLE public.t (id int)',
    ])('can do nothing else: %s', (statement) => {
      const result = as('ekdotico_backup', statement);
      expect(result.ok).toBe(false);
      expect(result.err).toMatch(REFUSED);
    });
  });
});

// The other half of the script: its grants on what is in the schema already,
// which the default privileges do not reach. The objects are left as a restore
// without privileges leaves them: no role may touch the table, and everyone may
// execute the function, which is PostgreSQL's own default.
describe('privileges on what exists when the script runs (NFR-IC-17)', () => {
  beforeAll(() => {
    const created = as(
      'ekdotico_migrate',
      `CREATE TABLE ekdotico.early (id serial PRIMARY KEY, body text);
       CREATE FUNCTION ekdotico.early_wipe() RETURNS void LANGUAGE sql SECURITY DEFINER
         AS 'DELETE FROM ekdotico.early';
       REVOKE ALL ON ekdotico.early, ekdotico.early_id_seq FROM ekdotico_app, ekdotico_backup;
       REVOKE ALL ON FUNCTION ekdotico.early_wipe() FROM ekdotico_app;
       GRANT EXECUTE ON FUNCTION ekdotico.early_wipe() TO PUBLIC;`,
    );
    expect(created.err).toBe('');
    // As they stand, the runtime role is shut out and the backup role can delete.
    expect(as('ekdotico_app', 'SELECT count(*) FROM ekdotico.early').err).toMatch(REFUSED);
    expect(as('ekdotico_backup', 'SELECT ekdotico.early_wipe()').ok).toBe(true);
    expect(provision().ok).toBe(true);
  });

  it('lets ekdotico_app read and write the rows, use the sequence, and execute the function', () => {
    expect(as('ekdotico_app', `INSERT INTO ekdotico.early (body) VALUES ('a')`).err).toBe('');
    expect(as('ekdotico_app', `UPDATE ekdotico.early SET body = 'b'`).ok).toBe(true);
    expect(as('ekdotico_app', 'SELECT body FROM ekdotico.early').out).toContain('b');
    expect(as('ekdotico_app', 'DELETE FROM ekdotico.early').ok).toBe(true);
    expect(as('ekdotico_app', 'SELECT ekdotico.early_wipe()').ok).toBe(true);
  });

  it('lets ekdotico_backup select', () => {
    expect(as('ekdotico_backup', 'SELECT count(*) FROM ekdotico.early').err).toBe('');
    expect(as('ekdotico_backup', 'SELECT last_value FROM ekdotico.early_id_seq').ok).toBe(true);
  });

  it.each([
    `INSERT INTO ekdotico.early (body) VALUES ('a')`,
    `UPDATE ekdotico.early SET body = 'c'`,
    'DELETE FROM ekdotico.early',
    'TRUNCATE ekdotico.early',
    'SELECT ekdotico.early_wipe()',
    `SELECT nextval('ekdotico.early_id_seq')`,
  ])('lets ekdotico_backup neither write nor execute: %s', (statement) => {
    const result = as('ekdotico_backup', statement);
    expect(result.ok).toBe(false);
    expect(result.err).toMatch(REFUSED);
  });
});
