// The content type of a request that changes state, at the two routes that
// carry no `readJson` of their own: the identity library's handler and the
// acceptance of an admission invitation. Each holds a body to
// `application/json`, as `readJson` holds every other route (src/lib/http.ts),
// and each looks at the origin first (NFR-SE-17 (c)). The routes are called as
// Next.js calls them, with no proxy in front, against a provisioned database
// and Valkey.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('contenttype');
// What the route hands to `after` of Next.js, which has no request here to run it after.
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: () => {},
}));

const { auth, db, valkey, IDENTITY_ENDPOINTS, IDENTITY_BASE_PATH } = await load();
const identity = await import('../../src/app/api/auth/[...all]/route.ts');
const signUp = await import('../../src/app/api/sign-up/route.ts');

// Written out here and not imported: the statements as they stand.
const NOT_JSON =
  '{"error":{"code":"invalid_request","message":"Ekdotico could not read the request, and nothing was changed. A request to this address holds JSON, sent with the content type application/json."}}';
const FORBIDDEN =
  '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}';
const SIGN_UP_NOT_READ =
  '{"error":{"code":"invalid","message":"The account was not created, because Ekdotico could not read the request. Reload the page and try again."}}';

// The three types a form of another site can send without asking first, one
// the library's router takes for JSON because it holds the name, and one that
// holds the name after the type.
const OTHER_TYPES = [
  'text/plain',
  'text/plain;charset=UTF-8',
  'application/x-www-form-urlencoded',
  'multipart/form-data; boundary=x',
  'x-application/json',
  'text/plain; application/json',
];

/** A POST with a body. `type` null is a body sent without a type, as a server reports it: by its length. */
const request = (path: string, type: string | null, body: string, headers: Record<string, string> = {}) => {
  const made = new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, ...headers },
    body,
  });
  if (type) made.headers.set('content-type', type);
  else {
    made.headers.delete('content-type');
    made.headers.set('content-length', String(Buffer.byteLength(body)));
  }
  return made;
};

// Every endpoint the handler serves (NFR-SE-17 (d)): none is hand-picked.
const ENDPOINTS = [...IDENTITY_ENDPOINTS].map((endpoint) => {
  const [method, path] = endpoint.split(' ');
  return [method!, `${IDENTITY_BASE_PATH}${path}`] as const;
});

let people = 0;
/** A new account with one session, as the Cookie header of its browser. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
const sessions = (userId: string) => db().session.count({ where: { userId } });

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the identity handler, by the content type of a request', () => {
  it('serves endpoints, and every one of them is a POST', () => {
    expect(ENDPOINTS.length).toBeGreaterThan(0);
    expect(ENDPOINTS.every(([method]) => method === 'POST')).toBe(true);
  });

  it.each(ENDPOINTS)('%s %s refuses a body sent as text/plain from its own origin', async (_, path) => {
    const response = await identity.POST(request(path, 'text/plain', '{}'));
    expect(response.status).toBe(415);
    expect(await response.text()).toBe(NOT_JSON);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(ENDPOINTS)(
    '%s %s does not refuse the same body for its type as application/json',
    async (_, path) => {
      for (const type of ['application/json', 'Application/JSON; charset=utf-8']) {
        const response = await identity.POST(request(path, type, '{}'));
        expect(response.status, type).not.toBe(415);
        expect(await response.text(), type).not.toBe(NOT_JSON);
      }
    },
  );

  it.each(ENDPOINTS)(
    '%s %s refuses a text/plain body of another origin for its origin: the origin is looked at first',
    async (_, path) => {
      const { cookie } = await person();
      for (const sent of [{}, { cookie }] as Record<string, string>[]) {
        const headers = { origin: 'https://evil.example', ...sent };
        const response = await identity.POST(request(path, 'text/plain', '{}', headers));
        expect(response.status).toBe(403);
        expect(await response.text()).toBe(FORBIDDEN);
        expect(response.headers.get('cache-control')).toBe('no-store');
      }
    },
  );

  it('refuses every type but application/json, and a body sent without a type', async () => {
    for (const type of [...OTHER_TYPES, null]) {
      const response = await identity.POST(request(`${IDENTITY_BASE_PATH}/sign-in/email`, type, '{}'));
      expect(response.status, String(type)).toBe(415);
      expect(await response.text(), String(type)).toBe(NOT_JSON);
    }
  });
});

describe('signing out and ending the other sessions, by the content type (FR-AU-84, FR-AU-85)', () => {
  const PATH = `${IDENTITY_BASE_PATH}/sign-out`;

  it('ends no session for a body of another type, whatever the body', async () => {
    const { id, cookie } = await person();
    for (const type of [...OTHER_TYPES, null]) {
      for (const body of ['{}', 'x=1', ' ']) {
        const response = await identity.POST(request(PATH, type, body, { cookie }));
        expect(response.status, String(type)).toBe(415);
        expect(await response.text()).toBe(NOT_JSON);
        expect(response.headers.getSetCookie()).toEqual([]);
      }
    }
    // A body without a type and without a length is sent in chunks. The
    // endpoint reads no body, so only the route refuses this one.
    const chunked = request(PATH, null, '{}', { cookie });
    chunked.headers.delete('content-length');
    chunked.headers.set('transfer-encoding', 'chunked');
    expect((await identity.POST(chunked)).status).toBe(415);
    expect(await sessions(id)).toBe(1);
  });

  it('takes the request the sign-out button sends: no body, no type, a length of 0 or none', async () => {
    // src/components/send.ts sends no body and no Content-Type where a page
    // names none; a browser then sends `Content-Length: 0`.
    for (const length of [{}, { 'content-length': '0' }] as Record<string, string>[]) {
      const { id, cookie } = await person();
      const headers = { origin: ORIGIN, cookie, ...length };
      const response = await identity.POST(new Request(`${ORIGIN}${PATH}`, { method: 'POST', headers }));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{}');
      expect(await sessions(id)).toBe(0);
    }
  });

  it('takes a sign-out sent as application/json', async () => {
    const { id, cookie } = await person();
    expect((await identity.POST(request(PATH, 'application/json', '{}', { cookie }))).status).toBe(200);
    expect(await sessions(id)).toBe(0);
  });

  it('takes the ending of the other sessions as its button sends it, and not as text/plain', async () => {
    const OTHERS = `${IDENTITY_BASE_PATH}/revoke-other-sessions`;
    const { id, email, cookie } = await person();
    await signIn(auth, email);
    expect((await identity.POST(request(OTHERS, 'text/plain', '{}', { cookie }))).status).toBe(415);
    expect(await sessions(id)).toBe(2);
    const response = await identity.POST(
      new Request(`${ORIGIN}${OTHERS}`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie, 'content-length': '0' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await sessions(id)).toBe(1);
  });
});

describe('POST /api/sign-up, by the content type of a request (FR-AU-90)', () => {
  // The token of no invitation: a body that is read is answered 409.
  const BODY = JSON.stringify({
    token: 'a'.repeat(43),
    name: 'A Person',
    password: 'a password, long enough',
  });

  it('reads no body sent as anything but application/json from its own origin', async () => {
    for (const type of [...OTHER_TYPES, null]) {
      const response = await signUp.POST(request('/api/sign-up', type, BODY));
      expect(response.status, String(type)).toBe(422);
      expect(await response.text(), String(type)).toBe(SIGN_UP_NOT_READ);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
    // No body at all is no JSON either, as it was before.
    const empty = await signUp.POST(
      new Request(`${ORIGIN}/api/sign-up`, { method: 'POST', headers: { origin: ORIGIN } }),
    );
    expect(empty.status).toBe(422);
    expect(await empty.text()).toBe(SIGN_UP_NOT_READ);
  });

  it('does not refuse the same body for its type as application/json', async () => {
    for (const type of ['application/json', 'Application/JSON; charset=utf-8']) {
      const response = await signUp.POST(request('/api/sign-up', type, BODY));
      expect(response.status, type).toBe(409);
      expect((await response.json()).error.code).toBe('invitation_not_open');
    }
  });

  it('refuses a text/plain body of another origin for its origin: the origin is looked at first', async () => {
    const response = await signUp.POST(
      request('/api/sign-up', 'text/plain', BODY, { origin: 'https://evil.example' }),
    );
    expect(response.status).toBe(403);
    expect(await response.text()).toBe(FORBIDDEN);
  });
});
