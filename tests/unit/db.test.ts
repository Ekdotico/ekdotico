// NFR-SE-06 (A10): the database client waits seconds, never without end. This
// asserts what db.ts hands the adapter, which hands its first argument whole to
// the pool of the driver (`new pg.Pool(this.config)` in @prisma/adapter-pg
// 7.10.0). That the server receives the statement timeout is shown against a
// real one in tests/integration/proxy.test.ts.
import { expect, it, vi } from 'vitest';

const seen = vi.hoisted(() => ({ adapters: [] as unknown[][], clients: [] as unknown[][] }));

vi.mock('@prisma/adapter-pg', () => ({
  PrismaPg: class {
    constructor(...given: unknown[]) {
      seen.adapters.push(given);
    }
  },
}));
vi.mock('../../src/generated/prisma/client.ts', () => ({
  PrismaClient: class {
    constructor(...given: unknown[]) {
      seen.clients.push(given);
    }
  },
}));

const URL = 'postgresql://ekdotico_app:x@db.example.test:5432/ekdotico';
Object.assign(process.env, {
  FOUNDING_TEAM_EMAILS: '',
  APP_ORIGIN: 'http://localhost:3000',
  DATABASE_URL: URL,
  VALKEY_URL: 'redis://unused',
  AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
});

it('gives the database 5 seconds to connect, 5 for a statement, and 5 to answer at all', async () => {
  const { db } = await import('../../src/lib/db.ts');
  expect(db()).toBe(db());
  expect(seen.clients).toHaveLength(1);
  expect(seen.adapters).toEqual([
    [
      { connectionString: URL, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 5000 },
      { schema: 'ekdotico' },
    ],
  ]);
});
