// A request that was on its way when the password was set, or its session
// ended (FR-AU-84, FR-AU-85, FR-AU-86; NFR-SE-17 (c)). Each test holds one
// request at a known step, lets another complete, and lets the first go on:
// what it verified is no longer so, and it must change nothing. And the two
// endpoints that leave work for after their answer, called where none can be
// left (FR-AU-87).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-races-mail-'));
const database = prepare('races', { TRUSTED_PROXY_COUNT: '1', EMAIL_SINK_DIRECTORY: sink });
const { auth, db, valkey, validateSessionRow } = await load();
const { findOpenReset } = await import('../../src/lib/auth/password.ts');
const { beginLock } = await import('../../src/lib/auth/sign-in-lock.ts');

const UNAUTHENTICATED =
  '{"error":{"code":"unauthenticated","message":"This request needs a signed-in session. Sign in and try again."}}';
const PASSWORD_REFUSED =
  '{"error":{"code":"password_refused","message":"The email address or the password is not correct."}}';
const SIGN_IN_REFUSED =
  '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}';
const INTERNAL =
  '{"error":{"code":"internal","message":"The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes."}}';
const RESET_SUBJECT = 'Set a new password for Ekdotico';
const NOTICE_SUBJECT = 'The password of your Ekdotico account was changed';
const LOCK_SUBJECT = 'Sign-in to your Ekdotico account is locked for 1 hour';
// FR-AU-81, written out here and not imported.
const LINK_NOT_VALID =
  '{"error":{"code":"sign_in_link_not_valid","message":"This link is no longer valid. Sign in with your email address and password, or set a new password from the sign-in page."}}';

const THEIRS = 'the password of the attacker';
const OWNERS = 'the new password of the owner';

let addresses = 0;
/** A network address no earlier request came from. */
const fresh = () => ({ 'x-forwarded-for': `10.9.${Math.floor(++addresses / 250)}.${addresses % 250}` });
let people = 0;
async function person() {
  const email = `person${++people}@example.com`;
  return { email, id: await createAccount(auth, email) };
}
const session = async (email: string, password = PASSWORD) =>
  cookiesOf(await signIn(auth, email, password, fresh()));
const signsIn = async (email: string, password: string, net = fresh()) =>
  (await signIn(auth, email, password, net)).status === 200;
const stands = async (cookie: string) => (await validateSessionRow(new Headers({ cookie }))).session !== null;
const change = (cookie: string, currentPassword: string, newPassword: string) =>
  post(auth, '/change-password', { currentPassword, newPassword }, { cookie, ...fresh() });
const notices = async (email: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject === NOTICE_SUBJECT);
async function linkFor(email: string): Promise<string> {
  const asked = await post(auth, '/request-password-reset', { email }, fresh());
  await asked.after();
  const message = (await sunk(sink)).filter((m) => m.to === email && m.subject === RESET_SUBJECT).at(-1);
  return /\/reset-password\/([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
}
const entries = async () =>
  (await db().securityLogEntry.findMany()).map(({ kind, userId }) => [kind, userId]);

/**
 * Holds the next call of `object[method]` before it runs. `reached` resolves
 * when the held call arrives; `open()` lets it go on.
 */
function hold<T extends object>(object: T, method: keyof T & string) {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  const original = (object[method] as (...args: unknown[]) => unknown).bind(object);
  vi.spyOn(object as Record<string, (...args: unknown[]) => unknown>, method).mockImplementationOnce(
    async (...args) => {
      arrive();
      await opened;
      return original(...args);
    },
  );
  return { reached, open };
}
/** The hash of a new password: the step between the check of the current one and the transaction. */
const holdHash = async () => hold((await auth().$context).password, 'hash');
/** The making of a session: the step after a sign-in's check of the password. */
const holdSession = async () => hold((await auth().$context).internalAdapter, 'createSession');

/**
 * Holds the next transaction that is opened just after its deletion of
 * sessions, with everything before it done and nothing after it: where a
 * reset has ended the sessions and not yet lifted the lock, and a change of
 * the password has not yet made the sign-in link void.
 */
function holdAfterSessionsEnded() {
  let arrive!: () => void;
  let open!: () => void;
  const reached = new Promise<void>((resolve) => (arrive = resolve));
  const opened = new Promise<void>((resolve) => (open = resolve));
  type Work = (tx: Record<string, unknown>) => Promise<unknown>;
  const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
  const original = client.$transaction.bind(client);
  vi.spyOn(client, '$transaction').mockImplementationOnce((work) =>
    original((tx) => {
      const rows = tx.session as { deleteMany: (...args: unknown[]) => Promise<unknown> };
      const session = new Proxy(rows, {
        get: (target, key) =>
          key === 'deleteMany'
            ? async (...args: unknown[]) => {
                const deleted = await target.deleteMany(...args);
                arrive();
                await opened;
                return deleted;
              }
            : Reflect.get(target, key),
      });
      return work(
        new Proxy(tx, { get: (target, key) => (key === 'session' ? session : Reflect.get(target, key)) }),
      );
    }),
  );
  return { reached, open };
}

/** Locks the account as its twentieth failure would, and reads the token of the link from the email. */
async function lockLink(email: string): Promise<string> {
  await beginLock(email);
  const message = (await sunk(sink)).filter((m) => m.to === email && m.subject === LOCK_SUBJECT).at(-1);
  return /\/sign-in\/link\/([A-Za-z0-9_-]+)\n/.exec(message!.text)![1]!;
}
const confirmLink = (token: string) => post(auth, '/sign-in/link', { token }, fresh());
/** Long enough for a confirmation that waits for nothing to have completed. */
const MOMENT_MS = 750;

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a change of password on its way (FR-AU-84, FR-AU-85, FR-AU-86)', () => {
  it('does not overwrite a reset completed meanwhile, and is refused as a request without a session', async () => {
    const { email, id } = await person();
    const stolen = await session(email);
    const token = await linkFor(email);
    const held = await holdHash();

    const attacker = change(stolen, PASSWORD, THEIRS);
    await held.reached;
    // The owner completes a reset: every session ends, and the password is the owner's.
    const reset = await post(auth, '/reset-password', { token, newPassword: OWNERS });
    expect(reset.response.status).toBe(200);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    held.open();
    const changed = await attacker;

    expect(changed.response.status).toBe(401);
    expect(await changed.response.text()).toBe(UNAUTHENTICATED);
    // No notice of a change that was not made.
    expect(changed.left).toBe(0);
    expect(await signsIn(email, OWNERS)).toBe(true);
    expect(await signsIn(email, THEIRS)).toBe(false);
    expect(await signsIn(email, PASSWORD)).toBe(false);
  });

  it('changes nothing under a session that was ended meanwhile, and ends no session', async () => {
    const { email, id } = await person();
    const stolen = await session(email);
    const owner = await session(email);
    const before = (await db().account.findFirstOrThrow({ where: { userId: id } })).password;
    const held = await holdHash();

    const attacker = change(stolen, PASSWORD, THEIRS);
    await held.reached;
    // The owner ends every other session, the stolen one among them.
    const ended = await post(auth, '/revoke-other-sessions', undefined, { cookie: owner });
    expect(ended.response.status).toBe(200);
    held.open();
    const changed = await attacker;

    expect(changed.response.status).toBe(401);
    expect(await changed.response.text()).toBe(UNAUTHENTICATED);
    expect(changed.left).toBe(0);
    // The password is as it was, to the byte: the write was undone, not made again.
    expect((await db().account.findFirstOrThrow({ where: { userId: id } })).password).toBe(before);
    expect(await signsIn(email, THEIRS)).toBe(false);
    // The owner's session is the one that stands.
    expect(await stands(owner)).toBe(true);
    expect(await stands(stolen)).toBe(false);
  });

  it('is refused as a wrong current password where the same session changed the password meanwhile', async () => {
    const { email, id } = await person();
    const cookie = await session(email);
    const net = fresh();
    const held = await holdHash();

    const first = post(
      auth,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: THEIRS },
      { cookie, ...net },
    );
    await held.reached;
    // The same browser, sent twice: the second request completes first.
    expect((await change(cookie, PASSWORD, OWNERS)).response.status).toBe(200);
    // A reset link asked for after the change that completed.
    const token = await linkFor(email);
    held.open();
    const outrun = await first;

    expect(outrun.response.status).toBe(403);
    expect(await outrun.response.text()).toBe(PASSWORD_REFUSED);
    expect(outrun.left).toBe(0);
    // A change that changes nothing makes no reset link void (FR-AU-86: a
    // link "stays valid until it is used or its hour has passed").
    expect(await findOpenReset(token)).not.toBeNull();
    // The session stays, and the 403 has its entry (NFR-SE-19).
    expect(await stands(cookie)).toBe(true);
    expect(await entries()).toEqual([['forbidden', id]]);
    expect(await signsIn(email, OWNERS)).toBe(true);
    expect(await signsIn(email, THEIRS)).toBe(false);
    // Not counted as a failed sign-in: four wrong passwords from that network
    // address are still not five (NFR-SE-07).
    for (let n = 0; n < 4; n++) expect(await signsIn(email, 'a wrong password', net)).toBe(false);
    expect(await signsIn(email, OWNERS, net)).toBe(true);
  });

  it('leaves the time of the last renewal of its session as it was', async () => {
    const { email, id } = await person();
    const cookie = await session(email);
    const before = await db().session.findFirstOrThrow({ where: { userId: id } });
    expect((await change(cookie, PASSWORD, OWNERS)).response.status).toBe(200);
    const after = await db().session.findFirstOrThrow({ where: { userId: id } });
    expect(after.id).toBe(before.id);
    expect(after.updatedAt).toEqual(before.updatedAt);
    expect(after.expiresAt).toEqual(before.expiresAt);
  });
});

describe('a sign-in with the old password on its way (FR-AU-81, FR-AU-85, FR-AU-86)', () => {
  it('leaves no session after a reset completed meanwhile, and sets no cookie', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const held = await holdSession();

    const attacker = signIn(auth, email, PASSWORD, fresh());
    await held.reached;
    const reset = await post(auth, '/reset-password', { token, newPassword: OWNERS });
    expect(reset.response.status).toBe(200);
    held.open();
    const signed = await attacker;

    expect(signed.status).toBe(401);
    expect(await signed.text()).toBe(SIGN_IN_REFUSED);
    expect(signed.headers.getSetCookie()).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    expect(await entries()).toEqual([['sign_in_refused', id]]);
  });

  it('leaves no session after a change of password made meanwhile, and is not counted as a failure', async () => {
    const { email, id } = await person();
    const owner = await session(email);
    const net = fresh();
    const held = await holdSession();

    const attacker = signIn(auth, email, PASSWORD, net);
    await held.reached;
    expect((await change(owner, PASSWORD, OWNERS)).response.status).toBe(200);
    held.open();
    const signed = await attacker;

    expect(signed.status).toBe(401);
    expect(await signed.text()).toBe(SIGN_IN_REFUSED);
    expect(signed.headers.getSetCookie()).toEqual([]);
    // The owner's session, and no other.
    const rows = await db().session.findMany({ where: { userId: id } });
    expect(rows).toHaveLength(1);
    expect(await stands(owner)).toBe(true);
    expect(await entries()).toEqual([['sign_in_refused', id]]);
    // Four wrong passwords from that network address are still not five.
    for (let n = 0; n < 4; n++) expect(await signsIn(email, 'a wrong password', net)).toBe(false);
    expect(await signsIn(email, OWNERS, net)).toBe(true);
  });

  it('keeps the session the browser already held where the sign-in is refused in this way', async () => {
    const { email } = await person();
    const other = await person();
    const heldBefore = await session(other.email);
    const token = await linkFor(email);
    const held = await holdSession();

    const attacker = signIn(auth, email, PASSWORD, { ...fresh(), cookie: heldBefore });
    await held.reached;
    await post(auth, '/reset-password', { token, newPassword: OWNERS });
    held.open();
    expect((await attacker).status).toBe(401);
    expect(await stands(heldBefore)).toBe(true);
  });

  it('writes nothing to the account where the password is still the one verified', async () => {
    const { email, id } = await person();
    const before = await db().account.findFirstOrThrow({ where: { userId: id } });
    expect(await signsIn(email, PASSWORD)).toBe(true);
    expect(await db().account.findFirstOrThrow({ where: { userId: id } })).toEqual(before);
  });
});

describe('a sign-in by the link of a lock email on its way (FR-AU-81, FR-AU-83, FR-AU-85, FR-AU-86; A104)', () => {
  it('leaves no session where a reset had ended the sessions and not yet lifted the lock', async () => {
    const { email, id } = await person();
    const reset = await linkFor(email);
    const token = await lockLink(email);
    const held = holdAfterSessionsEnded();

    const resetting = post(auth, '/reset-password', { token: reset, newPassword: OWNERS });
    await held.reached;
    // The sessions are ended, the lock is in force and the link stands: the
    // confirmation either completes now, or waits for the reset.
    const confirming = confirmLink(token);
    await Promise.race([confirming, new Promise((resolve) => setTimeout(resolve, MOMENT_MS))]);
    held.open();
    expect((await resetting).response.status).toBe(200);
    const confirmed = await confirming;

    expect(confirmed.response.status).toBe(409);
    expect(await confirmed.response.text()).toBe(LINK_NOT_VALID);
    expect(confirmed.response.headers.getSetCookie()).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // NFR-SE-19: the lock, and a sign-in refused; no sign-in by the link.
    expect((await entries()).sort()).toEqual([
      ['sign_in_locked', id],
      ['sign_in_refused', id],
    ]);
    expect(await signsIn(email, OWNERS)).toBe(true);
  });

  it('leaves no session where a change of the password had ended the others and not yet made the link void', async () => {
    const { email, id } = await person();
    const owner = await session(email);
    // The change has checked the current password when the lock begins: a
    // prompt under a lock is refused (sign-in-lock.test.ts).
    const checked = await holdHash();
    const changing = change(owner, PASSWORD, OWNERS);
    await checked.reached;
    const token = await lockLink(email);
    const held = holdAfterSessionsEnded();
    checked.open();
    await held.reached;

    const confirming = confirmLink(token);
    await Promise.race([confirming, new Promise((resolve) => setTimeout(resolve, MOMENT_MS))]);
    held.open();
    expect((await changing).response.status).toBe(200);
    const confirmed = await confirming;

    expect(confirmed.response.status).toBe(409);
    expect(await confirmed.response.text()).toBe(LINK_NOT_VALID);
    expect(confirmed.response.headers.getSetCookie()).toEqual([]);
    // The session that changed the password, and no other.
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
    expect(await stands(owner)).toBe(true);
  });

  it('makes no session where two-factor authentication was turned on meanwhile, and goes on to the second step', async () => {
    const { email, id } = await person();
    const token = await lockLink(email);
    // Held where the session is made: the account has been read by then.
    const held = await holdSession();

    const confirming = confirmLink(token);
    await held.reached;
    // As the first code of an enrolment commits it (two-factor.ts).
    await db().user.update({ where: { id }, data: { twoFactorEnabled: true } });
    held.open();
    const confirmed = await confirming;

    expect(confirmed.response.status).toBe(200);
    expect(await confirmed.response.text()).toBe('{"twoFactorRedirect":true}');
    expect(confirmed.response.headers.getSetCookie().join()).not.toContain('session_token');
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // Nothing is lifted or spent by the link alone: both wait for the code.
    expect((await db().user.findUniqueOrThrow({ where: { id } })).lockedUntil).not.toBeNull();
    expect(
      await db().verification.count({ where: { value: id, identifier: { startsWith: 'sign-in-link:' } } }),
    ).toBe(1);
    expect(
      await db().verification.count({
        where: { value: id, identifier: { startsWith: 'second-step:link:' } },
      }),
    ).toBe(1);
  });
});

describe('an endpoint that leaves work for after its answer, called where none can be left (FR-AU-87)', () => {
  /** Through the handler, and not as the route calls it: nothing collects. */
  const bare = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    auth().handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...fresh(), ...headers },
        body: JSON.stringify(body),
      }),
    );

  it('fails before anything is written, so that the answer of a fault is true', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { email, id } = await person();
    const cookie = await session(email);
    const token = await linkFor(email);
    const before = await db().account.findFirstOrThrow({ where: { userId: id } });
    const asked = vi.spyOn(valkey(), 'eval');

    for (const response of [
      await bare('/reset-password', { token, newPassword: OWNERS }),
      await bare('/change-password', { currentPassword: PASSWORD, newPassword: OWNERS }, { cookie }),
      await bare('/request-password-reset', { email }),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(INTERNAL);
    }
    // Nothing was changed: the password, the session, the link, and no limit was counted.
    expect(await db().account.findFirstOrThrow({ where: { userId: id } })).toEqual(before);
    expect(await stands(cookie)).toBe(true);
    expect((await findOpenReset(token))?.userId).toBe(id);
    expect(asked).not.toHaveBeenCalled();
    expect(await notices(email)).toHaveLength(0);
  });

  it('rejects a call on the server, and changes nothing', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const api = auth().api as unknown as { resetPassword: (input: unknown) => Promise<unknown> };
    await expect(
      // With the application's own origin: without it the call is refused before this (NFR-SE-17 (c)).
      api.resetPassword({ body: { token, newPassword: OWNERS }, headers: new Headers({ origin: ORIGIN }) }),
    ).rejects.toThrow('afterResponse: called outside a request that collects.');
    expect(await signsIn(email, PASSWORD)).toBe(true);
    expect((await findOpenReset(token))?.userId).toBe(id);
  });
});
