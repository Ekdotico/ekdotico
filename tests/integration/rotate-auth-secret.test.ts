// scripts/rotate-auth-secret.ts (NFR-SE-17 (a), (e); docs/plan/slice-27.md, S27-6): the second factor is re-sealed from
// the old secret to the new, the sessions end, and a row that opens under neither stops the run with nothing changed.
import { spawnSync } from 'node:child_process';
import { PrismaPg } from '@prisma/adapter-pg';
import { symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { rotate } from '../../scripts/rotate-auth-secret.ts';
import { createDatabase } from './database.ts';

const OLD = 'the-old-secret-of-a-test-with-enough-characters';
const NEW = 'the-new-secret-of-a-test-with-enough-characters';
const database = createDatabase('rotate');
const db = new PrismaClient({
  adapter: new PrismaPg({ connectionString: database.appUrl }, { schema: 'ekdotico' }),
});

const CODES = JSON.stringify(['aaaaa-bbbbb', 'ccccc-ddddd']);

beforeAll(async () => {
  for (const id of ['u1', 'u2']) {
    await db.user.create({ data: { id, email: `${id}@example.com`, name: 'A Person' } });
    await db.twoFactor.create({
      data: {
        id: `f-${id}`,
        userId: id,
        secret: await symmetricEncrypt({ key: OLD, data: `secret-of-${id}` }),
        backupCodes: await symmetricEncrypt({ key: OLD, data: CODES }),
        verified: true,
      },
    });
    await db.session.create({
      data: { id: `s-${id}`, userId: id, token: `t-${id}`, expiresAt: new Date(Date.now() + 1e6) },
    });
  }
});
afterAll(async () => {
  await db.$disconnect();
  database.drop();
});

const open = async (key: string, id: string) => {
  const row = await db.twoFactor.findUniqueOrThrow({ where: { id } });
  return {
    secret: await symmetricDecrypt({ key, data: row.secret }).catch(() => null),
    codes: await symmetricDecrypt({ key, data: row.backupCodes }).catch(() => null),
  };
};

describe('the rotation of AUTH_SECRET', () => {
  it('counts and changes nothing without --apply', async () => {
    expect(await rotate(db, OLD, NEW, false)).toEqual({
      rows: 2,
      resealed: 2,
      alreadyNew: 0,
      sessionsEnded: 2,
    });
    expect(await open(OLD, 'f-u1')).toEqual({ secret: 'secret-of-u1', codes: CODES });
    expect(await db.session.count()).toBe(2);
  });

  it('stops with nothing changed when a row opens under neither secret', async () => {
    await db.user.create({ data: { id: 'u3', email: 'u3@example.com', name: 'A Person' } });
    await db.twoFactor.create({
      data: { id: 'f-bad', userId: 'u3', secret: 'zz', backupCodes: 'zz', verified: true },
    });
    await expect(rotate(db, OLD, NEW, true)).rejects.toThrow(
      /opens under neither secret; nothing was changed/,
    );
    expect(await open(OLD, 'f-u1')).toEqual({ secret: 'secret-of-u1', codes: CODES });
    expect(await open(NEW, 'f-u1')).toEqual({ secret: null, codes: null });
    expect(await db.session.count()).toBe(2);
    await db.twoFactor.delete({ where: { id: 'f-bad' } });
  });

  it('re-seals every row, ends every session, and a second run changes nothing twice', async () => {
    expect(await rotate(db, OLD, NEW, true)).toEqual({
      rows: 2,
      resealed: 2,
      alreadyNew: 0,
      sessionsEnded: 2,
    });
    for (const id of ['f-u1', 'f-u2']) {
      expect(await open(NEW, id)).toEqual({ secret: `secret-of-${id.slice(2)}`, codes: CODES });
      expect(await open(OLD, id)).toEqual({ secret: null, codes: null });
    }
    expect(await db.session.count()).toBe(0);
    expect(await rotate(db, OLD, NEW, true)).toEqual({
      rows: 2,
      resealed: 0,
      alreadyNew: 2,
      sessionsEnded: 0,
    });
  });

  it('refuses two equal secrets and a short one', async () => {
    await expect(rotate(db, OLD, OLD, true)).rejects.toThrow(/same/);
    await expect(rotate(db, OLD, 'short', true)).rejects.toThrow(/under 32/);
  });

  it('as a command prints counts and no secret', () => {
    const ran = spawnSync('node', ['scripts/rotate-auth-secret.ts'], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        OLD_AUTH_SECRET: NEW,
        NEW_AUTH_SECRET: `${NEW}-next-one-again`,
        DATABASE_URL: database.appUrl,
      },
      encoding: 'utf8',
    });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe(
      'rotate: dry run, nothing changed: 2 second factors, 2 re-sealed, 0 already under the new secret, 0 sessions ended\n',
    );
    expect(ran.stdout + ran.stderr).not.toContain(NEW);
    const refused = spawnSync('node', ['scripts/rotate-auth-secret.ts'], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH! },
      encoding: 'utf8',
    });
    expect(refused.status).toBe(2);
  });

  it('says a fault by its class and not by its message: a connection that fails names no host and no role', () => {
    const wrong = new URL(database.appUrl);
    wrong.username = 'ekdotico_no_such_role';
    wrong.password = 'a-wrong-password-of-a-test';
    const failed = spawnSync('node', ['scripts/rotate-auth-secret.ts'], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        OLD_AUTH_SECRET: NEW,
        NEW_AUTH_SECRET: `${NEW}-another-one`,
        DATABASE_URL: wrong.toString(),
      },
      encoding: 'utf8',
    });
    expect(failed.status).toBe(1);
    // A class, and a code where there is one; not the empty "failed ()" of a message that was empty.
    expect(failed.stderr).toMatch(/rotate: failed \([A-Za-z]\S*[^)]*\)\n$/);
    for (const leak of [wrong.hostname, wrong.username, wrong.password, 'password authentication']) {
      expect(failed.stdout + failed.stderr, leak).not.toContain(leak);
    }
  });
});
