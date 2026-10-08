// A throwaway database for an integration test: created on the local server,
// provisioned by scripts/provision.sql, and migrated as the migration role, so
// that a test meets the schema exactly as a deployment does and connects as the
// runtime role, never as the administrator.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const adminUrl = process.env.ADMIN_DATABASE_URL;
if (!adminUrl) throw new Error('ADMIN_DATABASE_URL is not set; see README.md, "Local services".');
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(adminUrl).hostname)) {
  throw new Error(
    'ADMIN_DATABASE_URL must point at a local server: these tests reset the passwords of the three roles.',
  );
}

const PASSWORDS = { migrate: 'local-migrate', app: 'local-app', backup: 'local-backup' };

function psql(url: string, args: string[]) {
  const result = spawnSync('psql', [url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...args], {
    encoding: 'utf8',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function urlFor(name: string, role?: keyof typeof PASSWORDS) {
  const url = new URL(adminUrl!);
  url.pathname = `/${name}`;
  if (role) {
    url.username = `ekdotico_${role}`;
    url.password = PASSWORDS[role];
  }
  return url.toString();
}

export function createDatabase(label: string) {
  const name = `ekdotico_test_${label}_${randomBytes(4).toString('hex')}`;
  psql(adminUrl!, [
    '-c',
    `CREATE DATABASE ${name} ENCODING 'UTF8' LOCALE 'en_US.UTF-8' LOCALE_PROVIDER libc TEMPLATE template0`,
  ]);
  const variables = Object.entries(PASSWORDS).flatMap(([role, password]) => [
    '-v',
    `${role}_password=${password}`,
  ]);
  psql(urlFor(name), [...variables, '-f', 'scripts/provision.sql']);
  const migrate = new URL(urlFor(name, 'migrate'));
  migrate.searchParams.set('schema', 'ekdotico');
  const deployed = spawnSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
    encoding: 'utf8',
    env: { ...process.env, MIGRATE_DATABASE_URL: migrate.toString() },
  });
  if (deployed.status !== 0) throw new Error(deployed.stdout + deployed.stderr);
  return {
    /** The connection of the runtime role, ekdotico_app. */
    appUrl: urlFor(name, 'app'),
    /** Runs a statement as the administrator, for a test to look at a row directly. */
    sql: (statement: string) => psql(urlFor(name), ['-c', `SET search_path = ekdotico; ${statement}`]),
    drop: () => psql(adminUrl!, ['-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]),
  };
}
