// The request-interception layer (NFR-SE-02, NFR-SE-05, NFR-SE-07), called as
// Next.js calls it, against a provisioned database and Valkey. Which path is
// on the list is tested in tests/unit/proxy-paths.test.ts.
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, DAY, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('proxy', {
  // One trusted proxy, so that each test can come from an address of its own.
  TRUSTED_PROXY_COUNT: '1',
  RATE_LIMIT_SESSIONLESS_PER_ADDRESS: '5/60',
  RATE_LIMIT_API_PER_USER: '4/60',
});
const { auth, db, valkey } = await load();
const { proxy } = await import('../../src/proxy.ts');

let lastAddress = 0;
/** An address no other test has used, as the one trusted proxy reports it. */
const address = () => ({ 'x-forwarded-for': `198.51.100.${++lastAddress}` });

function call(method: string, path: string, headers: Record<string, string> = {}, base = ORIGIN) {
  return proxy(new NextRequest(`${base}${path}`, { method, headers }));
}
/** Next.js continues to the route only on this header of the proxy's response. */
const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';
let people = 0;
/** A new account, signed in: each test has a user, and so a limit, of its own. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  const signedIn = async () => ({ cookie: cookiesOf(await signIn(auth, email)) });
  return { id, signedIn, cookie: await signedIn() };
}
const logged = (kind: string) => db().securityLogEntry.findMany({ where: { kind } });

async function expectError(response: Response, status: number, code: string) {
  expect(passed(response)).toBe(false);
  expect(response.status).toBe(status);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error)).toEqual(['code', 'message']);
  expect(body.error.code).toBe(code);
  expect(typeof body.error.message).toBe('string');
  return body.error.message as string;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the health check and static assets (NFR-SE-05 (c), NFR-SE-07)', () => {
  it('pass without a session, untouched and without any limit', async () => {
    for (let n = 0; n < 12; n++) {
      // Not even an address: nothing of the request is read.
      expect(passed(await call('GET', '/api/health'))).toBe(true);
      expect(passed(await call('GET', '/_next/static/chunks/main.js'))).toBe(true);
    }
    expect(passed(await call('HEAD', '/api/health'))).toBe(true);
  });

  it('answer only to a GET', async () => {
    await expectError(await call('POST', '/api/health', { origin: ORIGIN }), 401, 'unauthenticated');
    await expectError(
      await call('POST', '/_next/static/chunks/main.js', { origin: ORIGIN }),
      401,
      'unauthenticated',
    );
  });
});

describe('the pages and endpoints of a person without a session (NFR-SE-05 (a))', () => {
  it('pass without a session', async () => {
    const from = address();
    expect(passed(await call('GET', '/sign-in', from))).toBe(true);
    expect(passed(await call('GET', '/sign-up/0123456789abcdef', from))).toBe(true);
    expect(passed(await call('POST', '/api/auth/sign-in/email', { ...from, origin: ORIGIN }))).toBe(true);
    expect(passed(await call('POST', '/api/sign-up', { ...from, origin: ORIGIN }))).toBe(true);
  });

  it('are limited for each network address, with a 429 that says when to try again (NFR-SE-07)', async () => {
    const from = address();
    for (let n = 0; n < 5; n++) expect(passed(await call('GET', '/sign-in', from))).toBe(true);

    // The sixth, on any of the paths of the row.
    for (const [method, path] of [
      ['GET', '/sign-in'],
      ['GET', '/reset-password'],
      ['POST', '/api/auth/sign-in/email'],
      ['POST', '/api/sign-up'],
      ['POST', '/sign-in/link/token'],
    ] as const) {
      const response = await call(method, path, { ...from, origin: ORIGIN });
      const message = await expectError(response, 429, 'rate_limited');
      const seconds = Number(response.headers.get('retry-after'));
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(60);
      expect(message).toContain(`Try again in ${seconds} seconds.`);
    }
    // Another address is not held back by it.
    expect(passed(await call('GET', '/sign-in', address()))).toBe(true);

    // NFR-SE-19: one entry for the limit reached, not one for each refusal, and with no address.
    const entries = await logged('rate_limit_reached');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: null, documentId: null });
  });

  it('takes the address from the trusted proxy and not from what the client wrote', async () => {
    const proxyEntry = address()['x-forwarded-for'];
    for (let n = 0; n < 5; n++) {
      expect(
        passed(await call('GET', '/sign-in', { 'x-forwarded-for': `203.0.113.${n}, ${proxyEntry}` })),
      ).toBe(true);
    }
    // A sixth claim of yet another address does not lift the limit.
    expect(
      (await call('GET', '/sign-in', { 'x-forwarded-for': `203.0.113.200, ${proxyEntry}` })).status,
    ).toBe(429);
  });

  it('refuse a request that changes state from any origin but the own (NFR-SE-17 (c))', async () => {
    for (const path of ['/api/auth/sign-in/email', '/api/sign-up', '/sign-in/link/token']) {
      const from = address();
      await expectError(await call('POST', path, from), 403, 'forbidden');
      await expectError(await call('POST', path, { ...from, origin: 'null' }), 403, 'forbidden');
      await expectError(
        await call('POST', path, { ...from, origin: 'https://internal.example.test' }),
        403,
        'forbidden',
      );
      // The Referer is no substitute.
      await expectError(
        await call('POST', path, { ...from, referer: `${ORIGIN}/sign-in` }),
        403,
        'forbidden',
      );
      expect(passed(await call('POST', path, { ...from, origin: ORIGIN }))).toBe(true);
    }
    // NFR-SE-19: each 403 is logged, and there is no user to name.
    const entries = await logged('forbidden');
    expect(entries).toHaveLength(12);
    expect(entries.every((entry) => entry.userId === null)).toBe(true);
  });

  // NFR-SE-07: one IPv6 subscriber holds a whole /64, and is one count.
  it('are limited for each /64 of IPv6 addresses, not for each address in it', async () => {
    const from = (address: string) => ({ 'x-forwarded-for': address });
    for (let n = 1; n <= 5; n++) {
      expect(passed(await call('GET', '/sign-in', from(`2001:db8:1:2::${n}`)))).toBe(true);
    }
    expect((await call('GET', '/sign-in', from('2001:db8:1:2:ffff::9'))).status).toBe(429);
    // The next /64 is another subscriber.
    expect(passed(await call('GET', '/sign-in', from('2001:db8:1:3::1')))).toBe(true);
  });

  // "Counted before anything else": the refusals for the origin are bounded
  // too, and so are the entries they write to the security log.
  it('count a request before they look at its origin, so that the 403s are limited as well', async () => {
    const from = address();
    for (let n = 0; n < 5; n++) {
      await expectError(await call('POST', '/api/auth/sign-in/email', from), 403, 'forbidden');
    }
    await expectError(await call('POST', '/api/auth/sign-in/email', from), 429, 'rate_limited');
    await expectError(await call('POST', '/api/sign-up', from), 429, 'rate_limited');
    expect(await logged('forbidden')).toHaveLength(5);
  });

  it('do not read the session, so a signed-in person reaches them too', async () => {
    expect(passed(await call('GET', '/sign-in', { ...address(), ...(await person()).cookie }))).toBe(true);
  });
});

describe('the admission endpoints (NFR-SE-05 (b))', () => {
  it('pass without a session, without an Origin header, and without the limit, which the route takes', async () => {
    for (let n = 0; n < 8; n++) {
      expect(passed(await call('POST', '/api/admission/invitations'))).toBe(true);
      expect(passed(await call('GET', '/api/admission/invitations'))).toBe(true);
      expect(passed(await call('DELETE', '/api/admission/invitations/cmg1x2y3z'))).toBe(true);
    }
    expect(await db().securityLogEntry.count()).toBe(0);
  });

  it('are those three and nothing beside them', async () => {
    await expectError(await call('PUT', '/api/admission/invitations'), 401, 'unauthenticated');
    await expectError(await call('GET', '/api/admission/invitations/cmg1x2y3z'), 401, 'unauthenticated');
    await expectError(await call('GET', '/api/admission'), 401, 'unauthenticated');
    await expectError(await call('POST', '/api/admission/invitations/a/b'), 401, 'unauthenticated');
  });
});

describe('every other path, without a session (FR-AU-07)', () => {
  it('answers an API route with a 401', async () => {
    const message = await expectError(await call('GET', '/api/documents'), 401, 'unauthenticated');
    expect(message).toBe('This request needs a signed-in session. Sign in and try again.');
    await expectError(await call('POST', '/api/documents', { origin: ORIGIN }), 401, 'unauthenticated');
    await expectError(await call('GET', '/api'), 401, 'unauthenticated');
    // The presence of a cookie is not validation.
    await expectError(
      await call('GET', '/api/documents', { cookie: '__Secure-better-auth.session_token=made-up.c2ln' }),
      401,
      'unauthenticated',
    );
  });

  it('validates the endpoints of the identity library that are not on the list, like any route', async () => {
    for (const path of ['/api/auth/sign-out', '/api/auth/two-factor/enable', '/api/auth/change-password']) {
      await expectError(await call('POST', path, { origin: ORIGIN }), 401, 'unauthenticated');
    }
    await expectError(await call('GET', '/api/auth/list-sessions'), 401, 'unauthenticated');
    await expectError(await call('GET', '/api/auth/get-session'), 401, 'unauthenticated');
  });

  it('answers the 401 before it looks at the origin', async () => {
    await expectError(
      await call('POST', '/api/documents', { origin: 'https://evil.example' }),
      401,
      'unauthenticated',
    );
    expect(await db().securityLogEntry.count()).toBe(0);
  });

  it('sends the reader of a page to sign in, with the place to return to', async () => {
    const response = await call('GET', '/documents/1?tab=sharing&q=a%2Fb');
    expect(passed(response)).toBe(false);
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin + location.pathname).toBe(`${ORIGIN}/sign-in`);
    expect([...location.searchParams.keys()]).toEqual(['return']);
    expect(location.searchParams.get('return')).toBe('/documents/1?tab=sharing&q=a%2Fb');
    expect((await call('HEAD', '/')).status).toBe(307);
  });

  it('never names another origin as the place to return to, nor as the place to sign in', async () => {
    for (const path of [
      '//evil.example/x',
      '/\\evil.example/x',
      '//evil.example',
      '///evil.example//x',
      '/%5Cevil.example',
    ]) {
      const response = await call('GET', path);
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location')!);
      expect(location.origin).toBe(ORIGIN);
      const target = location.searchParams.get('return')!;
      // What a browser would make of it, were the sign-in page to send it there.
      expect(new URL(target, ORIGIN).origin, path).toBe(ORIGIN);
      expect(target.startsWith('/')).toBe(true);
      expect(target.startsWith('//')).toBe(false);
    }
    // A request that reached the process under another host name is sent to the own origin.
    const response = await call('GET', '/documents', { host: 'evil.example' }, 'https://evil.example');
    expect(response.headers.get('location')).toBe(`${ORIGIN}/sign-in?return=%2Fdocuments`);
  });

  it('answers a request that changes state on a page with a 401, not with a redirect', async () => {
    await expectError(await call('POST', '/documents/1', { origin: ORIGIN }), 401, 'unauthenticated');
  });
});

describe('every other path, with a session', () => {
  it('passes a request that reads, and one that changes state from the own origin', async () => {
    const { cookie } = await person();
    expect(passed(await call('GET', '/api/documents', cookie))).toBe(true);
    expect(passed(await call('GET', '/documents/1', cookie))).toBe(true);
    expect(passed(await call('POST', '/api/documents', { ...cookie, origin: ORIGIN }))).toBe(true);
  });

  it('hands no identity to the route in a header, so there is none to forge', async () => {
    const response = await call('GET', '/api/documents', {
      ...(await person()).cookie,
      'x-user-id': 'another-user',
    });
    expect(passed(response)).toBe(true);
    expect(response.headers.get('x-middleware-override-headers')).toBeNull();
    expect([...response.headers.keys()].filter((name) => name.startsWith('x-middleware-request-'))).toEqual(
      [],
    );
  });

  it('refuses a request that changes state from any origin but the own, and logs the user (NFR-SE-17 (c))', async () => {
    const { cookie, id: userId } = await person();
    for (const origin of [
      undefined,
      'null',
      'https://internal.example.test',
      `${ORIGIN}:8443`,
      'http://app.example.test',
    ]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await call(method, '/api/documents/1', { ...cookie, ...(origin ? { origin } : {}) });
        const message = await expectError(response, 403, 'forbidden');
        expect(message).toContain('did not come from a page of Ekdotico');
      }
    }
    // A read needs no Origin header: a browser sends none on a navigation.
    expect(passed(await call('GET', '/api/documents/1', cookie))).toBe(true);
    const entries = await logged('forbidden');
    expect(entries).toHaveLength(20);
    expect(entries.every((entry) => entry.userId === userId && entry.documentId === null)).toBe(true);
  });

  it('reads the row for a request that changes state, and may use the copy for one that reads (NFR-SE-02)', async () => {
    const { cookie, id: otherId } = await person();
    // The session is revoked.
    await db().session.deleteMany({ where: { userId: otherId } });
    expect(passed(await call('GET', '/api/documents', cookie))).toBe(true);
    const response = await call('POST', '/api/documents', { ...cookie, origin: ORIGIN });
    await expectError(response, 401, 'unauthenticated');
    // The browser is told to drop the cookies of the ended session.
    expect(response.headers.getSetCookie().some((each) => each.includes('session_token=;'))).toBe(true);
  });

  it('refuses a session 30 days after it began, and deletes it (FR-AU-84)', async () => {
    const { cookie, id: otherId } = await person();
    await db().session.updateMany({
      where: { userId: otherId },
      data: { createdAt: new Date(Date.now() - 30 * DAY * 1000 - 1000) },
    });
    await expectError(
      await call('POST', '/api/documents', { ...cookie, origin: ORIGIN }),
      401,
      'unauthenticated',
    );
    expect(await db().session.count({ where: { userId: otherId } })).toBe(0);
  });

  it('hands the renewed cookie of a session to the browser (FR-AU-84)', async () => {
    const { cookie, id: otherId } = await person();
    const began = new Date(Date.now() - 2 * DAY * 1000);
    await db().session.updateMany({
      where: { userId: otherId },
      data: { createdAt: began, updatedAt: began, expiresAt: new Date(began.getTime() + 7 * DAY * 1000) },
    });
    const response = await call('POST', '/api/documents', { ...cookie, origin: ORIGIN });
    expect(passed(response)).toBe(true);
    const renewed = response.headers.getSetCookie().find((each) => each.includes('session_token='));
    expect(renewed).toContain(`Max-Age=${7 * DAY}`);
    expect(renewed!.toLowerCase()).toContain('httponly');
  });

  it('limits the requests to API routes for each user, and not the pages (NFR-SE-07)', async () => {
    const { cookie, id: otherId, signedIn } = await person();
    for (let n = 0; n < 4; n++) expect(passed(await call('GET', '/api/documents', cookie))).toBe(true);

    for (const method of ['GET', 'POST']) {
      const response = await call(method, '/api/documents', { ...cookie, origin: ORIGIN });
      const message = await expectError(response, 429, 'rate_limited');
      expect(message).toContain(`Try again in ${response.headers.get('retry-after')} seconds.`);
      expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    // A second session of the same user is the same user.
    expect((await call('GET', '/api/documents', await signedIn())).status).toBe(429);
    // Another user, and a page, are not held back.
    expect(passed(await call('GET', '/api/documents', (await person()).cookie))).toBe(true);
    for (let n = 0; n < 6; n++) expect(passed(await call('GET', '/documents/1', cookie))).toBe(true);

    const entries = await logged('rate_limit_reached');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ userId: otherId, documentId: null });
  });

  it('does not count a request refused for its origin against the user', async () => {
    const { cookie, id } = await person();
    for (let n = 0; n < 6; n++) expect((await call('POST', '/api/documents', cookie)).status).toBe(403);
    expect(passed(await call('GET', '/api/documents', cookie))).toBe(true);
    expect((await logged('forbidden')).every((entry) => entry.userId === id)).toBe(true);
  });
});

describe('the mark of a limit that was logged (NFR-SE-19, FR-AU-05)', () => {
  // The mark lives in Valkey, where no identity data is held: its name is a
  // keyed digest of the limit and of what was limited, and nothing in clear.
  it('holds neither the address nor the user identifier', async () => {
    const before = new Set(await valkey().keys('limit-logged:*'));
    const from = address();
    const { cookie, id } = await person();
    for (let n = 0; n < 5; n++) await call('GET', '/sign-in', from);
    expect((await call('GET', '/sign-in', from)).status).toBe(429);
    for (let n = 0; n < 4; n++) await call('GET', '/api/documents', cookie);
    expect((await call('GET', '/api/documents', cookie)).status).toBe(429);

    const all = await valkey().keys('limit-logged:*');
    // One for the address and one for the user; another run may add its own meanwhile.
    const added = all.filter((name) => !before.has(name));
    expect(added.length).toBeGreaterThanOrEqual(2);
    for (const name of all) {
      expect(name).toMatch(/^limit-logged:[0-9a-f]{64}$/);
      expect(name).not.toContain(from['x-forwarded-for']);
      expect(name).not.toContain(id);
    }
    for (const name of added) expect(await valkey().get(name)).toBe('1');
  });
});

describe('where something it depends on fails (NFR-SE-06, A10)', () => {
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});

  // NFR-SE-19: the line names the stage and the class and code of the fault,
  // which tell one fault from another, and nothing the fault carried.
  async function expectClosed(response: Response, errors: ReturnType<typeof quiet>, ...lines: string[]) {
    const message = await expectError(response, 500, 'internal');
    expect(message).toBe(
      'The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes.',
    );
    expect(errors.mock.calls).toEqual(lines.map((line) => [line]));
  }

  it('refuses with a 500 that says nothing of the fault, where the database cannot answer', async () => {
    const { cookie } = await person();
    const errors = quiet();
    database.sql('ALTER TABLE "Session" RENAME TO "SessionAway"');
    try {
      await expectClosed(
        await call('POST', '/api/documents', { ...cookie, origin: ORIGIN }),
        errors,
        // The library logs the fault of the database and throws one of its
        // own in its place, so the code of the first reaches neither line.
        'identity: library reported (error)',
        'proxy: request refused at session (APIError)',
      );
    } finally {
      database.sql('ALTER TABLE "SessionAway" RENAME TO "Session"');
    }
    expect(passed(await call('POST', '/api/documents', { ...cookie, origin: ORIGIN }))).toBe(true);
  });

  // NFR-SE-06 (A10): a database that does not answer fails the request within
  // seconds. The server itself holds the 5 seconds db.ts asks for.
  it('gives a statement 5 seconds, which the database server keeps', async () => {
    expect(await db().$queryRaw`SHOW statement_timeout`).toEqual([{ statement_timeout: '5s' }]);
  });

  it('refuses where the limiter cannot answer, with a session and without one', async () => {
    const { cookie } = await person();
    const errors = quiet();
    const fault = Object.assign(new Error('connect ECONNREFUSED redis://secret@host'), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(valkey(), 'eval').mockRejectedValue(fault);
    const line = 'proxy: request refused at limit (Error ECONNREFUSED)';
    await expectClosed(await call('GET', '/sign-in', address()), errors, line);
    errors.mockClear();
    await expectClosed(await call('GET', '/api/documents', cookie), errors, line);
  });

  it('refuses where the mark of a logged limit cannot be written', async () => {
    const from = address();
    for (let n = 0; n < 5; n++) expect(passed(await call('GET', '/sign-in', from))).toBe(true);
    const errors = quiet();
    vi.spyOn(valkey(), 'set').mockRejectedValue(new Error(`no room for ${from['x-forwarded-for']}`));
    await expectClosed(
      await call('GET', '/sign-in', from),
      errors,
      'proxy: request refused at log mark (Error)',
    );
  });

  it('refuses where the validation throws anything at all', async () => {
    const errors = quiet();
    vi.spyOn(auth().api, 'getSession').mockRejectedValue('not even an error');
    const response = await call('GET', '/documents/1', (await person()).cookie);
    expect(response.status).toBe(500);
    expect(passed(response)).toBe(false);
    expect(errors.mock.calls.flat().join(' ')).toBe('proxy: request refused at session (unknown)');
  });
});
