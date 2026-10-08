// The migrations and prisma/schema.prisma describe the same database. A model
// changed without a migration, or a migration edited by hand away from its
// model, fails here and not at the first query in production.
import { spawnSync } from 'node:child_process';
import { afterAll, expect, it } from 'vitest';
import { createDatabase } from './database.ts';

const database = createDatabase('drift');

afterAll(() => database.drop());

it('a database with every migration deployed equals the schema file', () => {
  // The connection of the migration role, as database.ts builds it: the role
  // that owns the tables, with the local password of .env.example.
  const url = new URL(database.appUrl);
  url.username = 'ekdotico_migrate';
  url.password = 'local-migrate';
  url.searchParams.set('schema', 'ekdotico');

  // --exit-code: 0 where the two are equal, 2 where they differ, 1 on an error.
  // The script it prints on a difference is the migration that is missing.
  const diff = spawnSync(
    'pnpm',
    [
      'exec',
      'prisma',
      'migrate',
      'diff',
      '--from-config-datasource',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
      '--exit-code',
    ],
    { encoding: 'utf8', env: { ...process.env, MIGRATE_DATABASE_URL: url.toString() } },
  );
  expect(diff.stdout + diff.stderr).toContain('-- This is an empty migration.');
  expect(diff.status).toBe(0);
});
