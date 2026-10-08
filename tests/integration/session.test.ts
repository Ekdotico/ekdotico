// Session validation (NFR-SE-02, FR-AU-07, FR-AU-84), against a provisioned
// database, connected as the runtime role.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, DAY, load, prepare, signIn } from './identity.ts';

const database = prepare('session');
const { auth, db, valkey, validateSession, validateSessionRow } = await load();

let userId = '';
/** A new session, as the Cookie header of its browser, with the row's identifier. */
async function begin() {
  const headers = new Headers({ cookie: cookiesOf(await signIn(auth, 'person@example.com')) });
  const { session } = await validateSessionRow(headers);
  return { headers, sessionId: session!.sessionId };
}
const rows = (id: string) => db().session.count({ where: { id } });

beforeAll(async () => {
  userId = await createAccount(auth, 'person@example.com');
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a validated session', () => {
  it('yields the user and the session, and nothing else', async () => {
    const { headers, sessionId } = await begin();
    for (const validation of [await validateSession('GET', headers), await validateSessionRow(headers)]) {
      expect(validation.session).toEqual({ userId, sessionId });
    }
  });

  it('is not the presence of a cookie (NFR-SE-02)', async () => {
    for (const cookie of [
      '',
      '__Secure-better-auth.session_token=made-up',
      '__Secure-better-auth.session_token=made-up.c2lnbmF0dXJl',
      '__Secure-better-auth.session_data=e30',
    ]) {
      const headers = new Headers(cookie ? { cookie } : {});
      expect((await validateSession('GET', headers)).session).toBeNull();
      expect((await validateSession('POST', headers)).session).toBeNull();
      expect((await validateSessionRow(headers)).session).toBeNull();
    }
  });

  it('is not a token whose signature has been cut off or changed', async () => {
    const { headers } = await begin();
    const token = /session_token=([^;]+)/.exec(headers.get('cookie')!)![1]!;
    const [value] = decodeURIComponent(token).split('.');
    for (const forged of [
      value!,
      `${value}.`,
      `${value}.AAAA`,
      encodeURIComponent(`${value}.${'A'.repeat(43)}=`),
    ]) {
      const cookie = new Headers({ cookie: `__Secure-better-auth.session_token=${forged}` });
      expect((await validateSessionRow(cookie)).session).toBeNull();
      expect((await validateSession('GET', cookie)).session).toBeNull();
    }
  });

  // Handed an undefined `id`, the deletion of an ended session would delete
  // every session there is.
  it('is not an answer of the library that lacks an identifier, and such an answer deletes nothing', async () => {
    const { headers } = await begin();
    const before = await db().session.count();
    expect(before).toBeGreaterThan(0);
    const answer = vi.spyOn(auth().api, 'getSession');
    try {
      for (const session of [
        { userId, createdAt: new Date(0) }, // no id, and long ended
        { userId, createdAt: new Date() }, // no id
        { id: 'a-session', createdAt: new Date() }, // no user
        { id: 7, userId: {}, createdAt: new Date() },
      ]) {
        answer.mockResolvedValueOnce({
          response: { session, user: {} },
          headers: new Headers({ 'set-cookie': 'renewed=1' }),
        } as never);
        expect(await validateSessionRow(headers)).toEqual({ session: null, stopped: null, setCookie: [] });
      }
    } finally {
      answer.mockRestore();
    }
    expect(await db().session.count()).toBe(before);
  });
});

describe('which requests read the row (NFR-SE-02, NFR-SE-17 (c))', () => {
  it('lets a request that only reads use the signed copy, and no other request', async () => {
    const { headers, sessionId } = await begin();
    // The session is ended elsewhere: revoked, or signed out on another device.
    await db().session.delete({ where: { id: sessionId } });

    // For up to a minute the copy still answers a read.
    expect((await validateSession('GET', headers)).session).toEqual({ userId, sessionId });
    expect((await validateSession('HEAD', headers)).session).toEqual({ userId, sessionId });
    // Every request that changes state reads the row, and is refused at once.
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE', 'get', 'ANYTHING']) {
      expect((await validateSession(method, headers)).session, method).toBeNull();
    }
  });

  it('gives the routes that read the row although they are a GET, and the collaboration server, a way to', async () => {
    const { headers, sessionId } = await begin();
    await db().session.delete({ where: { id: sessionId } });
    const validation = await validateSessionRow(headers);
    expect(validation.session).toBeNull();
    // The library asks the browser to drop the cookies of the ended session.
    expect(validation.setCookie.some((cookie) => cookie.includes('session_token=;'))).toBe(true);
  });
});

describe('the two periods of a session (FR-AU-84)', () => {
  it('refuses a session that was last renewed more than 7 days ago, and deletes it', async () => {
    const { headers, sessionId } = await begin();
    await db().session.update({ where: { id: sessionId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await validateSessionRow(headers)).session).toBeNull();
    expect(await rows(sessionId)).toBe(0);
  });

  it('renews a session at most once in 24 hours, and hands the renewed cookie on', async () => {
    const { headers, sessionId } = await begin();
    // Within the 24 hours: nothing is written.
    const before = await db().session.findUniqueOrThrow({ where: { id: sessionId } });
    await validateSessionRow(headers);
    expect((await db().session.findUniqueOrThrow({ where: { id: sessionId } })).expiresAt).toEqual(
      before.expiresAt,
    );

    // Two days after it began.
    const began = new Date(Date.now() - 2 * DAY * 1000);
    await db().session.update({
      where: { id: sessionId },
      data: { createdAt: began, updatedAt: began, expiresAt: new Date(began.getTime() + 7 * DAY * 1000) },
    });
    const validation = await validateSession('POST', headers);
    expect(validation.session).toEqual({ userId, sessionId });
    const renewed = await db().session.findUniqueOrThrow({ where: { id: sessionId } });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 7 * DAY * 1000 - 60_000);
    expect(renewed.createdAt).toEqual(began);
    expect(validation.setCookie.find((cookie) => cookie.includes('session_token'))).toContain(
      `Max-Age=${7 * DAY}`,
    );
  });

  it('refuses a session 30 days after it began, however lately it was renewed, and deletes it', async () => {
    for (const validate of [
      (headers: Headers) => validateSessionRow(headers),
      (headers: Headers) => validateSession('POST', headers),
    ]) {
      const { headers, sessionId } = await begin();
      // One minute short of 30 days: it stands.
      await db().session.update({
        where: { id: sessionId },
        data: { createdAt: new Date(Date.now() - 30 * DAY * 1000 + 60_000) },
      });
      expect((await validate(headers)).session).toEqual({ userId, sessionId });
      // One second past: refused, although it does not expire for days.
      await db().session.update({
        where: { id: sessionId },
        data: { createdAt: new Date(Date.now() - 30 * DAY * 1000 - 1000) },
      });
      const validation = await validate(headers);
      expect(validation.session).toBeNull();
      expect(validation.setCookie).toEqual([]);
      expect(await rows(sessionId)).toBe(0);
    }
  });

  it('refuses it on a read too, while the signed copy is still fresh', async () => {
    const { headers, sessionId } = await begin();
    const old = new Date(Date.now() - 31 * DAY * 1000);
    await db().session.update({ where: { id: sessionId }, data: { createdAt: old } });
    // The library signs a fresh copy, which carries the time the session began.
    const read = await auth().api.getSession({
      headers,
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const token = headers
      .get('cookie')!
      .split('; ')
      .find((cookie) => cookie.includes('session_token='));
    expect(cookiesOf(read)).toContain('session_data=');
    const copy = new Headers({ cookie: `${token}; ${cookiesOf(read)}` });
    // The row is given a new beginning, so that only the copy can refuse.
    await db().session.update({ where: { id: sessionId }, data: { createdAt: new Date() } });

    expect((await validateSession('GET', copy)).session).toBeNull();
    expect(await rows(sessionId)).toBe(0);
  });
});
