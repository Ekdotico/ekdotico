// The list of an account's sessions and the ending of them (FR-AU-85, FR-AU-84;
// NFR-SE-17 (c); NFR-RE-15), through the identity library's handler as the
// route calls it, against a provisioned database and Valkey.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { listen, until } from './channel.ts';
import { cookiesOf, createAccount, DAY, load, ORIGIN, PASSWORD, post, prepare, signIn } from './identity.ts';

const database = prepare('sessionlist', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey, validateSession, validateSessionRow } = await load();
const { listSessions, deleteEndedSessions } = await import('../../src/lib/auth/session-list.ts');

const UNAUTHENTICATED =
  '{"error":{"code":"unauthenticated","message":"This request needs a signed-in session. Sign in and try again."}}';
// The application's own words (the owner's answer to Q6 of the plan).
const NOT_FOUND =
  '{"error":{"code":"session_not_found","message":"This session has already ended. Reload the page to see the sessions that have not."}}';

const FIREFOX_ON_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0';
const CHROME_ON_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let people = 0;
let browsers = 0;
/** One more browser signed in to the account: its Cookie header, and its session. */
async function browser(email: string, userAgent = FIREFOX_ON_MAC) {
  const response = await signIn(auth, email, PASSWORD, {
    'x-forwarded-for': `198.51.100.${(++browsers % 250) + 1}`,
    'user-agent': userAgent,
  });
  const cookie = cookiesOf(response);
  const { session } = await validateSessionRow(new Headers({ cookie }));
  const token = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)![1]!).split('.')[0]!;
  return { cookie, sessionId: session!.sessionId, token };
}
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, ...(await browser(email)) };
}
const revoke = (cookie: string, id: unknown) => post(auth, '/revoke-session', { id }, { cookie });
const revokeOthers = (cookie: string, headers: Record<string, string> = {}) =>
  post(auth, '/revoke-other-sessions', undefined, { cookie, ...headers });
const rows = (userId: string) => db().session.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
const stands = async (cookie: string) => (await validateSessionRow(new Headers({ cookie }))).session !== null;

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the list of sessions (FR-AU-85)', () => {
  it('holds, for each, when it began, when it was last renewed, the browser and the system, and which is in use', async () => {
    const { id, email, sessionId } = await person();
    const second = await browser(email, CHROME_ON_WINDOWS);
    const renewed = new Date(Date.now() - 60_000);
    const began = new Date(Date.now() - 2 * DAY * 1000);
    await db().session.update({
      where: { id: second.sessionId },
      data: { createdAt: began, updatedAt: renewed },
    });

    const list = await listSessions(id, sessionId);
    // The newest first.
    expect(list.map((session) => session.id)).toEqual([sessionId, second.sessionId]);
    expect(list[0]).toMatchObject({ browser: 'Firefox', system: 'macOS', current: true });
    expect(list[1]).toEqual({
      id: second.sessionId,
      beganAt: began.toISOString(),
      renewedAt: renewed.toISOString(),
      browser: 'Chrome',
      system: 'Windows',
      current: false,
    });
    // Seen from the other browser, the other one is in use.
    expect((await listSessions(id, second.sessionId)).map((session) => session.current)).toEqual([
      false,
      true,
    ]);
  });

  it('never holds a token, a network address, or the header a browser sent', async () => {
    const { id, email, sessionId } = await person();
    await browser(email, CHROME_ON_WINDOWS);
    const list = await listSessions(id, sessionId);
    expect(list).toHaveLength(2);
    for (const session of list) {
      expect(Object.keys(session).sort()).toEqual([
        'beganAt',
        'browser',
        'current',
        'id',
        'renewedAt',
        'system',
      ]);
    }
    const sent = JSON.stringify(list);
    for (const row of await rows(id)) {
      expect(row.ipAddress).toMatch(/^198\.51\.100\./);
      for (const secret of [row.token, row.ipAddress!, row.userAgent!]) expect(sent).not.toContain(secret);
    }
    // And the token is not read from the database for it at all.
    const read = vi.spyOn(db().session, 'findMany');
    await listSessions(id, sessionId);
    expect(read.mock.calls[0]![0]!.select).toEqual({
      id: true,
      createdAt: true,
      updatedAt: true,
      userAgent: true,
    });
  });

  it('holds the sessions of this account alone, and none that has ended', async () => {
    const { id, email, sessionId } = await person();
    const stranger = await person();
    const idle = await browser(email);
    const old = await browser(email);
    // FR-AU-84: 7 days without a renewal, and 30 days whatever its use.
    await db().session.update({
      where: { id: idle.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await db().session.update({
      where: { id: old.sessionId },
      data: { createdAt: new Date(Date.now() - 30 * DAY * 1000 - 1000) },
    });

    expect((await listSessions(id, sessionId)).map((session) => session.id)).toEqual([sessionId]);
    expect((await listSessions(stranger.id, stranger.sessionId)).map((session) => session.id)).toEqual([
      stranger.sessionId,
    ]);
  });
});

describe('ending one session (FR-AU-85)', () => {
  it('ends another session of the account by its identifier, which is refused at once where a row is read', async () => {
    const { id, email, cookie, sessionId } = await person();
    const other = await browser(email);

    const done = await revoke(cookie, other.sessionId);
    expect(done.response.status).toBe(200);
    expect(await done.response.text()).toBe('{}');
    expect(done.response.headers.get('cache-control')).toBe('no-store');
    expect(done.response.headers.getSetCookie()).toEqual([]);

    expect((await rows(id)).map((row) => row.id)).toEqual([sessionId]);
    const ended = new Headers({ cookie: other.cookie });
    expect((await validateSessionRow(ended)).session).toBeNull();
    expect((await validateSession('POST', ended)).session).toBeNull();
    // Through the endpoints themselves: the ended session ends and changes nothing.
    expect((await revoke(other.cookie, sessionId)).response.status).toBe(401);
    expect((await revokeOthers(other.cookie)).response.status).toBe(401);
    expect(
      (
        await post(
          auth,
          '/change-password',
          { currentPassword: PASSWORD, newPassword: 'a new password, long enough' },
          { cookie: other.cookie },
        )
      ).response.status,
    ).toBe(401);
    expect(await stands(cookie)).toBe(true);
  });

  it('refuses the session of another account as it refuses one that does not exist, and ends nothing', async () => {
    const { cookie } = await person();
    const stranger = await person();

    const ofStranger = await revoke(cookie, stranger.sessionId);
    const unknown = await revoke(cookie, 'no-such-session');
    const malformed = [
      await revoke(cookie, 'a\u0000b'),
      await revoke(cookie, 'x'.repeat(5000)),
      await revoke(cookie, ''),
    ];
    for (const refused of [ofStranger, unknown, ...malformed]) {
      expect(refused.response.status).toBe(404);
      expect(await refused.response.text()).toBe(NOT_FOUND);
      expect(refused.response.headers.getSetCookie()).toEqual([]);
    }
    expect(await stands(stranger.cookie)).toBe(true);
    expect(await db().session.count({ where: { userId: stranger.id } })).toBe(1);
  });

  it('names a session by its identifier and never by its token', async () => {
    const { id, email, cookie } = await person();
    const other = await browser(email);
    expect(other.token).not.toBe(other.sessionId);
    // The library's own endpoint took the token; this one does not know it.
    const byToken = await revoke(cookie, other.token);
    expect(byToken.response.status).toBe(404);
    const asTheLibraryNamedIt = await post(auth, '/revoke-session', { token: other.token }, { cookie });
    expect(asTheLibraryNamedIt.response.status).toBe(422);
    expect(await db().session.count({ where: { userId: id } })).toBe(2);
    expect(await stands(other.cookie)).toBe(true);
  });

  it('ends the session in use too, and clears the cookies of its browser', async () => {
    const { id, email, cookie, sessionId } = await person();
    const other = await browser(email);
    const done = await revoke(cookie, sessionId);
    expect(done.response.status).toBe(200);
    const cleared = done.response.headers.getSetCookie();
    for (const name of ['session_token', 'session_data']) {
      expect(cleared.find((each) => each.includes(`${name}=;`))).toContain('Max-Age=0');
    }
    expect((await rows(id)).map((row) => row.id)).toEqual([other.sessionId]);
    expect(
      (await validateSession('GET', new Headers({ cookie: cookiesOf(done.response) }))).session,
    ).toBeNull();
  });

  it('answers a session that was ended twice as one that is not found', async () => {
    const { email, cookie } = await person();
    const other = await browser(email);
    expect((await revoke(cookie, other.sessionId)).response.status).toBe(200);
    const again = await revoke(cookie, other.sessionId);
    expect(again.response.status).toBe(404);
    expect(await again.response.text()).toBe(NOT_FOUND);
  });

  it.each([
    ['no identifier', {}],
    ['an identifier that is not text', { id: 7 }],
    ['a list of identifiers', { id: ['a', 'b'] }],
    ['an extra field', { id: 'x', all: true }],
  ])('refuses %s with a 422', async (_name, body) => {
    const { id, email, cookie } = await person();
    await browser(email);
    const refused = await post(auth, '/revoke-session', body, { cookie });
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: { code: 'invalid_request', message: 'The request must name one session, and nothing else.' },
    });
    expect(await db().session.count({ where: { userId: id } })).toBe(2);
  });
});

describe('ending all but the session in use (FR-AU-85)', () => {
  it('ends every other session of the account in one action, and no session of another account', async () => {
    const { id, email, cookie, sessionId } = await person();
    const others = [await browser(email), await browser(email), await browser(email)];
    const stranger = await person();

    const done = await revokeOthers(cookie);
    expect(done.response.status).toBe(200);
    expect(await done.response.text()).toBe('{}');
    expect(done.response.headers.getSetCookie()).toEqual([]);

    expect((await rows(id)).map((row) => row.id)).toEqual([sessionId]);
    for (const other of others) expect(await stands(other.cookie)).toBe(false);
    expect(await stands(cookie)).toBe(true);
    expect(await stands(stranger.cookie)).toBe(true);
    // Again, with nothing left to end.
    expect((await revokeOthers(cookie)).response.status).toBe(200);
  });

  it('reads no body: nothing in one changes what is ended', async () => {
    const { id, email, cookie, sessionId } = await person();
    await browser(email);
    const done = await post(auth, '/revoke-other-sessions', { all: true, keep: [] }, { cookie });
    expect(done.response.status).toBe(200);
    expect((await rows(id)).map((row) => row.id)).toEqual([sessionId]);
  });
});

describe('the session of the request (NFR-SE-17 (c), FR-AU-07)', () => {
  it('is required by both endpoints, before anything is said of the body', async () => {
    const victim = await person();
    for (const headers of [{}, { cookie: '__Secure-better-auth.session_token=made-up.c2ln' }] as Record<
      string,
      string
    >[]) {
      for (const [path, body] of [
        ['/revoke-session', { id: victim.sessionId }],
        ['/revoke-session', { nothing: 1 }],
        ['/revoke-other-sessions', undefined],
      ] as const) {
        const refused = await post(auth, path, body, headers);
        expect(refused.response.status, path).toBe(401);
        expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      }
    }
    expect(await stands(victim.cookie)).toBe(true);
  });

  it('is read from its row: a session that has ended ends nothing, though its signed copy still reads', async () => {
    const { id, email, cookie, sessionId } = await person();
    const other = await browser(email);
    await db().session.delete({ where: { id: sessionId } });
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);

    expect((await revoke(cookie, other.sessionId)).response.status).toBe(401);
    expect((await revokeOthers(cookie)).response.status).toBe(401);
    expect(await stands(other.cookie)).toBe(true);
  });

  it('is refused by the library where the request comes from another origin, and is no GET', async () => {
    const { email, cookie } = await person();
    const other = await browser(email);
    expect((await revokeOthers(cookie, { origin: 'https://evil.example' })).response.status).toBe(403);
    for (const path of ['/revoke-session', '/revoke-other-sessions', '/list-sessions', '/revoke-sessions']) {
      const get = await auth().handler(new Request(`${ORIGIN}/api/auth${path}`, { headers: { cookie } }));
      expect(get.status, path).toBe(404);
    }
    expect(await stands(other.cookie)).toBe(true);
  });
});

describe('the collaboration server is told that sessions ended (FR-ED-40 (d), NFR-SE-03 (d))', () => {
  // Weakening: the notice left out of either endpoint.
  it('is told once for the end of one session and once for the end of the others, by the user alone', async () => {
    const channel = await listen();
    try {
      const { id, email, cookie } = await person();
      const other = await browser(email);
      const stranger = await person();

      expect((await revoke(cookie, other.sessionId)).response.status).toBe(200);
      await until(() => channel.sessionsEnded(id).length === 1);
      const more = await browser(email);
      expect(more.sessionId).toBeTruthy();
      expect((await revokeOthers(cookie)).response.status).toBe(200);
      await until(() => channel.sessionsEnded(id).length === 2);
      expect(channel.about(id)).toEqual([
        `{"kind":"session-ended","userId":"${id}"}`,
        `{"kind":"session-ended","userId":"${id}"}`,
      ]);

      // A session of another account is not found, ends nothing, and is told of to no one.
      expect((await revoke(cookie, stranger.sessionId)).response.status).toBe(404);
      await channel.quiet();
      expect(channel.about(stranger.id)).toEqual([]);
      expect(channel.about(id)).toHaveLength(2);
    } finally {
      channel.stop();
    }
  });
});

describe('the removal of ended sessions (NFR-RE-15, FR-AU-84)', () => {
  it('removes the rows that either period has ended and no other, and a second run finds nothing', async () => {
    // What the tests above left ended.
    await deleteEndedSessions();
    const { id, email, sessionId } = await person();
    const idle = await browser(email);
    const old = await browser(email);
    const stranger = await person();
    await db().session.update({
      where: { id: idle.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await db().session.update({
      where: { id: old.sessionId },
      data: { createdAt: new Date(Date.now() - 30 * DAY * 1000 - 1000) },
    });

    // Two instances at once, then one again: the effect once, and no error.
    const removed = await Promise.all([deleteEndedSessions(), deleteEndedSessions()]);
    expect(removed.reduce((sum, count) => sum + count, 0)).toBe(2);
    expect(await deleteEndedSessions()).toBe(0);
    expect((await rows(id)).map((row) => row.id)).toEqual([sessionId]);
    expect(await db().session.count({ where: { userId: stranger.id } })).toBe(1);
  });

  it('is among the timers of the application, each of which two instances run at once without an error', async () => {
    const { TIMERS } = await import('../../src/lib/timers.ts');
    expect(Object.keys(TIMERS)).toEqual([
      'security-log-deletion',
      'ended-session-removal',
      'expired-token-removal',
    ]);
    const { email, sessionId } = await person();
    const idle = await browser(email);
    await db().session.update({
      where: { id: idle.sessionId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await db().verification.create({
      data: { id: 'expired', identifier: 'reset-password:x', value: 'u', expiresAt: new Date(0) },
    });

    await Promise.all(Object.values(TIMERS).flatMap((run) => [run(), run()]));
    expect(await db().session.count({ where: { id: idle.sessionId } })).toBe(0);
    expect(await db().session.count({ where: { id: sessionId } })).toBe(1);
    expect(await db().verification.count()).toBe(0);
  });
});
