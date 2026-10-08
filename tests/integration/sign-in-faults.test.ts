// A fault between the making of a session and the answer of its sign-in
// (FR-AU-81, FR-AU-83, FR-AU-84; the owner's decision of 9 October 2026): the
// browser is given no cookie, so the row just made could be used by no one and
// ended by no one. It is deleted before the fault is answered, and the answer
// is the 500 it was. Shown for each endpoint that makes a session first and
// claims after: the sign-in by password, the sign-in by the link of a lock
// email, and the second step.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import { enrol, nextCode, passwordStep, secondStep } from './second-factor.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-faults-mail-'));
const database = prepare('signinfaults', { TRUSTED_PROXY_COUNT: '1', EMAIL_SINK_DIRECTORY: sink });
const { auth, db, valkey } = await load();
const { beginLock } = await import('../../src/lib/auth/sign-in-lock.ts');

const INTERNAL =
  '{"error":{"code":"internal","message":"The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes."}}';
const LOST = 'the connection was lost';

let addresses = 0;
const fresh = () => ({ 'x-forwarded-for': `10.6.${Math.floor(++addresses / 250)}.${addresses % 250}` });
let people = 0;
async function person() {
  const email = `person${++people}@example.com`;
  return { email, id: await createAccount(auth, email) };
}
const sessions = (userId: string) => db().session.count({ where: { userId } });
const sessionCookies = (response: { headers: Headers }) =>
  response.headers.getSetCookie().filter((cookie) => /session_token=[^;]/.test(cookie));
/** The lines printed to the error stream, each as one text. */
const printed = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((call) => call.join(' '));

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a fault after the session of a sign-in by password was made (FR-AU-81)', () => {
  it('leaves no session of the account, sets no cookie, and answers the same 500', async () => {
    const { email, id } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The question that follows the making of the session: whether the
    // password is still the one verified (sign-in.ts, `stillVerified`).
    vi.spyOn(db().account, 'updateMany').mockRejectedValueOnce(new Error(LOST));

    const failed = await signIn(auth, email, PASSWORD, fresh());
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe(INTERNAL);
    expect(sessionCookies(failed)).toEqual([]);
    expect(await sessions(id)).toBe(0);
    // NFR-SE-19: the class of the fault, and nothing of its message.
    expect(printed(errors)).toEqual(['identity: request failed (Error)']);

    // Nothing else was changed: the same sign-in then succeeds.
    expect((await signIn(auth, email, PASSWORD, fresh())).status).toBe(200);
    expect(await sessions(id)).toBe(1);
  });

  it('keeps the session the browser already held, and ends only the one it made', async () => {
    const { email, id } = await person();
    const other = await person();
    const held = cookiesOf(await signIn(auth, other.email, PASSWORD, fresh()));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db().account, 'updateMany').mockRejectedValueOnce(new Error(LOST));

    const failed = await signIn(auth, email, PASSWORD, { ...fresh(), cookie: held });
    expect(failed.status).toBe(500);
    expect(await sessions(id)).toBe(0);
    expect(await sessions(other.id)).toBe(1);
  });

  it('answers with the first fault where the session cannot be deleted either, and prints the second by its class', async () => {
    const { email, id } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db().account, 'updateMany').mockRejectedValueOnce(new Error(LOST));
    vi.spyOn(db().session, 'deleteMany').mockRejectedValueOnce(
      Object.assign(new Error(`cannot reach the session of ${email}`), {
        name: 'PrismaClientKnownRequestError',
        code: 'P1001',
      }),
    );

    const failed = await signIn(auth, email, PASSWORD, fresh());
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe(INTERNAL);
    expect(sessionCookies(failed)).toEqual([]);
    expect(printed(errors)).toEqual([
      'sign-in: the session of a sign-in that failed was not deleted (PrismaClientKnownRequestError P1001)',
      // The fault that is answered is the first, of the plain class.
      'identity: request failed (Error)',
    ]);
    // The row could not be deleted: it stays until its period has passed.
    expect(await sessions(id)).toBe(1);
  });
});

describe('a fault in the claim of a sign-in by the link of a lock email (FR-AU-81; A104)', () => {
  it('leaves no session of the account, sets no cookie, answers the same 500, and spends nothing', async () => {
    const { email, id } = await person();
    await beginLock(email);
    const message = (await sunk(sink)).filter((each) => each.to === email).at(-1);
    const token = /\/sign-in\/link\/([A-Za-z0-9_-]+)\n/.exec(message!.text)![1]!;
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The transaction that claims the link, the next one that is opened.
    vi.spyOn(db(), '$transaction').mockRejectedValueOnce(new Error(LOST));

    const failed = await post(auth, '/sign-in/link', { token }, fresh());
    expect(failed.response.status).toBe(500);
    expect(await failed.response.text()).toBe(INTERNAL);
    expect(sessionCookies(failed.response)).toEqual([]);
    expect(await sessions(id)).toBe(0);
    expect(printed(errors)).toEqual(['identity: request failed (Error)']);

    // The lock is in force and the link unspent: it then signs the person in.
    expect((await db().user.findUniqueOrThrow({ where: { id } })).lockedUntil).not.toBeNull();
    const signed = await post(auth, '/sign-in/link', { token }, fresh());
    expect(signed.response.status).toBe(200);
    expect(await sessions(id)).toBe(1);
  });
});

describe('a fault in the claim of a second step (FR-AU-83)', () => {
  it('leaves no session of the account, sets no cookie, answers the same 500, and leaves the step open', async () => {
    const { email, id } = await person();
    const browser = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
    const { secret } = await enrol(auth, browser, fresh());
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The transaction that claims the step, the next one that is opened.
    vi.spyOn(db(), '$transaction').mockRejectedValueOnce(new Error(LOST));

    const failed = await secondStep(auth, step, nextCode(secret), 'totp', fresh());
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe(INTERNAL);
    expect(sessionCookies(failed)).toEqual([]);
    expect(await sessions(id)).toBe(0);
    expect(printed(errors)).toEqual(['identity: request failed (Error)']);

    // The step was not claimed: the next code completes the sign-in.
    const signed = await secondStep(auth, step, nextCode(secret), 'totp', fresh());
    expect(signed.status).toBe(200);
    expect(await sessions(id)).toBe(1);
  });
});
