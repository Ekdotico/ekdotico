// A request of two-factor authentication that was on its way when the
// password was set, or its session ended (FR-AU-83 to FR-AU-86; NFR-SE-17 (c)).
// Each test holds one request at a known step, lets another complete, and
// lets the first go on: what it verified is no longer so, and it must change
// nothing. As tests/integration/password-races.test.ts does for the password.
// And the endpoints that leave a notice for after their answer, called where
// none can be left (FR-AU-87).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import { enrol, nextCode, passwordStep, secondStep, unbase32 } from './second-factor.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-two-factor-races-mail-'));
const database = prepare('tworaces', { TRUSTED_PROXY_COUNT: '1', EMAIL_SINK_DIRECTORY: sink });
const { auth, db, valkey, validateSessionRow } = await load();

const UNAUTHENTICATED =
  '{"error":{"code":"unauthenticated","message":"This request needs a signed-in session. Sign in and try again."}}';
const SIGN_IN_REFUSED =
  '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}';
const INTERNAL =
  '{"error":{"code":"internal","message":"The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes."}}';
const RESET_SUBJECT = 'Set a new password for Ekdotico';
const OWNERS = 'the new password of the owner';

let addresses = 0;
const fresh = () => ({ 'x-forwarded-for': `10.6.${Math.floor(++addresses / 250)}.${addresses % 250}` });
let people = 0;
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { email, id, cookie: cookiesOf(await signIn(auth, email, PASSWORD, fresh())) };
}
async function enrolled() {
  const who = await person();
  return { ...who, ...(await enrol(auth, who.cookie, fresh())) };
}
const stands = async (cookie: string) => (await validateSessionRow(new Headers({ cookie }))).session !== null;
const isOn = async (id: string) => (await db().user.findUniqueOrThrow({ where: { id } })).twoFactorEnabled;
const rowOf = (userId: string) => db().twoFactor.findUnique({ where: { userId } });
const noticesTo = async (email: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject !== RESET_SUBJECT);
async function linkFor(email: string): Promise<string> {
  const asked = await post(auth, '/request-password-reset', { email }, fresh());
  await asked.after();
  const message = (await sunk(sink)).filter((m) => m.to === email && m.subject === RESET_SUBJECT).at(-1);
  return /\/reset-password\/([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
}
/** The owner completes a reset: the password is the owner's, and every session of the account has ended. */
async function reset(email: string, token: string) {
  const done = await post(auth, '/reset-password', { token, newPassword: OWNERS });
  expect(done.response.status).toBe(200);
}

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
/** The transaction of a change: the step after the password and the code were checked. */
const holdTransaction = () => hold(db(), '$transaction');
/** The making of a session: the step after the second step's check of the code. */
const holdSession = async () => hold((await auth().$context).internalAdapter, 'createSession');

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('turning two-factor authentication off, on its way (FR-AU-83, FR-AU-86)', () => {
  it('turns nothing off after a reset completed meanwhile, and is refused as a request without a session', async () => {
    const { email, id, cookie, secret } = await enrolled();
    const before = await rowOf(id);
    const token = await linkFor(email);
    const held = holdTransaction();

    // Whoever holds a session, the old password and a code: the owner resets the password meanwhile.
    const attacker = post(
      auth,
      '/two-factor/disable',
      { password: PASSWORD, code: nextCode(secret) },
      {
        cookie,
        ...fresh(),
      },
    );
    await held.reached;
    await reset(email, token);
    held.open();
    const answered = await attacker;

    expect(answered.response.status).toBe(401);
    expect(await answered.response.text()).toBe(UNAUTHENTICATED);
    // No notice of a change that was not made.
    expect(answered.left).toBe(0);
    expect(await isOn(id)).toBe(true);
    expect(await rowOf(id)).toEqual(before);
    // FR-AU-86: "a password reset does not remove the second factor".
    expect(await (await signIn(auth, email, OWNERS, fresh())).text()).toBe('{"twoFactorRedirect":true}');
  });

  it('turns nothing off under a session that was ended meanwhile', async () => {
    const { email, id, cookie, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    const owner = cookiesOf(await secondStep(auth, step, nextCode(secret), 'totp', fresh()));
    const held = holdTransaction();

    const attacker = post(
      auth,
      '/two-factor/disable',
      { password: PASSWORD, code: nextCode(secret) },
      {
        cookie,
        ...fresh(),
      },
    );
    await held.reached;
    expect((await post(auth, '/revoke-other-sessions', undefined, { cookie: owner })).response.status).toBe(
      200,
    );
    held.open();
    const answered = await attacker;

    expect(answered.response.status).toBe(401);
    expect(await answered.response.text()).toBe(UNAUTHENTICATED);
    expect(answered.left).toBe(0);
    expect(await isOn(id)).toBe(true);
    expect(await stands(owner)).toBe(true);
    expect(await stands(cookie)).toBe(false);
  });

  it('is refused where the recovery codes were replaced meanwhile, and the new ones stand', async () => {
    const { id, cookie, recoveryCodes } = await enrolled();
    const held = holdTransaction();
    const first = post(
      auth,
      '/two-factor/disable',
      { password: PASSWORD, code: recoveryCodes[0] },
      {
        cookie,
        ...fresh(),
      },
    );
    await held.reached;
    // The same account, in another request: the code just checked is void now.
    const replaced = await post(
      auth,
      '/two-factor/generate-backup-codes',
      { password: PASSWORD },
      {
        cookie,
        ...fresh(),
      },
    );
    expect(replaced.response.status).toBe(200);
    held.open();
    const answered = await first;

    expect(answered.response.status).toBe(403);
    expect(((await answered.response.json()) as { error: { code: string } }).error.code).toBe('code_refused');
    expect(answered.left).toBe(0);
    expect(await isOn(id)).toBe(true);
  });
});

describe('replacing the recovery codes and beginning an enrolment, on their way (FR-AU-83, FR-AU-86)', () => {
  it('replaces nothing after a reset completed meanwhile', async () => {
    const { email, id, cookie } = await enrolled();
    const before = await rowOf(id);
    const token = await linkFor(email);
    const held = holdTransaction();

    const attacker = post(
      auth,
      '/two-factor/generate-backup-codes',
      { password: PASSWORD },
      {
        cookie,
        ...fresh(),
      },
    );
    await held.reached;
    await reset(email, token);
    held.open();
    const answered = await attacker;

    expect(answered.response.status).toBe(401);
    expect(await answered.response.text()).toBe(UNAUTHENTICATED);
    // The answer holds no codes, and the owner's codes are the ones that work.
    expect(answered.left).toBe(0);
    expect(await rowOf(id)).toEqual(before);
  });

  it('begins no enrolment after a reset completed meanwhile', async () => {
    const { email, id, cookie } = await person();
    const token = await linkFor(email);
    const held = holdTransaction();

    const attacker = post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie, ...fresh() });
    await held.reached;
    await reset(email, token);
    held.open();
    const answered = await attacker;

    expect(answered.response.status).toBe(401);
    // No secret is answered, and none is stored for the attacker's authenticator.
    expect(await answered.response.text()).toBe(UNAUTHENTICATED);
    expect(await rowOf(id)).toBeNull();
  });

  it('does not turn it on under a session that was ended while the first code was on its way', async () => {
    const { email, id, cookie } = await person();
    const owner = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
    const begun = await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie, ...fresh() });
    const secret = unbase32(((await begun.response.json()) as { secret: string }).secret);
    const held = holdTransaction();

    const attacker = post(
      auth,
      '/two-factor/verify-totp',
      { code: nextCode(secret) },
      { cookie, ...fresh() },
    );
    await held.reached;
    expect((await post(auth, '/revoke-other-sessions', undefined, { cookie: owner })).response.status).toBe(
      200,
    );
    held.open();
    const answered = await attacker;

    expect(answered.response.status).toBe(401);
    // The recovery codes are not answered, and the account is not locked behind the attacker's authenticator.
    expect(await answered.response.text()).toBe(UNAUTHENTICATED);
    expect(answered.left).toBe(0);
    expect(await isOn(id)).toBe(false);
    expect(await (await signIn(auth, email, PASSWORD, fresh())).text()).toBe('{}');
  });

  it('keeps one secret where two enrolments begin together, and the first code of the other confirms nothing', async () => {
    const { id, cookie } = await person();
    const [one, two] = await Promise.all(
      [fresh(), fresh()].map(async (net) => {
        const begun = await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie, ...net });
        expect(begun.response.status).toBe(200);
        return unbase32(((await begun.response.json()) as { secret: string }).secret);
      }),
    );
    expect(await db().twoFactor.count({ where: { userId: id } })).toBe(1);
    const confirm = (secret: string) =>
      post(auth, '/two-factor/verify-totp', { code: nextCode(secret) }, { cookie, ...fresh() });
    const statuses = [(await confirm(one!)).response.status, (await confirm(two!)).response.status];
    // Whichever was written last is the secret; the other's code is a wrong
    // code, or meets an enrolment that is already confirmed.
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(await isOn(id)).toBe(true);
  });
});

describe('a sign-in with the old password on its way (FR-AU-81, FR-AU-83, FR-AU-85, FR-AU-86)', () => {
  it('begins no second step after a reset completed meanwhile', async () => {
    const { email, id } = await enrolled();
    const token = await linkFor(email);
    // The row of the step: written after the check of the password.
    const held = hold(db().verification, 'create');

    const attacker = signIn(auth, email, PASSWORD, fresh());
    await held.reached;
    await reset(email, token);
    held.open();
    const signed = await attacker;

    expect(signed.status).toBe(401);
    expect(await signed.text()).toBe(SIGN_IN_REFUSED);
    // No step is left open, in the database or in the browser.
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    for (const cookie of signed.headers.getSetCookie()) expect(cookie).toMatch(/two_factor=;.*Max-Age=0/i);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('completes no second step that the old password began, after a reset', async () => {
    const { email, id, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    await reset(email, await linkFor(email));
    // Whoever held the old password and the authenticator is asked for the new password.
    const late = await secondStep(auth, step, nextCode(secret));
    expect(late.status).toBe(401);
    expect(((await late.json()) as { error: { code: string } }).error.code).toBe('sign_in_again');
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('leaves no session where the reset completed while the code was being accepted', async () => {
    const { email, id, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    const token = await linkFor(email);
    const held = await holdSession();

    const attacker = secondStep(auth, step, nextCode(secret), 'totp', fresh());
    await held.reached;
    await reset(email, token);
    held.open();
    const signed = await attacker;

    expect(signed.status).toBe(401);
    expect(((await signed.json()) as { error: { code: string } }).error.code).toBe('sign_in_again');
    expect(signed.headers.getSetCookie().filter((cookie) => /session_token=[^;]/.test(cookie))).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('leaves no session where the password was changed while the code was being accepted', async () => {
    const { email, id, cookie, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    const held = await holdSession();

    const attacker = secondStep(auth, step, nextCode(secret), 'totp', fresh());
    await held.reached;
    const changed = await post(
      auth,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: OWNERS },
      { cookie, ...fresh() },
    );
    expect(changed.response.status).toBe(200);
    held.open();
    const signed = await attacker;

    expect(signed.status).toBe(401);
    // The owner's session, and no other.
    expect((await db().session.findMany({ where: { userId: id } })).length).toBe(1);
    expect(await stands(cookie)).toBe(true);
  });

  it('signs one browser in where two complete one step together', async () => {
    const { email, id, secret, recoveryCodes } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    const answers = await Promise.all([
      secondStep(auth, step, nextCode(secret), 'totp', fresh()),
      secondStep(auth, step, recoveryCodes[0], 'backup-code', fresh()),
    ]);
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401]);
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
  });

  // The time of a step is asked twice: where the step is read
  // (two-factor.test.ts), and here, where it is claimed.
  it('signs no one in where the step reached its 10 minutes while the code was being accepted', async () => {
    const { email, id, recoveryCodes } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    const stored = (await rowOf(id))!.backupCodes;
    const held = await holdSession();

    const late = secondStep(auth, step, recoveryCodes[0], 'backup-code', fresh());
    await held.reached;
    await db().verification.updateMany({
      where: { value: id },
      data: { expiresAt: new Date(Date.now() - 1) },
    });
    held.open();
    const signed = await late;

    expect(signed.status).toBe(401);
    expect(((await signed.json()) as { error: { code: string } }).error.code).toBe('sign_in_again');
    expect(signed.headers.getSetCookie().filter((cookie) => /session_token=[^;]/.test(cookie))).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // The recovery code is not spent by a sign-in that did not complete.
    expect((await rowOf(id))!.backupCodes).toBe(stored);
  });
});

describe('an endpoint that leaves a notice for after its answer, called where none can be left (FR-AU-87)', () => {
  /** Through the handler, and not as the route calls it: nothing collects. */
  const bare = (path: string, body: unknown, cookie: string) =>
    auth().handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', cookie, ...fresh() },
        body: JSON.stringify(body),
      }),
    );

  it('fails before anything is written, so that the answer of a fault is true', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const on = await enrolled();
    const before = await rowOf(on.id);
    const off = await person();
    const begun = await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie: off.cookie });
    const secret = unbase32(((await begun.response.json()) as { secret: string }).secret);

    for (const response of [
      await bare('/two-factor/disable', { password: PASSWORD, code: nextCode(on.secret) }, on.cookie),
      await bare('/two-factor/generate-backup-codes', { password: PASSWORD }, on.cookie),
      await bare('/two-factor/verify-totp', { code: nextCode(secret) }, off.cookie),
    ]) {
      expect(response.status).toBe(500);
      expect(await response.text()).toBe(INTERNAL);
    }
    expect(await rowOf(on.id)).toEqual(before);
    expect(await isOn(on.id)).toBe(true);
    expect(await isOn(off.id)).toBe(false);
    expect((await noticesTo(off.email)).length + (await noticesTo(on.email)).length).toBe(1);
  });
});
