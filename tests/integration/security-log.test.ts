// The security log of NFR-SE-19 and its deletion timer (NFR-RE-15), against a
// provisioned and migrated database, written as the runtime role and read back
// as the administrator.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDatabase } from './database.ts';

const database = createDatabase('security_log');

// The modules read their settings from the environment, once, when first used.
process.env.DATABASE_URL = database.appUrl;
process.env.FOUNDING_TEAM_EMAILS ??= '';
process.env.APP_ORIGIN ??= 'https://app.example.test';
process.env.EMAIL_TRANSPORT ??= 'sink';
process.env.EMAIL_SINK_DIRECTORY ??= '/unused';
process.env.VALKEY_URL ??= 'redis://valkey.example.test:6379';
process.env.AUTH_SECRET ??= 'a-test-secret-of-at-least-thirty-two-characters';
delete process.env.SECURITY_LOG_RETENTION_DAYS;

const { db } = await import('../../src/lib/db.ts');
const { securityLog, deleteExpiredSecurityLog } = await import('../../src/lib/security-log.ts');
const { startTimers } = await import('../../src/lib/timers.ts');

const TABLE = '"SecurityLogEntry"';
const DOCUMENT = '0b0f6a52-6f0e-4c58-9d2c-3a1f1f6f7d11';
const DAY_MS = 24 * 60 * 60 * 1000;

/** The rows a statement returns, as the administrator; the first line answers the SET. */
const rows = (statement: string) => database.sql(statement).split('\n').slice(1);
const count = () => Number(rows(`SELECT count(*) FROM ${TABLE}`)[0]);
/** An entry written at a given time, which the application itself never sets. */
const insertAt = (id: string, time: Date) =>
  database.sql(
    `INSERT INTO ${TABLE} (id, "createdAt", kind) VALUES ('${id}', '${time.toISOString().replace('Z', '')}', 'forbidden')`,
  );

beforeEach(() => {
  database.sql(`TRUNCATE ${TABLE}`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db().$disconnect();
  database.drop();
});

describe('the table', () => {
  // NFR-SE-19: "and nothing else about a person". A column added to the table
  // is how personal data would get into the log, so adding one fails here.
  it('has the time, the kind, the two identifiers and its own id, and no other column', () => {
    expect(
      rows(
        `SELECT column_name || ' ' || data_type || ' ' || is_nullable FROM information_schema.columns
           WHERE table_schema = 'ekdotico' AND table_name = 'SecurityLogEntry' ORDER BY column_name`,
      ),
    ).toEqual([
      'createdAt timestamp without time zone NO',
      'documentId uuid YES',
      'id text NO',
      'kind text NO',
      'userId text YES',
    ]);
  });

  it('refers to no other table, so an entry outlives the user and the document it names', () => {
    expect(
      rows(
        `SELECT count(*) FROM pg_constraint WHERE conrelid = 'ekdotico.${TABLE}'::regclass AND contype = 'f'`,
      ),
    ).toEqual(['0']);
  });

  // NFR-IC-17, register D118: the backup role reads and writes nothing.
  it('can be read and not written by the backup role', () => {
    insertAt('seen', new Date());
    expect(rows(`SET ROLE ekdotico_backup; SELECT id FROM ${TABLE}`)).toContain('seen');
    expect(() =>
      database.sql(`SET ROLE ekdotico_backup; INSERT INTO ${TABLE} (id, kind) VALUES ('x', 'forbidden')`),
    ).toThrow(/permission denied/);
    expect(() => database.sql(`SET ROLE ekdotico_backup; DELETE FROM ${TABLE}`)).toThrow(/permission denied/);
    expect(count()).toBe(1);
  });
});

describe('securityLog', () => {
  it('writes an entry as the runtime role, with exactly what it was given', async () => {
    const before = Date.now();
    await securityLog({ kind: 'forbidden', userId: 'user-1', documentId: DOCUMENT });
    await securityLog({ kind: 'sign_in_refused' });

    expect(rows(`SELECT kind, "userId", "documentId" FROM ${TABLE} ORDER BY kind`)).toEqual([
      `forbidden|user-1|${DOCUMENT}`,
      'sign_in_refused||',
    ]);
    expect(rows(`SELECT count(*) FROM ${TABLE} WHERE "userId" IS NULL AND "documentId" IS NULL`)).toEqual([
      '1',
    ]);
    // The time is the moment of the write, in UTC, whatever the server's time zone.
    const entries = await db().securityLogEntry.findMany();
    for (const entry of entries) {
      expect(entry.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(entry.createdAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    }
  });

  it('stores nothing a caller passes beyond the kind and the two identifiers', async () => {
    const entry = { kind: 'forbidden', userId: 'user-1', email: 'someone@example.test' };
    await securityLog(entry as Parameters<typeof securityLog>[0]);
    expect(rows(`SELECT kind, "userId" FROM ${TABLE}`)).toEqual(['forbidden|user-1']);
  });

  // NFR-SE-06, A10 and A09: a write that fails changes nothing for the caller
  // and is reported on stderr with the kind and with the class and code of the fault.
  it('resolves when the database refuses the write, and reports the kind, the fault, and no identifier', async () => {
    database.sql(`ALTER TABLE ${TABLE} ADD CONSTRAINT refuse CHECK (kind <> 'rate_limit_reached')`);
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(
        securityLog({ kind: 'rate_limit_reached', userId: 'user-not-to-print', documentId: DOCUMENT }),
      ).resolves.toBeUndefined();
    } finally {
      database.sql(`ALTER TABLE ${TABLE} DROP CONSTRAINT refuse`);
    }
    expect(stderr.mock.calls).toEqual([
      ['security log: entry not written (rate_limit_reached: PrismaClientKnownRequestError P2039)'],
    ]);
    expect(count()).toBe(0);
  });

  it('neither stores nor prints a kind outside the list', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      securityLog({ kind: 'someone@example.test' as never, userId: 'user-1' }),
    ).resolves.toBeUndefined();
    expect(stderr.mock.calls).toEqual([['security log: entry not written (unknown kind)']]);
    expect(count()).toBe(0);
  });
});

describe('deleteExpiredSecurityLog', () => {
  const now = new Date('2026-03-01T00:00:00.000Z');
  const boundary = new Date(now.getTime() - 30 * DAY_MS);

  it('deletes the entries older than 30 days and keeps the others', async () => {
    insertAt('long-ago', new Date(boundary.getTime() - 300 * DAY_MS));
    insertAt('just-older', new Date(boundary.getTime() - 1));
    insertAt('at-the-boundary', boundary);
    insertAt('younger', new Date(boundary.getTime() + 1));
    insertAt('today', now);

    await expect(deleteExpiredSecurityLog(now)).resolves.toBe(2);
    expect(rows(`SELECT id FROM ${TABLE} ORDER BY id`)).toEqual(['at-the-boundary', 'today', 'younger']);
  });

  // NFR-RE-15: with two instances, the effect once and no error on the second.
  it('is harmless when two instances run it at once', async () => {
    insertAt('old-1', new Date(boundary.getTime() - 1));
    insertAt('old-2', new Date(boundary.getTime() - 2));
    insertAt('old-3', new Date(boundary.getTime() - 3));
    insertAt('kept', now);

    const deleted = await Promise.all([deleteExpiredSecurityLog(now), deleteExpiredSecurityLog(now)]);
    expect(deleted[0] + deleted[1]).toBe(3);
    await expect(deleteExpiredSecurityLog(now)).resolves.toBe(0);
    expect(rows(`SELECT id FROM ${TABLE}`)).toEqual(['kept']);
  });
});

describe('startTimers', () => {
  it('starts one timer however often it is called, which deletes at start and each hour and reports a failure', async () => {
    const stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    insertAt('expired-at-start', new Date('2000-01-01T00:00:00.000Z'));
    insertAt('fresh', new Date());

    startTimers();
    startTimers();

    expect(setInterval).toHaveBeenCalledTimes(1);
    const call = setInterval.mock.calls[0];
    const timer = setInterval.mock.results[0];
    if (!call || !timer) throw new Error('no timer was started');
    expect(call[1]).toBe(DAY_MS / 24);
    // unref: the timer does not keep a stopping process alive.
    expect((timer.value as NodeJS.Timeout).hasRef()).toBe(false);
    await vi.waitFor(() => expect(rows(`SELECT id FROM ${TABLE}`)).toEqual(['fresh']));

    // What the timer runs each hour.
    const tick = call[0] as () => void;
    insertAt('expired-later', new Date('2000-01-01T00:00:00.000Z'));
    tick();
    await vi.waitFor(() => expect(rows(`SELECT id FROM ${TABLE}`)).toEqual(['fresh']));
    // Each run that deleted something says how much.
    await vi.waitFor(() =>
      expect(stdout.mock.calls).toEqual(Array(2).fill(['timer ran: security-log-deletion (1 deleted)'])),
    );

    // A failure is reported with the name of the timer and the class and code
    // of the fault, and rejects nothing: an unhandled rejection would fail this run.
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.sql(`ALTER TABLE ${TABLE} RENAME TO "Elsewhere"`);
    try {
      tick();
      await vi.waitFor(() =>
        expect(stderr.mock.calls).toEqual([
          ['timer failed: security-log-deletion (PrismaClientKnownRequestError P2021)'],
        ]),
      );
    } finally {
      database.sql(`ALTER TABLE "Elsewhere" RENAME TO ${TABLE}`);
    }
  });
});
