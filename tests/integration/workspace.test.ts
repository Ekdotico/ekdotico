// The personal workspace (FR-AU-09; register D61) and the constraints of the
// admission migration, against a provisioned database.
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { createAccount, load, prepare } from './identity.ts';

const database = prepare('workspace');
const { auth, db, valkey } = await load();
const { ensurePersonalWorkspace } = await import('../../src/lib/workspace.ts');

let people = 0;
/** An account made without its workspace, as only a fault could leave one. */
const account = () => createAccount(auth, `person${++people}@example.com`);

afterEach(async () => {
  await db().workspace.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the backstop of FR-AU-09', () => {
  it('creates the personal workspace where it is missing', async () => {
    const userId = await account();
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(0);
    const id = await ensurePersonalWorkspace(userId);
    const workspace = await db().workspace.findUniqueOrThrow({ where: { ownerId: userId } });
    expect(workspace).toMatchObject({ id, type: 'PERSONAL', ownerId: userId });
  });

  it('is idempotent: a second call changes nothing and returns the same workspace', async () => {
    const userId = await account();
    const first = await ensurePersonalWorkspace(userId);
    expect(await ensurePersonalWorkspace(userId)).toBe(first);
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(1);
  });

  it('leaves one workspace where many calls arrive at once, and none fails', async () => {
    const userId = await account();
    const ids = await Promise.all(Array.from({ length: 12 }, () => ensurePersonalWorkspace(userId)));
    expect(new Set(ids).size).toBe(1);
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(1);
  });

  it('gives each account its own', async () => {
    const [one, other] = [await account(), await account()];
    expect(await ensurePersonalWorkspace(one)).not.toBe(await ensurePersonalWorkspace(other));
    expect(await db().workspace.count()).toBe(2);
  });

  it('creates none for an account that does not exist', async () => {
    await expect(ensurePersonalWorkspace('no-such-user')).rejects.toThrow();
    expect(await db().workspace.count()).toBe(0);
  });
});

describe('what the database itself refuses', () => {
  it('a second personal workspace for one account (FR-AU-09)', async () => {
    const userId = await account();
    await ensurePersonalWorkspace(userId);
    await expect(
      db().workspace.create({ data: { type: 'PERSONAL', ownerId: userId } }),
    ).rejects.toMatchObject({
      code: 'P2002',
    });
    expect(await db().workspace.count({ where: { ownerId: userId } })).toBe(1);
  });

  it('a personal workspace without its account', async () => {
    await expect(db().workspace.create({ data: { type: 'PERSONAL' } })).rejects.toThrow();
    expect(await db().workspace.count()).toBe(0);
  });

  it('an address of an account that is not in lower case (FR-AU-02)', async () => {
    await expect(
      db().user.create({ data: { id: 'upper', name: 'A Person', email: 'Upper@example.com' } }),
    ).rejects.toThrow();
    const userId = await account();
    await expect(
      db().user.update({ where: { id: userId }, data: { email: 'Changed@example.com' } }),
    ).rejects.toThrow();
    // The tombstone of a deleted account, which has no address, is still accepted.
    await db().user.update({ where: { id: userId }, data: { email: null, name: null } });
  });

  it('an invited address that is not in lower case', async () => {
    const row = { requestId: 'r', tokenHash: 'h', expiresAt: new Date() };
    await expect(
      db().admissionInvitation.create({ data: { ...row, email: 'Upper@example.com' } }),
    ).rejects.toThrow();
    expect(await db().admissionInvitation.count()).toBe(0);
  });
});
