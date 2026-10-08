// Sign-out (FR-AU-84): "Signing out ends the session at once", and "the browser
// that signs out has its cookies cleared at once". Through the proxy and the
// identity library's handler, as a request travels, against a provisioned
// database and Valkey.
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('signout', {
  TRUSTED_PROXY_COUNT: '1',
  RATE_LIMIT_API_PER_USER: '3/60',
});
const { auth, db, valkey, validateSession, validateSessionRow } = await load();
const { proxy } = await import('../../src/proxy.ts');

const PATH = '/api/auth/sign-out';
/** Next.js continues to the route only on this header of the proxy's response. */
const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';
const throughProxy = (method: string, path: string, headers: Record<string, string>) =>
  proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers }));
const signOut = (headers: Record<string, string>, body?: string) =>
  auth().handler(
    new Request(`${ORIGIN}${PATH}`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body,
    }),
  );

let people = 0;
/** A new account with one session, as the Cookie header of its browser. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  const cookie = cookiesOf(await signIn(auth, email));
  const { session } = await validateSessionRow(new Headers({ cookie }));
  return { id, email, cookie, sessionId: session!.sessionId };
}
const rows = (id: string) => db().session.count({ where: { id } });

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('signing out (FR-AU-84)', () => {
  it('ends the session row at once and answers {}', async () => {
    const { cookie, sessionId, id } = await person();
    expect(passed(await throughProxy('POST', PATH, { cookie, origin: ORIGIN }))).toBe(true);
    const response = await signOut({ cookie });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{}');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
    expect(await rows(sessionId)).toBe(0);

    // Every request that reads the row refuses the old cookies at once.
    const old = new Headers({ cookie });
    expect((await validateSessionRow(old)).session).toBeNull();
    expect((await validateSession('POST', old)).session).toBeNull();
    const refused = await throughProxy('POST', '/api/documents', { cookie, origin: ORIGIN });
    expect(refused.status).toBe(401);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('clears the cookies of the browser, the signed copy included, so that it cannot use the copy', async () => {
    const { cookie } = await person();
    // The copy is what a read is validated against (NFR-SE-17 (c)).
    expect(cookie).toContain('session_data=');
    const response = await signOut({ cookie });
    const cleared = response.headers.getSetCookie();
    for (const name of ['__Secure-better-auth.session_token', '__Secure-better-auth.session_data']) {
      const header = cleared.find((each) => each.startsWith(`${name}=`));
      expect(header, name).toMatch(new RegExp(`^${name.replaceAll('.', '\\.')}=;`));
      expect(header).toContain('Max-Age=0');
      // The attributes it was set with, without which a browser keeps the cookie.
      expect(header!.toLowerCase()).toContain('path=/');
      expect(header!.toLowerCase()).toContain('secure');
    }
    // What the browser sends afterwards: a read is refused too, at once.
    const after = new Headers({ cookie: cookiesOf(response) });
    expect((await validateSession('GET', after)).session).toBeNull();
    const page = await throughProxy('GET', '/documents', { cookie: cookiesOf(response) });
    expect(passed(page)).toBe(false);
    expect(page.status).toBe(307);
  });

  it('ends this session and no other', async () => {
    const { cookie, email, id, sessionId } = await person();
    const other = cookiesOf(await signIn(auth, email));
    await signOut({ cookie });
    expect(await rows(sessionId)).toBe(0);
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
    expect((await validateSessionRow(new Headers({ cookie: other }))).session?.userId).toBe(id);
  });

  it('reads no body: nothing in one changes the answer or sends the browser anywhere', async () => {
    for (const body of ['{"callbackURL":"https://evil.example/"}', '{"anything":1}', '{}', 'not JSON']) {
      const { cookie, sessionId } = await person();
      const response = await signOut({ cookie }, body);
      expect(response.status, body).toBe(200);
      expect(await response.text()).toBe('{}');
      expect(response.headers.get('location')).toBeNull();
      expect(await rows(sessionId)).toBe(0);
    }
  });

  it('answers a browser without a session by clearing its cookies, and ends nothing', async () => {
    const { id } = await person();
    const response = await signOut({ cookie: '__Secure-better-auth.session_token=made-up.c2ln' });
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().some((each) => each.includes('session_token=;'))).toBe(true);
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
  });

  it('never answers success where the row could not be deleted', async () => {
    const { cookie, sessionId } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A fault of the database itself, and not of a function made to reject:
    // the identity library's own deletion reads the row first, takes a fault
    // of that read for an absent row, deletes nothing, and resolves.
    database.sql('ALTER TABLE "Session" RENAME TO "SessionAway"');
    let response: Response;
    try {
      response = await signOut({ cookie });
    } finally {
      database.sql('ALTER TABLE "SessionAway" RENAME TO "Session"');
    }
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await rows(sessionId)).toBe(1);
    expect(errors.mock.calls).toEqual([['identity: request failed (PrismaClientKnownRequestError P2021)']]);
    // The session stands, and the browser still holds it: it can sign out again.
    expect((await signOut({ cookie })).status).toBe(200);
    expect(await rows(sessionId)).toBe(0);
  });
});

describe('signing out, at the request-interception layer (NFR-SE-17 (c), NFR-SE-07)', () => {
  it('requires the origin of the application, like every request that changes state', async () => {
    const { cookie, id, sessionId } = await person();
    const origins: Record<string, string>[] = [{}, { origin: 'https://evil.example' }, { origin: 'null' }];
    for (const origin of origins) {
      const response = await throughProxy('POST', PATH, { cookie, ...origin });
      expect(passed(response)).toBe(false);
      expect(response.status).toBe(403);
    }
    expect(await rows(sessionId)).toBe(1);
    expect(await db().securityLogEntry.count({ where: { kind: 'forbidden', userId: id } })).toBe(3);
    // The library's handler refuses it too, were the proxy passed by.
    expect((await signOut({ cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect(await rows(sessionId)).toBe(1);
  });

  it('requires a session, and is not a GET', async () => {
    expect((await throughProxy('POST', PATH, { origin: ORIGIN })).status).toBe(401);
    const { cookie, sessionId } = await person();
    const get = await auth().handler(new Request(`${ORIGIN}${PATH}`, { headers: { cookie } }));
    expect(get.status).toBe(404);
    expect(await rows(sessionId)).toBe(1);
  });

  it('is not held back by the limit on API requests for each user', async () => {
    const { cookie, sessionId } = await person();
    for (let n = 0; n < 3; n++)
      expect(passed(await throughProxy('GET', '/api/documents', { cookie }))).toBe(true);
    expect((await throughProxy('GET', '/api/documents', { cookie })).status).toBe(429);
    // Over the limit, and still: as often as it is asked.
    for (let n = 0; n < 5; n++) {
      expect(passed(await throughProxy('POST', PATH, { cookie, origin: ORIGIN }))).toBe(true);
    }
    expect((await signOut({ cookie })).status).toBe(200);
    expect(await rows(sessionId)).toBe(0);
  });

  it('excepts that one request from the limit, and nothing near it', async () => {
    const { cookie } = await person();
    for (let n = 0; n < 3; n++) await throughProxy('GET', '/api/documents', { cookie });
    for (const [method, path] of [
      ['GET', PATH],
      ['DELETE', PATH],
      ['POST', `${PATH}/`],
      ['POST', `${PATH}/x`],
      ['POST', '/api/auth/sign-out-everywhere'],
      ['POST', '/api/auth/revoke-sessions'],
      ['POST', '/api/sign-out'],
    ] as const) {
      const response = await throughProxy(method, path, { cookie, origin: ORIGIN });
      expect(response.status, `${method} ${path}`).toBe(429);
    }
  });

  it('does not spend the limit either', async () => {
    const { cookie, email } = await person();
    for (let n = 0; n < 6; n++) await throughProxy('POST', PATH, { cookie, origin: ORIGIN });
    const again = cookiesOf(await signIn(auth, email));
    for (let n = 0; n < 3; n++) {
      expect(passed(await throughProxy('GET', '/api/documents', { cookie: again }))).toBe(true);
    }
  });
});
