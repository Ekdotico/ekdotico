// The change of the password in the account settings (FR-AU-85, FR-AU-82,
// FR-AU-87 (d); NFR-SE-17 (c); the owner's answer to Q10), through the identity
// library's handler as the route calls it, against a provisioned database,
// Valkey, and the local sink of email.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-change-mail-'));
const database = prepare('changepw', { TRUSTED_PROXY_COUNT: '1', EMAIL_SINK_DIRECTORY: sink });
const { auth, db, valkey, validateSession, validateSessionRow } = await load();

// Written out here and not imported: every character is the requirement's.
// FR-AU-81, at a prompt for the password (the owner's answer to Q10).
const REFUSED =
  '{"error":{"code":"password_refused","message":"The email address or the password is not correct."}}';
const UNAUTHENTICATED =
  '{"error":{"code":"unauthenticated","message":"This request needs a signed-in session. Sign in and try again."}}';
// FR-AU-87 (d).
const NOTICE_SUBJECT = 'The password of your Ekdotico account was changed';
const NOTICE_TEXT =
  'The password of your Ekdotico account was changed. If you did not change it, set a new password from the sign-in page.';

const NEW = 'a new password, long enough';
const WRONG = 'a wrong password, long enough';
const from = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}` });

let people = 0;
/** A new account with one session, as the Cookie header of its browser. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  const cookie = cookiesOf(await signIn(auth, email, PASSWORD, from(1)));
  const { session } = await validateSessionRow(new Headers({ cookie }));
  return { id, email, cookie, sessionId: session!.sessionId };
}
const change = (cookie: string, currentPassword: unknown, newPassword: unknown, net = from(1)) =>
  post(auth, '/change-password', { currentPassword, newPassword }, { cookie, ...net });
const signsIn = async (email: string, password: string, net = from(9)) =>
  (await signIn(auth, email, password, net)).status === 200;
const notices = async (email: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject === NOTICE_SUBJECT);
const hashOf = async (userId: string) =>
  (await db().account.findFirstOrThrow({ where: { userId } })).password;

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a change of the password (FR-AU-85)', () => {
  it('sets the new password, answers {} with no token, and keeps the session in use', async () => {
    const { email, id, cookie, sessionId } = await person();
    const done = await change(cookie, PASSWORD, NEW);
    expect(done.response.status).toBe(200);
    const body = await done.response.text();
    expect(body).toBe('{}');
    expect(done.response.headers.get('cache-control')).toBe('no-store');
    // The session is the cookie the browser already holds: none is set, and none cleared.
    expect(done.response.headers.getSetCookie()).toEqual([]);

    expect((await validateSessionRow(new Headers({ cookie }))).session?.sessionId).toBe(sessionId);
    expect(await signsIn(email, NEW)).toBe(true);
    expect(await signsIn(email, PASSWORD)).toBe(false);
    expect(await hashOf(id)).not.toContain(NEW);
    expect(await db().securityLogEntry.count({ where: { kind: 'forbidden' } })).toBe(0);
  });

  it('ends every other session of the account, at once, and no session of another account', async () => {
    const { email, id, cookie, sessionId } = await person();
    const others = [
      cookiesOf(await signIn(auth, email, PASSWORD, from(2))),
      cookiesOf(await signIn(auth, email, PASSWORD, from(3))),
    ];
    const stranger = await person();
    expect(await db().session.count({ where: { userId: id } })).toBe(3);

    expect((await change(cookie, PASSWORD, NEW)).response.status).toBe(200);

    expect((await db().session.findMany({ where: { userId: id } })).map((row) => row.id)).toEqual([
      sessionId,
    ]);
    for (const other of others) {
      expect((await validateSessionRow(new Headers({ cookie: other }))).session).toBeNull();
      // Refused at once by a request that changes state.
      expect((await change(other, NEW, 'yet another password, long')).response.status).toBe(401);
    }
    expect(await signsIn(email, NEW)).toBe(true);
    expect((await validateSessionRow(new Headers({ cookie: stranger.cookie }))).session?.userId).toBe(
      stranger.id,
    );
  });

  it('sends the notice of a changed password, with its fixed text, after the answer', async () => {
    const { email, cookie } = await person();
    const done = await change(cookie, PASSWORD, NEW);
    expect(done.response.status).toBe(200);
    expect(await notices(email)).toHaveLength(0);
    expect(done.left).toBe(1);
    await done.after();
    const sent = await notices(email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(NOTICE_TEXT);
  });
});

describe('the current password (FR-AU-85; the owner’s answer to Q10)', () => {
  it('is required: a wrong one is refused with the one statement, and nothing changes', async () => {
    const { email, id, cookie, sessionId } = await person();
    const other = cookiesOf(await signIn(auth, email, PASSWORD, from(2)));
    const before = await hashOf(id);

    for (const current of [WRONG, '', NEW, PASSWORD.toUpperCase(), 'x'.repeat(5000)]) {
      const refused = await change(cookie, current, NEW);
      expect(refused.response.status).toBe(403);
      expect(await refused.response.text()).toBe(REFUSED);
      expect(refused.response.headers.getSetCookie()).toEqual([]);
      expect(refused.left).toBe(0);
    }
    expect(await hashOf(id)).toBe(before);
    expect(await signsIn(email, PASSWORD)).toBe(true);
    // The person stays signed in, here and in the other browser.
    expect((await validateSessionRow(new Headers({ cookie }))).session?.sessionId).toBe(sessionId);
    expect((await validateSessionRow(new Headers({ cookie: other }))).session?.userId).toBe(id);
    expect(await notices(email)).toHaveLength(0);
    // NFR-SE-19: a 403, with the user and nothing else.
    const entries = await db().securityLogEntry.findMany();
    expect(entries.map(({ kind, userId }) => [kind, userId])).toEqual(Array(5).fill(['forbidden', id]));
  });

  it('counts each wrong one as a failed sign-in, and is then refused like one, the right password included', async () => {
    const { email, id, cookie, sessionId } = await person();
    const before = await hashOf(id);
    for (let n = 0; n < 4; n++) expect((await change(cookie, WRONG, NEW, from(5))).response.status).toBe(403);
    // Four are not five: a sign-in from that network address is still answered.
    expect(await signsIn(email, PASSWORD, from(5))).toBe(true);
    expect((await change(cookie, WRONG, NEW, from(5))).response.status).toBe(403);

    // The limit of NFR-SE-07 is reached: a sign-in is refused, and so is the
    // prompt with the right password, in the same words, with no 429.
    expect(await signsIn(email, PASSWORD, from(5))).toBe(false);
    const held = await change(cookie, PASSWORD, NEW, from(5));
    expect(held.response.status).toBe(403);
    expect(await held.response.text()).toBe(REFUSED);
    expect(held.response.headers.get('retry-after')).toBeNull();
    expect(await hashOf(id)).toBe(before);
    // "And stays signed in."
    expect((await validateSessionRow(new Headers({ cookie }))).session?.sessionId).toBe(sessionId);
    // From another network address the prompt is answered.
    expect((await change(cookie, PASSWORD, NEW, from(6))).response.status).toBe(200);
  });

  it('is verified before anything is said of the new password', async () => {
    const { cookie } = await person();
    const refused = await change(cookie, WRONG, 'short');
    expect(refused.response.status).toBe(403);
    expect(await refused.response.text()).toBe(REFUSED);
  });
});

describe('the new password (FR-AU-82)', () => {
  it('is judged by the rules, the rule not met is named, and nothing changes', async () => {
    const { email, id, cookie } = await person();
    const other = cookiesOf(await signIn(auth, email, PASSWORD, from(2)));
    const before = await hashOf(id);
    for (const [password, rule] of [
      ['short', 'A password has at least 8 characters. Choose a longer one.'],
      ['x'.repeat(33), 'A password has at most 32 characters. Choose a shorter one.'],
      [
        `the ${email} one`,
        'A password cannot contain your email address or the part of it before the @ sign, because that makes it easier to guess. Choose a different one.',
      ],
      [
        'PasswordPassword',
        'This password is on a list of commonly used and known-compromised passwords, so it cannot be used. Choose a different one.',
      ],
    ] as const) {
      const refused = await change(cookie, PASSWORD, password);
      expect(refused.response.status, password).toBe(422);
      expect(await refused.response.json()).toEqual({
        error: {
          code: 'invalid',
          message:
            'The password was not changed, because the new password does not meet its rule. Change what is marked and try again.',
          fields: { newPassword: rule },
        },
      });
      expect(refused.left).toBe(0);
    }
    expect(await hashOf(id)).toBe(before);
    expect((await validateSessionRow(new Headers({ cookie: other }))).session?.userId).toBe(id);
  });
});

describe('what the request may say (API design: "any other field is refused")', () => {
  it.each([
    // The library's own field, by which a request would choose to keep the other sessions.
    [
      'revokeOtherSessions: false',
      { currentPassword: PASSWORD, newPassword: NEW, revokeOtherSessions: false },
    ],
    ['a field of no meaning', { currentPassword: PASSWORD, newPassword: NEW, anything: null }],
    ['no current password', { newPassword: NEW }],
    ['no new password', { currentPassword: PASSWORD }],
    ['a password that is not text', { currentPassword: PASSWORD, newPassword: 12345678 }],
    ['a list', [PASSWORD, NEW]],
  ])('refuses a body with %s, and changes nothing', async (_name, body) => {
    const { email, id, cookie } = await person();
    const other = cookiesOf(await signIn(auth, email, PASSWORD, from(2)));
    const refused = await post(auth, '/change-password', body, { cookie, ...from(1) });
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request must hold the current password and a new password, and nothing else.',
      },
    });
    expect(await signsIn(email, PASSWORD)).toBe(true);
    expect((await validateSessionRow(new Headers({ cookie: other }))).session?.userId).toBe(id);
  });
});

describe('the session of the request (NFR-SE-17 (c), FR-AU-07)', () => {
  it('is required, before anything is said of the body', async () => {
    for (const headers of [{}, { cookie: '__Secure-better-auth.session_token=made-up.c2ln' }] as Record<
      string,
      string
    >[]) {
      for (const body of [{ currentPassword: PASSWORD, newPassword: NEW }, { nothing: 1 }]) {
        const refused = await post(auth, '/change-password', body, headers);
        expect(refused.response.status).toBe(401);
        expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      }
    }
  });

  it('is read from its row: a session that has ended changes nothing, though its signed copy still reads', async () => {
    const { email, id, cookie, sessionId } = await person();
    const before = await hashOf(id);
    // Ended elsewhere: the row is gone, and the browser still holds both cookies.
    await db().session.delete({ where: { id: sessionId } });
    expect(cookie).toContain('session_data=');
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);

    const refused = await change(cookie, PASSWORD, NEW);
    expect(refused.response.status).toBe(401);
    expect(await refused.response.text()).toBe(UNAUTHENTICATED);
    expect(await hashOf(id)).toBe(before);
    expect(await signsIn(email, PASSWORD)).toBe(true);
  });

  it('is refused 30 days after it began, whatever its renewal (FR-AU-84)', async () => {
    const { id, cookie, sessionId } = await person();
    const before = await hashOf(id);
    await db().session.update({
      where: { id: sessionId },
      data: { createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1000) },
    });
    expect((await change(cookie, PASSWORD, NEW)).response.status).toBe(401);
    expect(await hashOf(id)).toBe(before);
  });

  it('is refused by the library where the request comes from another origin', async () => {
    const { id, cookie } = await person();
    const before = await hashOf(id);
    const refused = await post(
      auth,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: NEW },
      { cookie, origin: 'https://evil.example' },
    );
    expect(refused.response.status).toBe(403);
    expect(await hashOf(id)).toBe(before);
  });
});

describe('what is logged (NFR-SE-19)', () => {
  it('writes nothing to the console, and no password anywhere', async () => {
    const { cookie } = await person();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');

    await change(cookie, WRONG, NEW);
    await change(cookie, PASSWORD, 'short');
    await (await change(cookie, PASSWORD, NEW)).after();

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    const stored = database.sql('SELECT * FROM "SecurityLogEntry"');
    for (const secret of [WRONG, NEW, PASSWORD, 'example.com']) expect(stored).not.toContain(secret);
  });
});
