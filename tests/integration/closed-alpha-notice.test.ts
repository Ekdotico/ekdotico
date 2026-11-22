// The Closed α notice on the server (FR-AU-55, FR-AU-56): whether the notice
// is due, and the record of an acknowledgement. The two routes are called as
// Next.js calls them, behind the proxy, against a provisioned database.
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('closed-alpha-notice', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey } = await load();
const { proxy } = await import('../../src/proxy.ts');
const { closedAlphaNoticeDue, CLOSED_ALPHA_NOTICE_VERSION } =
  await import('../../src/lib/closed-alpha-notice.ts');
const { GET } = await import('../../src/app/api/account/closed-alpha-notice/route.ts');
const { POST } = await import('../../src/app/api/account/closed-alpha-notice/acknowledgement/route.ts');

const READ = '/api/account/closed-alpha-notice';
const WRITE = '/api/account/closed-alpha-notice/acknowledgement';
const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';

const read = (cookie?: string) => GET(new Request(`${ORIGIN}${READ}`, { headers: cookie ? { cookie } : {} }));
const write = (cookie: string | undefined, body: unknown) =>
  POST(
    new Request(`${ORIGIN}${WRITE}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...(cookie ? { cookie } : {}) },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );

let people = 0;
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
const recorded = (id: string) =>
  db().user.findUniqueOrThrow({
    where: { id },
    select: { closedAlphaNoticeVersion: true, closedAlphaNoticeAcknowledgedAt: true },
  });

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(Object.keys(body)).toEqual(['error']);
  expect(Object.keys(body.error)).toEqual(['code', 'message']);
  expect(body.error.code).toBe(code);
  return body.error.message as string;
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('whether the notice is due (FR-AU-55, FR-AU-56)', () => {
  it('is due for an account that has acknowledged nothing, and reports so', async () => {
    const { id, cookie } = await person();
    expect(await closedAlphaNoticeDue(id)).toBe(true);
    const response = await read(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      currentVersion: 1,
      acknowledgedVersion: null,
      acknowledgedAt: null,
    });
  });

  it('is not due once the current version is acknowledged, in any session of the account', async () => {
    const { id, email, cookie } = await person();
    expect((await write(cookie, { version: 1 })).status).toBe(200);
    expect(await closedAlphaNoticeDue(id)).toBe(false);
    // Another session, as on another device.
    const other = cookiesOf(await signIn(auth, email));
    const { acknowledgedVersion, acknowledgedAt } = await (await read(other)).json();
    expect(acknowledgedVersion).toBe(1);
    expect(new Date(acknowledgedAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('is due again where the recorded version is lower than the current one, and only then', async () => {
    const { id } = await person();
    const at = new Date('2026-01-01T00:00:00Z');
    const set = (version: number | null) =>
      db().user.update({
        where: { id },
        data: {
          closedAlphaNoticeVersion: version,
          closedAlphaNoticeAcknowledgedAt: version === null ? null : at,
        },
      });
    await set(CLOSED_ALPHA_NOTICE_VERSION - 1);
    expect(await closedAlphaNoticeDue(id)).toBe(true);
    await set(CLOSED_ALPHA_NOTICE_VERSION);
    expect(await closedAlphaNoticeDue(id)).toBe(false);
    await set(CLOSED_ALPHA_NOTICE_VERSION + 1);
    expect(await closedAlphaNoticeDue(id)).toBe(false);
    await set(null);
    expect(await closedAlphaNoticeDue(id)).toBe(true);
  });

  it('is due where nothing can be read of the account', async () => {
    expect(await closedAlphaNoticeDue('no-such-user')).toBe(true);
  });
});

describe('the acknowledgement (FR-AU-56)', () => {
  it('records the server time and the version, for the signed-in account and for no other', async () => {
    const one = await person();
    const two = await person();
    const before = Date.now();
    const response = await write(one.cookie, { version: 1 });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answer = await response.json();
    expect(Object.keys(answer).sort()).toEqual(['acknowledgedAt', 'acknowledgedVersion', 'currentVersion']);

    const row = await recorded(one.id);
    expect(row.closedAlphaNoticeVersion).toBe(1);
    expect(row.closedAlphaNoticeAcknowledgedAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(row.closedAlphaNoticeAcknowledgedAt!.getTime()).toBeLessThanOrEqual(Date.now());
    expect(answer.acknowledgedAt).toBe(row.closedAlphaNoticeAcknowledgedAt!.toISOString());

    expect(await recorded(two.id)).toEqual({
      closedAlphaNoticeVersion: null,
      closedAlphaNoticeAcknowledgedAt: null,
    });
    expect(await closedAlphaNoticeDue(two.id)).toBe(true);
  });

  it('takes the account from the session and the time from the server, never from the request', async () => {
    const one = await person();
    const two = await person();
    for (const extra of [
      { userId: two.id },
      { acknowledgedAt: '2020-01-01T00:00:00.000Z' },
      { at: 0 },
      { currentVersion: 1 },
    ]) {
      await expectError(await write(one.cookie, { version: 1, ...extra }), 422, 'invalid_request');
    }
    expect((await recorded(one.id)).closedAlphaNoticeVersion).toBeNull();
    expect((await recorded(two.id)).closedAlphaNoticeVersion).toBeNull();
  });

  it('changes nothing when it is repeated: the time is not moved', async () => {
    const { id, cookie } = await person();
    await write(cookie, { version: 1 });
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db().user.update({ where: { id }, data: { closedAlphaNoticeAcknowledgedAt: earlier } });
    const again = await write(cookie, { version: 1 });
    expect(again.status).toBe(200);
    expect((await again.json()).acknowledgedAt).toBe(earlier.toISOString());
    expect((await recorded(id)).closedAlphaNoticeAcknowledgedAt).toEqual(earlier);
  });

  it('replaces the acknowledgement of a lower version', async () => {
    const { id, cookie } = await person();
    const earlier = new Date('2026-01-01T00:00:00Z');
    await db().user.update({
      where: { id },
      data: { closedAlphaNoticeVersion: 0, closedAlphaNoticeAcknowledgedAt: earlier },
    });
    expect((await write(cookie, { version: 1 })).status).toBe(200);
    const row = await recorded(id);
    expect(row.closedAlphaNoticeVersion).toBe(1);
    expect(row.closedAlphaNoticeAcknowledgedAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it('refuses a version other than the current one with a 409, and records nothing', async () => {
    const { id, cookie } = await person();
    for (const version of [0, 2, -1, 1_000_000]) {
      const message = await expectError(await write(cookie, { version }), 409, 'notice_version_not_current');
      expect(message).toBe(
        'The notice has changed since this page was opened. Reload the page and read the notice again.',
      );
    }
    expect(await recorded(id)).toEqual({
      closedAlphaNoticeVersion: null,
      closedAlphaNoticeAcknowledgedAt: null,
    });
    expect(await closedAlphaNoticeDue(id)).toBe(true);
  });

  it('refuses a body that is not exactly a version with a 422, and records nothing', async () => {
    const { id, cookie } = await person();
    for (const body of [
      {},
      { version: '1' },
      { version: 1.5 },
      { version: null },
      { version: true },
      [1],
      1,
      'null',
      '{"version":',
    ]) {
      const message = await expectError(await write(cookie, body), 422, 'invalid_request');
      expect(message).toBe('The request must name the version of the notice, and nothing else.');
    }
    expect((await recorded(id)).closedAlphaNoticeVersion).toBeNull();
  });

  // What a form of another site can send without the browser asking first
  // (src/lib/http.ts, `readJson`). The origin here is the application's own.
  it('refuses the version sent as anything but JSON, or in a body longer than it needs, and records nothing', async () => {
    const { id, cookie } = await person();
    const sent = (type: string | null, body = '{"version":1}') => {
      const request = new Request(`${ORIGIN}${WRITE}`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie },
        body,
      });
      if (type) request.headers.set('content-type', type);
      else request.headers.delete('content-type');
      // A browser states the length of a body, which is how a body is told from none.
      request.headers.set('content-length', String(Buffer.byteLength(body)));
      return POST(request);
    };
    // R28 (12 October 2026): a 415, as the identity routes give, and no longer a 422.
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', null]) {
      expect(await expectError(await sent(type), 415, 'invalid_request')).toBe(
        'Ekdotico could not read the request, and nothing was changed. A request to this address holds JSON, sent with the content type application/json.',
      );
    }
    await expectError(
      await sent('application/json', `{"version":1${' '.repeat(2000)}}`),
      422,
      'invalid_request',
    );
    expect((await recorded(id)).closedAlphaNoticeVersion).toBeNull();
    expect((await sent('application/json; charset=utf-8')).status).toBe(200);
    expect((await recorded(id)).closedAlphaNoticeVersion).toBe(1);
  });
});

describe('the session of the two routes (NFR-SE-02, FR-AU-07)', () => {
  it('answers 401 without a valid session, before it reads the body', async () => {
    for (const cookie of [undefined, '__Secure-better-auth.session_token=made-up.c2ln']) {
      const message = await expectError(await read(cookie), 401, 'unauthenticated');
      expect(message).toBe('This request needs a signed-in session. Sign in and try again.');
      // A body that would be a 422, and one that would be a 409: the 401 comes first.
      await expectError(await write(cookie, { nothing: true }), 401, 'unauthenticated');
      await expectError(await write(cookie, { version: 7 }), 401, 'unauthenticated');
    }
  });

  it('reads the row for the acknowledgement: a session that has ended records nothing, although its copy is fresh', async () => {
    const { id, cookie } = await person();
    await db().session.deleteMany({ where: { userId: id } });
    // The read may still be answered from the signed copy, for up to a minute (NFR-SE-17 (c)).
    expect((await read(cookie)).status).toBe(200);
    await expectError(await write(cookie, { version: 1 }), 401, 'unauthenticated');
    expect((await recorded(id)).closedAlphaNoticeVersion).toBeNull();
  });

  it('is behind the proxy: a session and, to change state, the origin of the application', async () => {
    const { id, cookie } = await person();
    const call = (method: string, path: string, headers: Record<string, string>) =>
      proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers }));
    expect((await call('GET', READ, {})).status).toBe(401);
    expect((await call('POST', WRITE, { origin: ORIGIN })).status).toBe(401);
    expect((await call('POST', WRITE, { cookie, origin: 'https://evil.example' })).status).toBe(403);
    expect((await call('POST', WRITE, { cookie })).status).toBe(403);
    expect(passed(await call('GET', READ, { cookie }))).toBe(true);
    expect(passed(await call('POST', WRITE, { cookie, origin: ORIGIN }))).toBe(true);
    expect((await recorded(id)).closedAlphaNoticeVersion).toBeNull();
  });

  it('does not ask whether the notice is acknowledged: the notice gates pages, not API routes', async () => {
    const { cookie } = await person();
    // Unacknowledged, and both routes answer.
    expect((await read(cookie)).status).toBe(200);
    expect((await write(cookie, { version: 1 })).status).toBe(200);
  });

  it('answers a fault without a word of it', async () => {
    const { cookie } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An error of the database can quote a row.
    const quoting = new Error('duplicate key: (email)=(person@example.com)');
    vi.spyOn(db().user, 'findUnique').mockRejectedValue(quoting);
    vi.spyOn(db().user, 'updateMany').mockRejectedValue(quoting);
    for (const response of [await read(cookie), await write(cookie, { version: 1 })]) {
      const message = await expectError(response, 500, 'internal');
      expect(message).toBe(
        'The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes.',
      );
    }
    expect(errors.mock.calls).toEqual([
      ['closed-alpha-notice: request failed (Error)'],
      ['closed-alpha-notice: request failed (Error)'],
    ]);
  });
});
