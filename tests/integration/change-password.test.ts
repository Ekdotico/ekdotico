// The change of the password in the account settings (FR-AU-85, FR-AU-82,
// FR-AU-87 (d); NFR-SE-17 (c); the owner's answer to Q10), through the identity
// library's handler as the route calls it, against a provisioned database,
// Valkey, and the local sink of email.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { listen, until } from './channel.ts';
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
/** The token of a reset link asked for now, from the email in the sink. */
async function linkFor(email: string): Promise<string> {
  const asked = await post(auth, '/request-password-reset', { email }, from(++linkAddresses));
  await asked.after();
  const message = (await sunk(sink))
    .filter((m) => m.to === email && m.subject === 'Set a new password for Ekdotico')
    .at(-1);
  return /\/reset-password\/([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
}
let linkAddresses = 100;

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

  // The owner's decision S6 of the pull request: "Void them at a change of
  // password too", as the completion of a reset makes void the other links.
  it('makes void every reset link of the account that is outstanding, and no link of another account', async () => {
    const { email, id, cookie } = await person();
    const stranger = await person();
    const links = [await linkFor(email), await linkFor(email)];
    expect(links[0]).not.toBe(links[1]);
    const expired = await linkFor(stranger.email);
    const theirs = await linkFor(stranger.email);
    expect(await db().verification.count({ where: { value: id } })).toBe(2);

    // A change that is refused makes nothing void.
    expect((await change(cookie, WRONG, NEW)).response.status).toBe(403);
    expect(await db().verification.count({ where: { value: id } })).toBe(2);

    expect((await change(cookie, PASSWORD, NEW)).response.status).toBe(200);
    expect(await db().verification.count({ where: { value: id } })).toBe(0);

    // The answer of a link whose hour has passed, to the character.
    const { hashToken } = await import('../../src/lib/token.ts');
    await db().verification.updateMany({
      where: { identifier: `reset-password:${hashToken(expired)}` },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const late = await post(auth, '/reset-password', {
      token: expired,
      newPassword: 'another password, long',
    });
    expect(late.response.status).toBe(409);
    const answer = await late.response.text();
    expect(answer).toContain('"code":"reset_link_not_valid"');
    for (const token of links) {
      const refused = await post(auth, '/reset-password', { token, newPassword: 'another password, long' });
      expect(refused.response.status).toBe(409);
      expect(await refused.response.text()).toBe(answer);
    }
    // The password is the one the change set, and the session in use stays.
    expect(await signsIn(email, NEW)).toBe(true);
    expect((await validateSessionRow(new Headers({ cookie }))).session).not.toBeNull();
    // The link of another account still sets its password.
    expect(
      (await post(auth, '/reset-password', { token: theirs, newPassword: 'another password, long' })).response
        .status,
    ).toBe(200);
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

  it('counts toward the 20 in an hour for the address, from wherever the wrong ones came', async () => {
    const { email, id, cookie, sessionId } = await person();
    const before = await hashOf(id);
    // Two from each of ten network addresses: none of them reaches its 5.
    for (let n = 0; n < 19; n++) {
      expect((await change(cookie, WRONG, NEW, from(100 + (n >> 1)))).response.status).toBe(403);
    }
    // Nineteen are not twenty: from a network address not yet used, a sign-in is answered.
    expect(await signsIn(email, PASSWORD, from(150))).toBe(true);
    expect((await change(cookie, WRONG, NEW, from(109))).response.status).toBe(403);

    // The limit of NFR-SE-07 is reached, for every network address: a sign-in
    // is refused, and so is the prompt with the right password, with no 429.
    expect(await signsIn(email, PASSWORD, from(151))).toBe(false);
    const held = await change(cookie, PASSWORD, NEW, from(152));
    expect(held.response.status).toBe(403);
    expect(await held.response.text()).toBe(REFUSED);
    expect(held.response.headers.get('retry-after')).toBeNull();
    expect(await hashOf(id)).toBe(before);
    expect((await validateSessionRow(new Headers({ cookie }))).session?.sessionId).toBe(sessionId);
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
    // In the one shape of an error, and in the words of the proxy's 403 (the owner's answer to Q8).
    expect(await refused.response.text()).toBe(
      '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}',
    );
    expect(await hashOf(id)).toBe(before);
    // NFR-SE-19: a 403 has its entry. The library refused before the session
    // was read, so no user is known. It does not wait for the entry.
    await vi.waitFor(async () =>
      expect((await db().securityLogEntry.findMany()).map(({ kind, userId }) => [kind, userId])).toEqual([
        ['forbidden', null],
      ]),
    );
  });
});

describe('the collaboration server is told that sessions ended (FR-ED-40 (d), NFR-SE-03 (d))', () => {
  // Weakening: the notice left out of the change, or sent before it committed.
  it('is told once the other sessions are gone, after a change of the password, and not for one that was refused', async () => {
    const channel = await listen();
    try {
      const { email, id, cookie } = await person();
      cookiesOf(await signIn(auth, email, PASSWORD, from(2)));
      const publish = valkey().publish.bind(valkey());
      const seen: number[] = [];
      vi.spyOn(valkey(), 'publish').mockImplementation((async (...given: Parameters<typeof publish>) => {
        seen.push(await db().session.count({ where: { userId: id } }));
        return publish(...given);
      }) as never);

      // Refused: the wrong current password, a new password that breaks the rules, no session.
      expect((await change(cookie, WRONG, NEW)).response.status).toBe(403);
      expect((await change(cookie, PASSWORD, 'short')).response.status).toBe(422);
      expect((await change('', PASSWORD, NEW)).response.status).toBe(401);
      await channel.quiet();
      expect(channel.about(id)).toEqual([]);

      expect((await change(cookie, PASSWORD, NEW)).response.status).toBe(200);
      await until(() => channel.sessionsEnded(id).length === 1);
      // At the moment it went out, only the session in use was left.
      expect(seen).toEqual([1]);
    } finally {
      channel.stop();
    }
  });

  it('is told once the sessions are gone, after the reset of a password, and not for a link that is no good', async () => {
    const channel = await listen();
    try {
      const { email, id } = await person();
      cookiesOf(await signIn(auth, email, PASSWORD, from(2)));
      const token = await linkFor(email);
      const publish = valkey().publish.bind(valkey());
      const seen: number[] = [];
      vi.spyOn(valkey(), 'publish').mockImplementation((async (...given: Parameters<typeof publish>) => {
        seen.push(await db().session.count({ where: { userId: id } }));
        return publish(...given);
      }) as never);

      expect(
        (await post(auth, '/reset-password', { token: 'no-such-token', newPassword: NEW })).response.status,
      ).toBe(409);
      await channel.quiet();
      expect(channel.about(id)).toEqual([]);

      const done = await post(auth, '/reset-password', { token, newPassword: NEW });
      expect(done.response.status).toBe(200);
      await until(() => channel.sessionsEnded(id).length === 1);
      expect(seen).toEqual([0]);
      await done.after();
    } finally {
      channel.stop();
    }
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
