// The deletion of an account (FR-AU-58; NFR-DP-06, NFR-DP-09, NFR-RE-15, NFR-SE-19;
// register D28, D72, D112, D215, D217; docs/plan/slice-22.md): the route as Next.js
// calls it, the steps as the timer carries them out, against a provisioned database and
// the real Valkey, whose channel (FR-ED-40) a listener of the test hears. Each test of a
// rule names the weakening that makes it fail (the mutations of the pull request).
//
// What an open connection does when the record is made is in
// collab-account-deletion.test.ts.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { listen, until } from './channel.ts';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import { enrol, nextCode, passwordStep, secondStep } from './second-factor.ts';
import type { ErasureOutcome, ErasureRequest, IstoricoPort, Result } from '../../src/lib/istorico/index.ts';

// `after` of Next.js exists only inside a request of the framework: what a route leaves for after its
// response is collected here and run by the test when it wants it, so that "after" can be told from "before".
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const MAIL = join(tmpdir(), `ekdotico-deletion-mail-${randomUUID()}`);
// Not the initial value: the fourth wrong password in an hour is "the twentieth" that locks an account,
// and the count for one network address is out of the way (as tests/integration/sign-in-lock.test.ts has it).
const MOST = 4;
const database = prepare('accountdeletion', {
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: MAIL,
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: `${MOST}/3600`,
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: '500/900',
});
const { auth, db, valkey, validateSession, validateSessionRow } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { deleteDocument } = await import('../../src/lib/documents/deletion.ts');
const { answerOffer } = await import('../../src/lib/documents/ownership.ts');
const { listNotifications, INVITATION_NOTIFICATION } = await import('../../src/lib/documents/sharing.ts');
const { ensurePersonalWorkspace } = await import('../../src/lib/workspace.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { confirmDeletion, ownedDocuments } = await import('../../src/lib/account/deletion.ts');
const { CLAIM_STALE_MS, carryOutDeletions, oneMonthAfter } =
  await import('../../src/lib/account/deletion-steps.ts');
const { AccountInDeletion, holdOwnableAccount } = await import('../../src/lib/account/in-deletion.ts');
const { SIGN_IN_REFUSED, failedSignInsReached } = await import('../../src/lib/auth/sign-in.ts');
const { RESET_LINK } = await import('../../src/lib/token.ts');
const { beginLock } = await import('../../src/lib/auth/sign-in-lock.ts');
const { noopAdapter } = await import('../../src/lib/istorico/port.ts');
const route = await import('../../src/app/api/account/route.ts');
const collection = await import('../../src/app/api/documents/route.ts');

const channel = await listen();
const DAY = 24 * 60 * 60 * 1000;
const WRONG = 'a wrong password, long enough';
const NOT_ASKED = { password: PASSWORD } as const;

afterAll(async () => {
  channel.stop();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(async () => {
  later.length = 0;
  // A run of the steps carries out every deletion that is open, as the timer does, so a deletion that
  // an earlier test recorded and left open is not another test’s to complete.
  await db().accountDeletion.deleteMany({ where: { completedAt: null } });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FEEDBACK_INTAKE_ENABLED;
  later.length = 0;
});

// ── Requests ────────────────────────────────────────────────────────────────

let addresses = 0;
/** A network address no earlier request came from, so that no count of one address gets in the way. */
const net = () => ({ 'x-forwarded-for': `10.30.${Math.floor(++addresses / 250)}.${addresses % 250}` });

function remove(cookie: string, body?: unknown, headers: Record<string, string> = {}) {
  return route.DELETE(
    new Request(`${ORIGIN}/api/account`, {
      method: 'DELETE',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        cookie,
        ...net(),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}
const read = (cookie: string, path = '/api/documents') =>
  collection.GET(new Request(`${ORIGIN}${path}`, { headers: { cookie, ...net() } }));

// The body of a response, read once and kept, so that a test may ask for it more than once.
type Body = { error: { code: string; message: string }; documents?: number };
const parsed = new WeakMap<Response, Promise<Body>>();
const json = (response: Response): Promise<Body> => {
  if (!parsed.has(response)) parsed.set(response, response.json() as Promise<Body>);
  return parsed.get(response)!;
};
const code = async (response: Response) => (await json(response)).error.code as string;
const message = async (response: Response) => (await json(response)).error.message as string;

/** Runs what the routes left for after their responses. */
async function afterResponses() {
  for (const task of later.splice(0)) await task();
}

// ── Accounts and what they hold ─────────────────────────────────────────────

let count = 0;
async function person(name = 'A Person') {
  const email = `deleting${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email, PASSWORD, net())) };
}

/** An account with two-factor authentication on, its secret and its recovery codes. */
async function enrolled() {
  const who = await person();
  return { ...who, ...(await enrol(auth, who.cookie, net())) };
}

const recordOf = (userId: string) => db().accountDeletion.findUnique({ where: { userId } });
const held = async () => 'held' as const;
/** The record, made as the route makes it but for the prompt, which the tests of the route cover. */
const confirm = (userId: string) => confirmDeletion(userId, held);
const entries = async (userId: string) =>
  (await db().securityLogEntry.findMany({ where: { userId }, orderBy: [{ createdAt: 'asc' }] })).map(
    ({ kind }) => kind,
  );
const stepsOf = (kinds: string[]) => kinds.filter((kind) => kind.startsWith('account_deletion_'));

const grant = (documentId: string, who: { id: string }, role: 'EDITOR' | 'VIEWER' = 'EDITOR') =>
  db().documentCollaborator.create({ data: { documentId, userId: who.id, role } });

/** An adapter that reports the erasure capability, as the one that links Istorico will (IC-14). */
const erasing = (erase: (input: ErasureRequest) => Promise<Result<ErasureOutcome[]>>): IstoricoPort => ({
  capabilities: () => ({ ...noopAdapter.capabilities(), adapter: 'istorico', erasure: true }),
  registerDocument: noopAdapter.registerDocument,
  erase,
});
const answering =
  (outcome: ErasureOutcome['outcome']) =>
  async (input: ErasureRequest): Promise<Result<ErasureOutcome[]>> => ({
    ok: true,
    value: input.documents.map(({ documentId }) => ({ documentId, outcome })),
  });

/** An Owner, and a document of theirs that is recorded, held by the account as an Editor. */
async function recordedDocumentOf(who: { id: string }) {
  const owner = await person('Ada Owner');
  const id = (await createDocument(owner.id)).id;
  await db().document.update({ where: { id }, data: { recording: 'RECORDED' } });
  await grant(id, who);
  return { owner, id };
}

/**
 * Holds something in a transaction of the test while `during` runs, as a request that is on its way
 * would, and returns what `during` answered once the transaction has committed. `during` is started
 * after the hold is taken, and the transaction is released only when the database says a statement of
 * this database is waiting on a lock: so what `during` does is shown to wait for what is held.
 */
async function whileHolding<T>(
  hold: (tx: Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0]) => Promise<void>,
  during: () => Promise<T>,
): Promise<T> {
  let locked!: () => void;
  let release!: () => void;
  const holds = new Promise<void>((resolve) => (locked = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const transaction = db().$transaction(
    async (tx) => {
      await hold(tx);
      locked();
      await gate;
    },
    { timeout: 30_000 },
  );
  await holds;
  const pending = during();
  // Attached now, so that an answer that comes before the release is not an unhandled rejection.
  pending.catch(() => {});
  try {
    await until(() =>
      /(^|\n)[1-9]\d*$/.test(
        database.sql(
          `SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`,
        ),
      ),
    );
  } finally {
    // Released whatever was found, so that a request that did not wait does not leave the hold standing.
    release();
  }
  await transaction;
  return pending;
}

/** What the confirmation does first, left open: the account's row held for update, and the record written. */
async function confirmationInFlight(
  tx: Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0],
  userId: string,
) {
  await tx.$queryRaw`SELECT "id" FROM "ekdotico"."User" WHERE "id" = ${userId} FOR UPDATE`;
  await tx.accountDeletion.create({ data: { userId } });
}

// ── The refusal while documents are owned ───────────────────────────────────

describe('the refusal while the account owns a document (FR-AU-58)', () => {
  it('answers 409 with the number, before the password is asked for, and records nothing', async () => {
    const who = await person();
    await createDocument(who.id);
    // A wrong password: were it asked first, this would be a 403 and a failed sign-in.
    const wrong = await remove(who.cookie, { password: WRONG });
    expect(wrong.status).toBe(409);
    expect(await json(wrong)).toMatchObject({ error: { code: 'owns_documents' }, documents: 1 });
    expect(await message(wrong)).toBe(
      'This account owns 1 document, so it cannot be deleted. Clear or transfer it first. The account was not deleted.',
    );
    expect(await recordOf(who.id)).toBeNull();
    expect(await db().securityLogEntry.count({ where: { userId: who.id, kind: 'forbidden' } })).toBe(0);
    // And the right one changes nothing.
    const right = await remove(who.cookie, NOT_ASKED);
    expect(right.status).toBe(409);
    expect(await recordOf(who.id)).toBeNull();
    // The session stands: the refusal is not a sign-out.
    expect((await validateSessionRow(new Headers({ cookie: who.cookie }))).session).not.toBeNull();
  });

  it('counts every document owned, a deleted one within its retention included', async () => {
    const who = await person();
    const live = await createDocument(who.id);
    const trashed = await createDocument(who.id);
    await createDocument(who.id);
    expect(await deleteDocument(trashed, who.id)).toBe(true);
    const refused = await remove(who.cookie, NOT_ASKED);
    expect(refused.status).toBe(409);
    expect((await json(refused)).documents).toBe(3);
    expect(await message(refused)).toContain('owns 3 documents');
    expect(await ownedDocuments(who.id)).toEqual({ owned: 3, deleted: 1 });
    // The deleted one alone still refuses.
    await db().document.deleteMany({ where: { id: live.id } });
    await db().document.deleteMany({ where: { ownerId: who.id, deletedAt: null } });
    expect(await ownedDocuments(who.id)).toEqual({ owned: 1, deleted: 1 });
    expect((await remove(who.cookie, NOT_ASKED)).status).toBe(409);
    expect(await recordOf(who.id)).toBeNull();
  });

  it('counts a document claimed for its permanent deletion, which is a row until it is deleted', async () => {
    const who = await person();
    const { id } = await createDocument(who.id);
    await db().document.update({
      where: { id },
      data: { deletedAt: new Date(Date.now() - 40 * DAY), deletionClaimedAt: new Date() },
    });
    expect((await remove(who.cookie, NOT_ASKED)).status).toBe(409);
    expect(await recordOf(who.id)).toBeNull();
  });

  it('does not count a document the account holds a role on and does not own', async () => {
    const who = await person();
    const owner = await person();
    const { id } = await createDocument(owner.id);
    await grant(id, who);
    // A wrong password: what is reached is the prompt, and not the refusal.
    const reached = await remove(who.cookie, { password: WRONG });
    expect(reached.status).toBe(403);
  });

  it('is made again under the account’s row, by the function that records, and not only by the route', async () => {
    const who = await person();
    await createDocument(who.id);
    expect(await confirm(who.id)).toEqual({ outcome: 'owns_documents', documents: 1 });
    expect(await recordOf(who.id)).toBeNull();
    expect(await channel.sessionsEnded(who.id)).toHaveLength(0);
    // A deleted document within its retention counts here too, and a document claimed for its permanent deletion.
    const trashed = await person();
    const { id } = await createDocument(trashed.id);
    await deleteDocument({ id }, trashed.id);
    expect(await confirm(trashed.id)).toEqual({ outcome: 'owns_documents', documents: 1 });
    await db().document.update({ where: { id }, data: { deletionClaimedAt: new Date() } });
    expect(await confirm(trashed.id)).toEqual({ outcome: 'owns_documents', documents: 1 });
    expect(await recordOf(trashed.id)).toBeNull();
  });

  it('is not undone by a refusal: a refused attempt leaves no record from which a month would run (NFR-DP-06)', async () => {
    const who = await person();
    await createDocument(who.id);
    await remove(who.cookie, NOT_ASKED);
    await remove(who.cookie, NOT_ASKED);
    expect(await db().accountDeletion.count({ where: { userId: who.id } })).toBe(0);
  });
});

// ── The prompt ──────────────────────────────────────────────────────────────

describe('the password and the code, immediately before the action (FR-AU-58; Q10)', () => {
  it('refuses a wrong password with the statement of FR-AU-81, records nothing, and logs a 403', async () => {
    const who = await person();
    const refused = await remove(who.cookie, { password: WRONG });
    expect(refused.status).toBe(403);
    expect(await code(refused)).toBe('password_refused');
    expect(await message(refused)).toBe(SIGN_IN_REFUSED);
    expect(await recordOf(who.id)).toBeNull();
    expect(await db().securityLogEntry.count({ where: { userId: who.id, kind: 'forbidden' } })).toBe(1);
    expect((await validateSessionRow(new Headers({ cookie: who.cookie }))).session).not.toBeNull();
  });

  it('counts a wrong password as a failed sign-in: the limit locks the account, and a locked, signed-in user stays signed in', async () => {
    const who = await person();
    for (let attempt = 0; attempt < MOST; attempt += 1) {
      expect((await remove(who.cookie, { password: WRONG })).status).toBe(403);
    }
    await afterResponses();
    expect((await db().user.findUniqueOrThrow({ where: { id: who.id } })).lockedUntil).not.toBeNull();
    // The right password, while it is locked: the same statement, nothing recorded, and the session stands.
    const locked = await remove(who.cookie, NOT_ASKED);
    expect(locked.status).toBe(403);
    expect(await message(locked)).toBe(SIGN_IN_REFUSED);
    expect(await recordOf(who.id)).toBeNull();
    expect((await validateSessionRow(new Headers({ cookie: who.cookie }))).session).not.toBeNull();
  });

  it('refuses a request that holds anything but the password, or a body that is not JSON, or no session, or another origin', async () => {
    const who = await person();
    for (const body of [{}, { password: PASSWORD, extra: 1 }, { password: 7 }, { code: '123456' }, []]) {
      const refused = await remove(who.cookie, body);
      expect(refused.status).toBe(422);
      expect(await message(refused)).toBe(
        'The request must hold the current password, and nothing else. The account was not deleted.',
      );
    }
    // No body at all is a body that holds nothing.
    expect((await remove(who.cookie)).status).toBe(422);
    const text = await route.DELETE(
      new Request(`${ORIGIN}/api/account`, {
        method: 'DELETE',
        headers: { origin: ORIGIN, 'content-type': 'text/plain', cookie: who.cookie, ...net() },
        body: JSON.stringify(NOT_ASKED),
      }),
    );
    expect(text.status).toBe(415);
    expect((await remove('', NOT_ASKED)).status).toBe(401);
    // Authorisation before validation: another origin is a 403 whatever the body, and nothing of it is read.
    const foreign = await remove(who.cookie, NOT_ASKED, { origin: 'https://other.example' });
    expect(foreign.status).toBe(403);
    expect(await recordOf(who.id)).toBeNull();
  });

  it('asks for a code where two-factor authentication is on: none, a wrong one, and a right one', async () => {
    const who = await enrolled();
    const none = await remove(who.cookie, NOT_ASKED);
    expect(none.status).toBe(422);
    expect(await message(none)).toBe(
      'The request must hold the current password and a code, and nothing else. The account was not deleted.',
    );
    const wrong = await remove(who.cookie, { password: PASSWORD, code: '000000' });
    expect(wrong.status).toBe(403);
    expect(await code(wrong)).toBe('code_refused');
    expect(await recordOf(who.id)).toBeNull();
    const right = await remove(who.cookie, { password: PASSWORD, code: nextCode(who.secret) });
    expect(right.status).toBe(200);
    expect(await recordOf(who.id)).not.toBeNull();
  });

  it('accepts a recovery code in place of the code of the authenticator, and a right code does not excuse a wrong password', async () => {
    const who = await enrolled();
    const password = await remove(who.cookie, { password: WRONG, code: nextCode(who.secret) });
    expect(password.status).toBe(403);
    expect(await code(password)).toBe('password_refused');
    expect(await recordOf(who.id)).toBeNull();
    const recovery = await remove(who.cookie, { password: PASSWORD, code: who.recoveryCodes[0] });
    expect(recovery.status).toBe(200);
    expect(await recordOf(who.id)).not.toBeNull();
  });

  it('refuses a code from an account that has none turned on: the body of such an account is the password alone', async () => {
    const who = await person();
    const refused = await remove(who.cookie, { password: PASSWORD, code: '123456' });
    expect(refused.status).toBe(422);
    expect(await recordOf(who.id)).toBeNull();
  });

  it('asks again, inside the record, whether the password is still the one verified (a reset in between)', async () => {
    const who = await person();
    const response = await whileHolding(
      async (tx) => {
        await tx.account.updateMany({ where: { userId: who.id }, data: { password: 'set meanwhile' } });
      },
      () => remove(who.cookie, NOT_ASKED),
    );
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('password_refused');
    expect(await recordOf(who.id)).toBeNull();
  });

  it('asks again, inside the record, whether the session still stands (ended in between)', async () => {
    const who = await person();
    const response = await whileHolding(
      async (tx) => {
        await tx.session.deleteMany({ where: { userId: who.id } });
      },
      () => remove(who.cookie, NOT_ASKED),
    );
    expect(response.status).toBe(401);
    expect(await recordOf(who.id)).toBeNull();
  });
});

// ── The record, and what it stops (a) ───────────────────────────────────────

describe('the record of the confirmation, and step (a) (FR-AU-58, FR-ED-40 (d))', () => {
  it('answers 200 and records the deletion, with the entry of step (a), and tells the collaboration servers once', async () => {
    const who = await person();
    const answered = await remove(who.cookie, NOT_ASKED);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toEqual({});
    expect(answered.headers.get('cache-control')).toBe('no-store');
    const record = await recordOf(who.id);
    expect(record).toMatchObject({ completedAt: null, istoricoDoneAt: null, credentialsDoneAt: null });
    expect(stepsOf(await entries(who.id))).toEqual(['account_deletion_connections_closed']);
    await until(() => channel.sessionsEnded(who.id).length === 1);
    // The steps are left for after the response: none has begun.
    expect(later).toHaveLength(1);
    expect(await db().session.count({ where: { userId: who.id } })).toBeGreaterThan(0);
  });

  it('records one deletion for two confirmations at once, and the second is told the same', async () => {
    const who = await person();
    const [first, second] = await Promise.all([confirm(who.id), confirm(who.id)]);
    expect([first.outcome, second.outcome].sort()).toEqual(['already_confirmed', 'confirmed']);
    expect(await db().accountDeletion.count({ where: { userId: who.id } })).toBe(1);
    expect(stepsOf(await entries(who.id))).toEqual(['account_deletion_connections_closed']);
    expect(await channel.sessionsEnded(who.id)).toHaveLength(1);
  });

  it('leaves the account no session from the commit: the signed copy, the routes and the creation of a document all answer none', async () => {
    const who = await person();
    // Read once, so that the library has a copy in hand that is up to a minute old.
    expect((await read(who.cookie)).status).toBe(200);
    expect((await confirm(who.id)).outcome).toBe('confirmed');
    for (const reading of [
      await validateSession('GET', new Headers({ cookie: who.cookie })),
      await validateSessionRow(new Headers({ cookie: who.cookie })),
    ]) {
      expect(reading.session).toBeNull();
      expect(reading.stopped).toBeNull();
      expect(reading.setCookie).toEqual([]);
    }
    const listed = await read(who.cookie);
    expect(listed.status).toBe(401);
    const created = await collection.POST(
      new Request(`${ORIGIN}/api/documents`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: who.cookie, ...net() },
        body: '{}',
      }),
    );
    expect(created.status).toBe(401);
    expect(await db().document.count({ where: { ownerId: who.id } })).toBe(0);
    // And a second request to delete is a request of no one.
    expect((await remove(who.cookie, NOT_ASKED)).status).toBe(401);
  });

  it('refuses a sign-in with the right password as a lock does: the statement of FR-AU-81, the same answer, counted toward nothing', async () => {
    const who = await person();
    const other = await person();
    await confirm(who.id);
    const sessions = await db().session.count({ where: { userId: who.id } });
    const refused = await signIn(auth, who.email, PASSWORD, net());
    const ordinary = await signIn(auth, other.email, WRONG, net());
    expect(refused.status).toBe(ordinary.status);
    expect(await json(refused)).toEqual(await json(ordinary));
    expect(await message(refused)).toBe(SIGN_IN_REFUSED);
    // Many more than the limit: none is counted (a refused attempt counts toward nothing) and none locks.
    for (let attempt = 0; attempt < MOST + 3; attempt += 1) {
      expect((await signIn(auth, who.email, PASSWORD, net())).status).toBe(401);
    }
    expect(await failedSignInsReached(who.email)).toBe(false);
    await afterResponses();
    expect((await db().user.findUniqueOrThrow({ where: { id: who.id } })).lockedUntil).toBeNull();
    // No session was made, and the entries of refusals name the user.
    expect(await db().session.count({ where: { userId: who.id } })).toBe(sessions);
    expect(await db().securityLogEntry.count({ where: { userId: who.id, kind: 'sign_in_refused' } })).toBe(
      MOST + 4,
    );
  });

  it('refuses a second step that a password began before, and leaves no session', async () => {
    const who = await enrolled();
    const step = await passwordStep(auth, who.email, net());
    const sessions = await db().session.count({ where: { userId: who.id } });
    await confirm(who.id);
    const refused = await secondStep(auth, step, nextCode(who.secret));
    expect(refused.status).toBe(401);
    expect(await code(refused)).toBe('sign_in_again');
    expect(await db().session.count({ where: { userId: who.id } })).toBe(sessions);
  });

  it('refuses the sign-in link of a lock email, and a request for a reset sends no link and no mail', async () => {
    const who = await person();
    await beginLock(who.email);
    const lock = (await sunk(MAIL)).find(
      ({ to, subject }) => to === who.email && subject?.includes('is locked for 1 hour'),
    );
    const token = /\/sign-in\/link\/([A-Za-z0-9_-]+)/.exec(lock?.text ?? '')?.[1];
    expect(token).toBeTruthy();
    await confirm(who.id);
    const sessions = await db().session.count({ where: { userId: who.id } });
    const link = await post(auth, '/sign-in/link', { token }, net());
    expect(link.response.status).toBe(409);
    expect(await db().session.count({ where: { userId: who.id } })).toBe(sessions);

    const before = (await sunk(MAIL)).length;
    const reset = await post(auth, '/request-password-reset', { email: who.email }, net());
    expect(reset.response.status).toBe(200);
    await reset.after();
    expect((await sunk(MAIL)).length).toBe(before);
    expect(
      await db().verification.count({ where: { identifier: { startsWith: RESET_LINK }, value: who.id } }),
    ).toBe(0);
  });
});

// ── The race: no deleted account is ever the Owner of a document ────────────

describe('no deleted account is ever the Owner of a document (FR-AU-58)', () => {
  it('a creation in flight is counted by the confirmation that waits for it', async () => {
    const who = await person();
    const workspaceId = await ensurePersonalWorkspace(who.id);
    const outcome = await whileHolding(
      async (tx) => {
        // What `createDocument` does, left open: the account held for sharing, and the document written.
        expect(await holdOwnableAccount(tx, who.id)).toBe(true);
        await tx.document.create({
          data: {
            workspaceId,
            ownerId: who.id,
            permissionSet: defaultPermissionSet(),
            recording: 'UNRECORDED',
            updatedAt: new Date(),
          },
        });
      },
      () => confirm(who.id),
    );
    expect(outcome).toEqual({ outcome: 'owns_documents', documents: 1 });
    expect(await recordOf(who.id)).toBeNull();
  });

  it('a confirmation in flight is found by the creation that waits for it, and no document is made', async () => {
    const who = await person();
    await expect(
      whileHolding(
        (tx) => confirmationInFlight(tx, who.id),
        () => createDocument(who.id),
      ),
    ).rejects.toBeInstanceOf(AccountInDeletion);
    expect(await db().document.count({ where: { ownerId: who.id } })).toBe(0);
  });

  it('a confirmation in flight is found by the acceptance of an offer, which does not make the account an Owner', async () => {
    const owner = await person('Ada Owner');
    const editor = await person('Ben Editor');
    const { id } = await createDocument(owner.id);
    await grant(id, editor);
    const offer = await db().ownershipOffer.create({
      data: {
        documentId: id,
        fromUserId: owner.id,
        toUserId: editor.id,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    const outcome = await whileHolding(
      (tx) => confirmationInFlight(tx, editor.id),
      () => answerOffer(editor.id, offer.id, 'accept'),
    );
    expect(outcome).toEqual({ outcome: 'no_longer_open' });
    expect((await db().document.findUniqueOrThrow({ where: { id } })).ownerId).toBe(owner.id);
    expect((await db().ownershipOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe('PENDING');
  });
});

// ── The steps ───────────────────────────────────────────────────────────────

describe('the steps, in order, each repeated until it succeeds (FR-AU-58; NFR-RE-15)', () => {
  it('carries out (b), (c), (d), (e) and (f) in order, one entry each, and completes', async () => {
    const who = await person();
    await signIn(auth, who.email, PASSWORD, net());
    await confirm(who.id);
    const outcome = await carryOutDeletions();
    expect(outcome).toMatchObject({ steps: 4, completed: 1, failed: 0, overdue: 0 });
    const record = (await recordOf(who.id))!;
    const times = [
      record.requestedAt,
      record.istoricoDoneAt,
      record.feedbackSkippedAt,
      record.credentialsDoneAt,
      record.rowsDoneAt,
      record.completedAt,
    ];
    expect(times.every((time) => time !== null)).toBe(true);
    const sorted = [...times].sort((a, b) => a!.getTime() - b!.getTime());
    expect(times).toEqual(sorted);
    expect(record.feedbackDoneAt).toBeNull();
    expect(record.claimedAt).toBeNull();
    const kinds = stepsOf(await entries(who.id));
    expect(kinds.slice(0, 4)).toEqual([
      'account_deletion_connections_closed',
      'account_deletion_istorico_pseudonymised',
      'account_deletion_feedback_skipped',
      'account_deletion_credentials_deleted',
    ]);
    expect(kinds.slice(4).sort()).toEqual([
      'account_deletion_roles_ended',
      'account_deletion_user_pseudonymised',
    ]);
    // Run again: nothing is open.
    expect(await carryOutDeletions()).toMatchObject({ steps: 0, completed: 0, failed: 0 });
  });

  it('is begun by the route after its response, and by nothing else', async () => {
    const who = await person();
    expect((await remove(who.cookie, NOT_ASKED)).status).toBe(200);
    expect((await recordOf(who.id))!.completedAt).toBeNull();
    await afterResponses();
    expect((await recordOf(who.id))!.completedAt).not.toBeNull();
  });

  it('stops at a step that fails, records what was done before it, and resumes at that step', async () => {
    const who = await person();
    await recordedDocumentOf(who);
    await confirm(who.id);
    const requests: string[] = [];
    const down = erasing(async (input) => {
      requests.push(input.requestId);
      return { ok: false, error: 'unavailable', retryable: true };
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failed = await carryOutDeletions(new Date(), { port: down });
    expect(failed).toMatchObject({ steps: 0, completed: 0, failed: 1 });
    expect(error).toHaveBeenCalledWith(
      expect.stringMatching(/^account deletion \S+: step istorico not done \(Error\)$/),
    );
    let record = (await recordOf(who.id))!;
    expect(record).toMatchObject({
      istoricoDoneAt: null,
      feedbackSkippedAt: null,
      credentialsDoneAt: null,
      rowsDoneAt: null,
      completedAt: null,
      claimedAt: null,
    });
    // Nothing after it ran: the sessions and the credentials are there, and the row is whole.
    expect(await db().session.count({ where: { userId: who.id } })).toBeGreaterThan(0);
    expect(await db().account.count({ where: { userId: who.id } })).toBe(1);
    expect((await db().user.findUniqueOrThrow({ where: { id: who.id } })).email).toBe(who.email);

    const ok = erasing(async (input) => {
      requests.push(input.requestId);
      return answering('pseudonymised')(input);
    });
    expect(await carryOutDeletions(new Date(), { port: ok })).toMatchObject({ steps: 4, completed: 1 });
    record = (await recordOf(who.id))!;
    expect(record.completedAt).not.toBeNull();
    // The same request on every attempt, the record's own (IC-11).
    expect(new Set(requests)).toEqual(new Set([record.id]));
    expect(requests).toHaveLength(2);
  });

  it('is held to its order by the database: a step’s time is refused where the step before it has none', async () => {
    const who = await person();
    await confirm(who.id);
    const update = (set: string) =>
      database.sql(`UPDATE "AccountDeletion" SET ${set} WHERE "userId" = '${who.id}'`);
    expect(() => update(`"feedbackSkippedAt" = now()`)).toThrow(/AccountDeletion_feedback_after_istorico/);
    expect(() => update(`"feedbackDoneAt" = now()`)).toThrow(/AccountDeletion_feedback_after_istorico/);
    expect(() => update(`"credentialsDoneAt" = now()`)).toThrow(/AccountDeletion_credentials_after_feedback/);
    expect(() => update(`"rowsDoneAt" = now()`)).toThrow(/AccountDeletion_rows_after_credentials/);
    expect(() => update(`"completedAt" = now()`)).toThrow(/AccountDeletion_completed_after_rows/);
    expect(() =>
      update(`"istoricoDoneAt" = now(), "feedbackDoneAt" = now(), "feedbackSkippedAt" = now()`),
    ).toThrow(/AccountDeletion_feedback_once/);
    // In order, they are accepted.
    update(`"istoricoDoneAt" = now()`);
    update(`"feedbackSkippedAt" = now()`);
    update(`"credentialsDoneAt" = now()`);
    update(`"rowsDoneAt" = now()`);
    update(`"completedAt" = now()`);
  });

  it('is taken by one run when two reach it together: the other does nothing and says nothing', async () => {
    const who = await person();
    await confirm(who.id);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const [one, two] = await Promise.all([carryOutDeletions(), carryOutDeletions()]);
    expect(one.steps + two.steps).toBe(4);
    expect(one.completed + two.completed).toBe(1);
    expect(one.failed + two.failed).toBe(0);
    expect(error).not.toHaveBeenCalled();
    const kinds = stepsOf(await entries(who.id));
    expect(kinds).toHaveLength(6);
  });

  it('writes nothing under a claim that was taken over, and a claim an hour old is taken over', async () => {
    const who = await person();
    await recordedDocumentOf(who);
    await confirm(who.id);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = erasing(async (input) => {
      await gate;
      return answering('pseudonymised')(input);
    });
    const first = carryOutDeletions(new Date(), { port: slow });
    await until(async () => (await recordOf(who.id))?.claimedAt);
    // Another instance took the claim over while this run was in the call.
    await db().accountDeletion.update({
      where: { userId: who.id },
      data: { claimedAt: new Date(Date.now() + 5000) },
    });
    release();
    const lost = await first;
    expect(lost).toMatchObject({ steps: 0, completed: 0 });
    const record = (await recordOf(who.id))!;
    expect(record.istoricoDoneAt).toBeNull();
    expect(stepsOf(await entries(who.id))).toEqual(['account_deletion_connections_closed']);
    // A claim made now is another's, and is left alone; one an hour old was not finished.
    expect(await carryOutDeletions()).toMatchObject({ steps: 0, completed: 0 });
    await db().accountDeletion.update({
      where: { userId: who.id },
      data: { claimedAt: new Date(Date.now() - CLAIM_STALE_MS - 60_000) },
    });
    expect(await carryOutDeletions()).toMatchObject({ steps: 4, completed: 1 });
  });

  // A fault in the middle of a step, put there in the database: a trigger that refuses the deletion of a row of the account.
  const breakDeleting = (table: string, userId: string) =>
    database.sql(
      `CREATE FUNCTION break_it() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD."userId" = '${userId}' THEN RAISE EXCEPTION 'a fault'; END IF; RETURN OLD; END $$; CREATE TRIGGER break_it BEFORE DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION break_it()`,
    );
  const mend = (table: string) =>
    database.sql(`DROP TRIGGER break_it ON "${table}"; DROP FUNCTION break_it()`);

  it('records nothing of a step that fails in the middle: its work goes with it, no entry is left, and it is owed', async () => {
    const who = await person();
    await confirm(who.id);
    // The credential is deleted before the sessions, so the fault comes after some of the work of (d).
    breakDeleting('Session', who.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await carryOutDeletions()).toMatchObject({ steps: 2, completed: 0, failed: 1 });
      const record = (await recordOf(who.id))!;
      expect(record.istoricoDoneAt).not.toBeNull();
      expect(record.feedbackSkippedAt).not.toBeNull();
      expect(record.credentialsDoneAt).toBeNull();
      expect(await db().account.count({ where: { userId: who.id } })).toBe(1);
      expect(await db().session.count({ where: { userId: who.id } })).toBeGreaterThan(0);
      expect(stepsOf(await entries(who.id))).not.toContain('account_deletion_credentials_deleted');
    } finally {
      mend('Session');
    }
    expect(await carryOutDeletions()).toMatchObject({ steps: 2, completed: 1, failed: 0 });
  });

  it('does the same for (e) and (f), which are one step: a fault at the roles leaves the offers, the invitations and the row as they were', async () => {
    const who = await person();
    const { id } = await recordedDocumentOf(who);
    const offered = await db().ownershipOffer.create({
      data: {
        documentId: id,
        fromUserId: (await db().document.findUniqueOrThrow({ where: { id } })).ownerId,
        toUserId: who.id,
        expiresAt: new Date(Date.now() + DAY),
      },
    });
    await confirm(who.id);
    breakDeleting('DocumentCollaborator', who.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await carryOutDeletions()).toMatchObject({ steps: 3, completed: 0, failed: 1 });
      expect((await recordOf(who.id))!.rowsDoneAt).toBeNull();
      expect((await db().ownershipOffer.findUniqueOrThrow({ where: { id: offered.id } })).state).toBe(
        'PENDING',
      );
      expect(await db().documentCollaborator.count({ where: { userId: who.id } })).toBe(1);
      const row = await db().user.findUniqueOrThrow({ where: { id: who.id } });
      expect(row.email).toBe(who.email);
      expect(row.erasedAt).toBeNull();
      const kinds = stepsOf(await entries(who.id));
      expect(kinds).not.toContain('account_deletion_user_pseudonymised');
      expect(kinds).not.toContain('account_deletion_roles_ended');
    } finally {
      mend('DocumentCollaborator');
    }
    expect(await carryOutDeletions()).toMatchObject({ steps: 1, completed: 1, failed: 0 });
    expect((await db().ownershipOffer.findUniqueOrThrow({ where: { id: offered.id } })).state).toBe(
      'DECLINED',
    );
  });

  it('repeats a step after a crash without a second effect: the tombstone, and the time of the deletion, stay as they were', async () => {
    const who = await person();
    await confirm(who.id);
    await carryOutDeletions();
    const before = await db().user.findUniqueOrThrow({ where: { id: who.id } });
    // As if the last two steps had been done and not recorded.
    database.sql(
      `UPDATE "AccountDeletion" SET "completedAt" = NULL, "rowsDoneAt" = NULL, "credentialsDoneAt" = NULL WHERE "userId" = '${who.id}'`,
    );
    expect(await carryOutDeletions()).toMatchObject({ steps: 2, completed: 1 });
    const after = await db().user.findUniqueOrThrow({ where: { id: who.id } });
    // `updatedAt` is the table’s own and moves with any write; what the row holds does not.
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
  });
});

describe('step (b), Istorico (FR-AU-58 (b), NFR-DP-09 (a); contract IC-29)', () => {
  it('makes no call where the adapter reports no erasure capability, whatever the account holds, and the step is done', async () => {
    const who = await person();
    await recordedDocumentOf(who);
    await confirm(who.id);
    const erase = vi.spyOn(noopAdapter, 'erase');
    await carryOutDeletions();
    expect(erase).not.toHaveBeenCalled();
    expect((await recordOf(who.id))!.istoricoDoneAt).not.toBeNull();
  });

  it('is answered “holds no record” by the no-op adapter, for each document (NFR-DP-09 (b))', async () => {
    const result = await noopAdapter.erase({
      requestId: 'r',
      subjectUserId: 'u',
      documents: [{ documentId: 'd', role: 'contributor', workspaceKind: 'personal' }],
    });
    expect(result).toEqual({ ok: true, value: [{ documentId: 'd', outcome: 'no-record' }] });
  });

  it('names the recorded documents the account holds a role on, as a contributor, and no other', async () => {
    const who = await person();
    const { id: recorded } = await recordedDocumentOf(who);
    const owner = await person();
    const { id: unrecorded } = await createDocument(owner.id);
    await grant(unrecorded, who);
    await confirm(who.id);
    const calls: ErasureRequest[] = [];
    await carryOutDeletions(new Date(), {
      port: erasing(async (input) => {
        calls.push(input);
        return answering('pseudonymised')(input);
      }),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      subjectUserId: who.id,
      documents: [{ documentId: recorded, role: 'contributor', workspaceKind: 'personal' }],
    });
  });

  it.each(['pseudonymised', 'no-record'] as const)('finishes on the outcome %s', async (outcome) => {
    const who = await person();
    await recordedDocumentOf(who);
    await confirm(who.id);
    const done = await carryOutDeletions(new Date(), { port: erasing(answering(outcome)) });
    expect(done.completed).toBe(1);
  });

  it.each([
    ['a hold', answering('held')],
    ['an erasure, which a contributor is never given', answering('erased')],
    ['an outcome this version does not know', answering('something else' as never)],
    [
      'an answer that leaves the document out',
      async () => ({ ok: true, value: [] }) as Result<ErasureOutcome[]>,
    ],
    [
      'an error',
      async () => ({ ok: false, error: 'unavailable', retryable: true }) as Result<ErasureOutcome[]>,
    ],
    [
      'a call that throws, which the port does not (IC-10) and the step does not rest on',
      async (): Promise<Result<ErasureOutcome[]>> => {
        throw new Error('down');
      },
    ],
  ])('keeps the step owed on %s, and the deletion is not completed', async (_label, erase) => {
    const who = await person();
    await recordedDocumentOf(who);
    await confirm(who.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await carryOutDeletions(new Date(), { port: erasing(erase) });
    expect(outcome).toMatchObject({ steps: 0, completed: 0, failed: 1 });
    expect((await recordOf(who.id))!.istoricoDoneAt).toBeNull();
    expect((await db().user.findUniqueOrThrow({ where: { id: who.id } })).email).toBe(who.email);
  });
});

describe('step (c), the feedback intake behind FEEDBACK_INTAKE_ENABLED (FR-AU-58 (c), FR-AU-79; D112)', () => {
  const calls: string[] = [];
  const intake = (acknowledged: boolean | 'rejects') => ({
    pseudonymise: async (id: string) => {
      calls.push(id);
      if (acknowledged === 'rejects') throw new Error('down');
      return acknowledged;
    },
  });
  beforeEach(() => void (calls.length = 0));

  it.each([undefined, '', 'false'])(
    'with the switch off (%j) makes no call, is recorded as skipped with its entry, and does not hold the deletion back',
    async (value) => {
      if (value !== undefined) process.env.FEEDBACK_INTAKE_ENABLED = value;
      const who = await person();
      await confirm(who.id);
      const outcome = await carryOutDeletions(new Date(), { feedback: { intake: intake(true) } });
      expect(outcome).toMatchObject({ steps: 4, completed: 1 });
      expect(calls).toEqual([]);
      const record = (await recordOf(who.id))!;
      expect(record.feedbackSkippedAt).not.toBeNull();
      expect(record.feedbackDoneAt).toBeNull();
      const kinds = await entries(who.id);
      expect(kinds).toContain('account_deletion_feedback_skipped');
      expect(kinds).not.toContain('account_deletion_feedback_pseudonymised');
    },
  );

  it('with the switch on calls the intake once for the account, and records the step done with its entry', async () => {
    process.env.FEEDBACK_INTAKE_ENABLED = 'true';
    const who = await person();
    await confirm(who.id);
    const outcome = await carryOutDeletions(new Date(), { feedback: { intake: intake(true) } });
    expect(outcome).toMatchObject({ steps: 4, completed: 1 });
    expect(calls).toEqual([who.id]);
    const record = (await recordOf(who.id))!;
    expect(record.feedbackDoneAt).not.toBeNull();
    expect(record.feedbackSkippedAt).toBeNull();
    const kinds = await entries(who.id);
    expect(kinds).toContain('account_deletion_feedback_pseudonymised');
    expect(kinds).not.toContain('account_deletion_feedback_skipped');
  });

  it.each([
    ['does not acknowledge', false],
    ['does not answer', 'rejects'],
  ] as const)(
    'with the switch on and an intake that %s, is repeated and holds the deletion at (c)',
    async (_label, how) => {
      process.env.FEEDBACK_INTAKE_ENABLED = 'true';
      const who = await person();
      await confirm(who.id);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const held = await carryOutDeletions(new Date(), { feedback: { intake: intake(how) } });
      expect(held).toMatchObject({ steps: 1, completed: 0, failed: 1 });
      let record = (await recordOf(who.id))!;
      expect(record.istoricoDoneAt).not.toBeNull();
      expect(record.feedbackDoneAt).toBeNull();
      expect(record.feedbackSkippedAt).toBeNull();
      // Owed, not skipped: nothing after it has run.
      expect(record.credentialsDoneAt).toBeNull();
      expect(await db().session.count({ where: { userId: who.id } })).toBeGreaterThan(0);
      const again = await carryOutDeletions(new Date(), { feedback: { intake: intake(true) } });
      expect(again).toMatchObject({ steps: 3, completed: 1 });
      expect(calls).toEqual([who.id, who.id]);
      record = (await recordOf(who.id))!;
      expect(record.feedbackDoneAt).not.toBeNull();
    },
  );

  it('with a value that is neither true nor false, fails and says so, and calls nothing', async () => {
    process.env.FEEDBACK_INTAKE_ENABLED = 'yes';
    const who = await person();
    await confirm(who.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await carryOutDeletions(new Date(), { feedback: { intake: intake(true) } });
    expect(outcome).toMatchObject({ steps: 1, completed: 0, failed: 1 });
    expect(calls).toEqual([]);
    expect((await recordOf(who.id))!.feedbackSkippedAt).toBeNull();
  });

  it('with the switch on and the client the widget will bring not yet built, fails and repeats, and pretends nothing', async () => {
    process.env.FEEDBACK_INTAKE_ENABLED = 'true';
    const who = await person();
    await confirm(who.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await carryOutDeletions();
    expect(outcome).toMatchObject({ steps: 1, completed: 0, failed: 1 });
    expect((await recordOf(who.id))!.feedbackDoneAt).toBeNull();
    expect((await db().user.findUniqueOrThrow({ where: { id: who.id } })).email).toBe(who.email);
  });
});

describe('step (d), the sessions and the credentials (FR-AU-58 (d))', () => {
  it('deletes every session, the credential, the second factor and every single-use row of the account, and no one else’s', async () => {
    const who = await enrolled();
    const other = await enrolled();
    // Two more sessions (a sign-in of an account with a second factor makes none until the code), and an open second step.
    await db().session.createMany({
      data: [1, 2].map((each) => ({
        id: randomUUID(),
        userId: who.id,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + DAY),
        ipAddress: `10.9.9.${each}`,
        userAgent: 'a browser',
      })),
    });
    await passwordStep(auth, who.email, net());
    await db().verification.createMany({
      data: [
        {
          id: randomUUID(),
          identifier: 'reset-password:a',
          value: who.id,
          expiresAt: new Date(Date.now() + DAY),
        },
        {
          id: randomUUID(),
          identifier: 'confirm-address:b',
          value: `${who.id} new@example.com`,
          expiresAt: new Date(Date.now() + DAY),
        },
        { id: randomUUID(), identifier: who.email, value: 'a token', expiresAt: new Date(Date.now() + DAY) },
        {
          id: randomUUID(),
          identifier: 'reset-password:c',
          value: other.id,
          expiresAt: new Date(Date.now() + DAY),
        },
        {
          id: randomUUID(),
          identifier: 'confirm-address:d',
          value: `${other.id} next@example.com`,
          expiresAt: new Date(Date.now() + DAY),
        },
      ],
    });
    expect(await db().session.count({ where: { userId: who.id } })).toBeGreaterThan(1);
    expect(await db().twoFactor.count({ where: { userId: who.id } })).toBe(1);
    await confirm(who.id);
    await carryOutDeletions();

    expect(await db().session.count({ where: { userId: who.id } })).toBe(0);
    expect(await db().account.count({ where: { userId: who.id } })).toBe(0);
    expect(await db().twoFactor.count({ where: { userId: who.id } })).toBe(0);
    expect(
      await db().verification.count({
        where: {
          OR: [{ value: who.id }, { value: { startsWith: `${who.id} ` } }, { identifier: who.email }],
        },
      }),
    ).toBe(0);
    // Another account’s rows are all there.
    expect(await db().session.count({ where: { userId: other.id } })).toBeGreaterThan(0);
    expect(await db().account.count({ where: { userId: other.id } })).toBe(1);
    expect(await db().twoFactor.count({ where: { userId: other.id } })).toBe(1);
    expect(await db().verification.count({ where: { value: other.id } })).toBe(1);
    expect(await db().verification.count({ where: { value: { startsWith: `${other.id} ` } } })).toBe(1);
    // The collaboration servers are told that the sessions ended, once more after step (d).
    await until(() => channel.sessionsEnded(who.id).length >= 2);
  });

  it('leaves no one able to sign in to the account again, whatever the password and the address', async () => {
    const who = await person();
    await confirm(who.id);
    await carryOutDeletions();
    expect((await signIn(auth, who.email, PASSWORD, net())).status).toBe(401);
    expect(await db().session.count({ where: { userId: who.id } })).toBe(0);
  });
});

// ── (e) and (f): the tombstone, the roles, the invitations, the offers ──────

describe('steps (e) and (f), the tombstone and what refers to the account (FR-AU-58 (e), (f))', () => {
  /** Everything the deletion touches, in one place, and a witness for each thing it must leave alone. */
  async function scene() {
    const ben = await person('Ben Person');
    const ada = await person('Ada Owner');
    const cy = await person('Cy Invitee');
    const dee = await person('Dee Accepter');
    await ensurePersonalWorkspace(ben.id);
    await db().user.update({
      where: { id: ben.id },
      data: {
        closedAlphaNoticeAcknowledgedAt: new Date('2026-10-01T10:00:00Z'),
        closedAlphaNoticeVersion: 1,
      },
    });
    // Ada owns three documents; Ben is an Editor of the first, a Viewer of the second (in the trash), and invited to the third.
    const one = (await createDocument(ada.id)).id;
    const two = (await createDocument(ada.id)).id;
    const three = (await createDocument(ada.id)).id;
    await db().document.update({ where: { id: one }, data: { yjsState: Buffer.from('what Ben wrote') } });
    await grant(one, ben, 'EDITOR');
    await grant(two, ben, 'VIEWER');
    await grant(one, cy, 'EDITOR');
    await deleteDocument({ id: two }, ada.id);

    const expiresAt = new Date(Date.now() + 14 * DAY);
    const invitation = (data: {
      documentId: string;
      email: string;
      invitedById: string;
      state?: 'PENDING' | 'ACCEPTED';
      acceptedById?: string;
      titlePseudonym?: string;
    }) =>
      db().documentInvitation.create({
        data: {
          role: 'EDITOR',
          tokenHash: randomUUID(),
          expiresAt,
          emailClaimedAt: new Date(),
          state: 'PENDING',
          ...data,
        },
      });
    const notify = (recipientId: string, invitationId: string) =>
      db().notification.create({
        data: { recipientId, kind: INVITATION_NOTIFICATION, payload: { invitationId } },
      });

    // Ben sent: one pending (hidden title), one accepted by Dee (hidden title).
    const sentPending = await invitation({
      documentId: one,
      email: 'newcomer@example.com',
      invitedById: ben.id,
      titlePseudonym: 'Flying Hippos — Ben Person',
    });
    const sentNotice = await notify(cy.id, sentPending.id);
    const sentAccepted = await invitation({
      documentId: one,
      email: dee.email,
      invitedById: ben.id,
      state: 'ACCEPTED',
      acceptedById: dee.id,
      titlePseudonym: 'Calm Owls — Ben Person',
    });
    const acceptedNotice = await notify(dee.id, sentAccepted.id);
    // Ben was sent: one pending, one he accepted.
    const receivedPending = await invitation({ documentId: three, email: ben.email, invitedById: ada.id });
    const receivedNotice = await notify(ben.id, receivedPending.id);
    const receivedAccepted = await invitation({
      documentId: one,
      email: ben.email,
      invitedById: ada.id,
      state: 'ACCEPTED',
      acceptedById: ben.id,
    });
    // A witness: an invitation of Ada’s to someone else.
    const witness = await invitation({
      documentId: three,
      email: cy.email,
      invitedById: ada.id,
      titlePseudonym: 'Brave Owls — Ada Owner',
    });
    const witnessNotice = await notify(cy.id, witness.id);

    // An offer of ownership of the first document to Ben, with its notification.
    const offer = await db().ownershipOffer.create({
      data: { documentId: one, fromUserId: ada.id, toUserId: ben.id, expiresAt },
    });
    const offerNotice = await db().notification.create({
      data: { recipientId: ben.id, kind: 'ownership_offer', payload: { offerId: offer.id } },
    });
    // A notification Ben keeps.
    const kept = await db().notification.create({
      data: { recipientId: ben.id, kind: 'role_changed', payload: { documentId: two } },
    });

    // Admission: the invitation Ben’s account was made from, and an earlier one for the same address.
    const admitted = await db().admissionInvitation.create({
      data: {
        email: ben.email,
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        state: 'ACCEPTED',
        expiresAt,
        acceptedAt: new Date(),
        acceptedById: ben.id,
      },
    });
    const earlier = await db().admissionInvitation.create({
      data: {
        email: ben.email,
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        state: 'REVOKED',
        expiresAt,
        revokedAt: new Date(),
      },
    });
    const strangers = await db().admissionInvitation.create({
      data: {
        email: `stranger${randomUUID()}@example.com`,
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        state: 'PENDING',
        expiresAt,
      },
    });
    return {
      ben,
      ada,
      cy,
      dee,
      docs: { one, two, three },
      invitations: { sentPending, sentAccepted, receivedPending, receivedAccepted, witness },
      notices: { sentNotice, acceptedNotice, receivedNotice, witnessNotice, offerNotice, kept },
      offer,
      admitted,
      earlier,
      strangers,
    };
  }

  it('turns the row into a tombstone: every personal column empty, and no column that is not named', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const row = await db().user.findUniqueOrThrow({ where: { id: s.ben.id } });
    // A column added to the table is a column that may hold a person: it fails here until it is named.
    expect(Object.keys(row).sort()).toEqual(
      [
        'id',
        'name',
        'email',
        'emailVerified',
        'image',
        'twoFactorEnabled',
        'lockedUntil',
        'closedAlphaNoticeAcknowledgedAt',
        'closedAlphaNoticeVersion',
        'erasedAt',
        'createdAt',
        'updatedAt',
      ].sort(),
    );
    expect(row).toMatchObject({
      id: s.ben.id,
      name: null,
      email: null,
      image: null,
      emailVerified: false,
      twoFactorEnabled: false,
      lockedUntil: null,
    });
    expect(row.erasedAt).toBeInstanceOf(Date);
    // Kept: the identifier, the time of the deletion, the acknowledgement and its version (FR-AU-56).
    expect(row.closedAlphaNoticeAcknowledgedAt).toEqual(new Date('2026-10-01T10:00:00Z'));
    expect(row.closedAlphaNoticeVersion).toBe(1);
    expect((await recordOf(s.ben.id))!.rowsDoneAt).toEqual(row.erasedAt);
    // The address is free: an admission to it makes an account again.
    const again = await createAccount(auth, s.ben.email);
    expect(again).not.toBe(s.ben.id);
    // The personal workspace is kept with the tombstone.
    expect(await db().workspace.count({ where: { ownerId: s.ben.id } })).toBe(1);
  });

  it('ends the roles on the documents of others, and what the account contributed stays', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    expect(await db().documentCollaborator.count({ where: { userId: s.ben.id } })).toBe(0);
    // The others’ roles stand, and the document is as it was.
    expect(await db().documentCollaborator.count({ where: { userId: s.cy.id } })).toBe(1);
    const stored = await db().document.findUniqueOrThrow({
      where: { id: s.docs.one },
      select: { yjsState: true, ownerId: true },
    });
    expect(Buffer.from(stored.yjsState!).toString()).toBe('what Ben wrote');
    expect(stored.ownerId).toBe(s.ada.id);
    // The deleted document, in the trash, lost the role too and is still in the trash.
    expect((await db().document.findUniqueOrThrow({ where: { id: s.docs.two } })).deletedAt).not.toBeNull();
    expect(stepsOf(await entries(s.ben.id))).toContain('account_deletion_roles_ended');
  });

  it('declines the pending offer, deletes its notification, and tells the Owner it ended, naming no one', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const offer = await db().ownershipOffer.findUniqueOrThrow({ where: { id: s.offer.id } });
    expect(offer.state).toBe('DECLINED');
    expect(offer.respondedAt).not.toBeNull();
    expect(await db().notification.count({ where: { id: s.notices.offerNotice.id } })).toBe(0);
    const told = (await listNotifications(s.ada.id)).notifications.filter(
      (notification) => notification.kind === 'ownership_offer_ended',
    );
    expect(told).toHaveLength(1);
    // D215, D217: “the Editor”, which the page words from an empty name; the account is the Owner still.
    expect(told[0]).toMatchObject({ end: 'ended', editorName: '', documentId: s.docs.one });
    expect((await db().document.findUniqueOrThrow({ where: { id: s.docs.one } })).ownerId).toBe(s.ada.id);
  });

  it('leaves an offer past its time to the timer, which writes it expired', async () => {
    const s = await scene();
    await db().ownershipOffer.update({
      where: { id: s.offer.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await confirm(s.ben.id);
    await carryOutDeletions();
    expect((await db().ownershipOffer.findUniqueOrThrow({ where: { id: s.offer.id } })).state).toBe(
      'PENDING',
    );
  });

  it('revokes the pending invitations the account sent and was sent, with their notifications, and no others', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const state = async (id: string) =>
      (await db().documentInvitation.findUniqueOrThrow({ where: { id } })).state;
    expect(await state(s.invitations.sentPending.id)).toBe('REVOKED');
    expect(await state(s.invitations.receivedPending.id)).toBe('REVOKED');
    expect(await state(s.invitations.sentAccepted.id)).toBe('ACCEPTED');
    expect(await state(s.invitations.receivedAccepted.id)).toBe('ACCEPTED');
    expect(await state(s.invitations.witness.id)).toBe('PENDING');
    const noticed = async (id: string) => (await db().notification.count({ where: { id } })) === 1;
    expect(await noticed(s.notices.sentNotice.id)).toBe(false);
    expect(await noticed(s.notices.receivedNotice.id)).toBe(false);
    expect(await noticed(s.notices.acceptedNotice.id)).toBe(true);
    expect(await noticed(s.notices.witnessNotice.id)).toBe(true);
  });

  it('clears the invited address from every invitation addressed to the account, an accepted one included, and from no other', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const address = async (id: string) =>
      (await db().documentInvitation.findUniqueOrThrow({ where: { id } })).email;
    expect(await address(s.invitations.receivedPending.id)).toBeNull();
    expect(await address(s.invitations.receivedAccepted.id)).toBeNull();
    // What Ben sent keeps the address of its invitee: it is the invitee’s.
    expect(await address(s.invitations.sentPending.id)).toBe('newcomer@example.com');
    expect(await address(s.invitations.sentAccepted.id)).toBe(s.dee.email);
    expect(await address(s.invitations.witness.id)).toBe(s.cy.email);
    // And nothing in the table names Ben’s address any longer.
    expect(await db().documentInvitation.count({ where: { email: s.ben.email } })).toBe(0);
  });

  it('strips the sender’s name from the pseudonym of every invitation the account sent (docs/plan/invitation-title.md)', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const pseudonym = async (id: string) =>
      (await db().documentInvitation.findUniqueOrThrow({ where: { id } })).titlePseudonym;
    expect(await pseudonym(s.invitations.sentPending.id)).toBe('Flying Hippos — Deleted account');
    expect(await pseudonym(s.invitations.sentAccepted.id)).toBe('Calm Owls — Deleted account');
    // Another sender’s is as it was.
    expect(await pseudonym(s.invitations.witness.id)).toBe('Brave Owls — Ada Owner');
    // No invitation anywhere holds the name.
    const all = await db().documentInvitation.findMany({ select: { titlePseudonym: true } });
    expect(all.map(({ titlePseudonym }) => titlePseudonym ?? '').join('\n')).not.toContain('Ben Person');
  });

  it('names the sender of an invitation that was accepted by neither name nor address once the account is deleted', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const shown = (await listNotifications(s.dee.id)).notifications.find(
      (notification) => notification.id === s.notices.acceptedNotice.id,
    );
    // The page words an empty name as “Deleted account” (FR-AU-58 (e); tests/unit/deleted-account.test.ts).
    expect(shown).toMatchObject({ kind: INVITATION_NOTIFICATION, inviterName: '', inviterEmail: null });
  });

  it('clears the address from the admission invitation the account was made from, and from an earlier one for it; the rows stay', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const row = (id: string) => db().admissionInvitation.findUniqueOrThrow({ where: { id } });
    expect(await row(s.admitted.id)).toMatchObject({
      email: null,
      state: 'ACCEPTED',
      acceptedById: s.ben.id,
    });
    expect(await row(s.earlier.id)).toMatchObject({ email: null, state: 'REVOKED' });
    expect((await row(s.strangers.id)).email).toMatch(/^stranger/);
    expect(await db().admissionInvitation.count({ where: { email: s.ben.email } })).toBe(0);
  });

  it('keeps the notifications of the account against the tombstone, which has no session to show them to', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    expect(await db().notification.count({ where: { id: s.notices.kept.id, recipientId: s.ben.id } })).toBe(
      1,
    );
    expect((await validateSessionRow(new Headers({ cookie: s.ben.cookie }))).session).toBeNull();
  });

  it('holds no personal field of the account in any table that can hold one, after the deletion', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    // The tables that could hold the address or the name, each read as text and looked through.
    const tables = [
      'User',
      'AdmissionInvitation',
      'DocumentInvitation',
      'Notification',
      'OwnershipOffer',
      'Verification',
      'Session',
      'Account',
      'AccountDeletion',
      'SecurityLogEntry',
    ];
    for (const table of tables) {
      const text = database.sql(
        `SELECT coalesce(string_agg(row_to_json(t)::text, E'\\n'), '') FROM "${table}" t`,
      );
      expect(text, table).not.toContain(s.ben.email);
      expect(text, table).not.toContain('Ben Person');
    }
  });

  it('is idempotent: the step run again changes no row', async () => {
    const s = await scene();
    await confirm(s.ben.id);
    await carryOutDeletions();
    const dump = () =>
      database.sql(
        `SELECT string_agg(t::text, E'\\n' ORDER BY t::text) FROM (SELECT id, "state"::text, "email", "titlePseudonym" FROM "DocumentInvitation") t`,
      );
    const before = dump();
    database.sql(
      `UPDATE "AccountDeletion" SET "completedAt" = NULL, "rowsDoneAt" = NULL WHERE "userId" = '${s.ben.id}'`,
    );
    await carryOutDeletions();
    expect(dump()).toBe(before);
  });
});

// ── NFR-DP-06, NFR-SE-19 ────────────────────────────────────────────────────

describe('the one-month limit (NFR-DP-06) and the log (NFR-SE-19)', () => {
  it('completes at the first run that succeeds, within the month of the confirmation, whatever failed before', async () => {
    process.env.FEEDBACK_INTAKE_ENABLED = 'true';
    const who = await person();
    await confirm(who.id);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const intake = (acknowledged: boolean) => ({
      feedback: { intake: { pseudonymise: async () => acknowledged } },
    });
    expect((await carryOutDeletions(new Date(), intake(false))).completed).toBe(0);
    expect((await carryOutDeletions(new Date(), intake(false))).completed).toBe(0);
    expect((await carryOutDeletions(new Date(), intake(true))).completed).toBe(1);
    const record = (await recordOf(who.id))!;
    expect(record.completedAt!.getTime()).toBeLessThan(oneMonthAfter(record.requestedAt).getTime());
  });

  it('says once in a run how many are open past the month, and says nothing of a deletion that is not', async () => {
    process.env.FEEDBACK_INTAKE_ENABLED = 'true';
    const late = await person();
    const fresh = await person();
    await confirm(late.id);
    await confirm(fresh.id);
    await db().accountDeletion.update({
      where: { userId: late.id },
      data: { requestedAt: new Date(Date.now() - 40 * DAY) },
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await carryOutDeletions(new Date(), {
      feedback: { intake: { pseudonymise: async () => false } },
    });
    expect(outcome).toMatchObject({ failed: 2, overdue: 1 });
    const lines = error.mock.calls.map(([line]) => String(line));
    expect(lines.filter((line) => line.includes('open past the one-month limit'))).toEqual([
      'account deletion: 1 confirmed deletion is open past the one-month limit (NFR-DP-06)',
    ]);
  });

  it('measures the month in calendar months, from the confirmation', () => {
    expect(oneMonthAfter(new Date('2026-01-31T10:00:00Z')).toISOString()).toBe('2026-03-03T10:00:00.000Z');
    expect(oneMonthAfter(new Date('2026-10-26T10:00:00Z')).toISOString()).toBe('2026-11-26T10:00:00.000Z');
  });

  it('writes entries of the kind and the user and nothing else, and no line of a run holds a name, an address or a token', async () => {
    const who = await person('Ben Person');
    await confirm(who.id);
    const lines: string[] = [];
    for (const method of ['log', 'error', 'warn', 'info'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => void lines.push(parts.join(' ')));
    }
    process.env.FEEDBACK_INTAKE_ENABLED = 'true';
    await carryOutDeletions(); // fails at (c): the unbuilt client, one line
    delete process.env.FEEDBACK_INTAKE_ENABLED;
    await carryOutDeletions();
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(who.email);
      expect(line).not.toContain('Ben Person');
      expect(line).not.toMatch(/token|password/i);
    }
    const rows = await db().securityLogEntry.findMany({ where: { userId: who.id } });
    expect(rows.length).toBeGreaterThanOrEqual(6);
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['createdAt', 'documentId', 'id', 'kind', 'userId']);
      expect(row.documentId).toBeNull();
    }
  });
});
