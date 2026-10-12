// NFR-SE-17 (c), and the owner's decision R50 of 12 October 2026: every route
// that changes state refuses a request of another origin itself, since the
// proxy can be skipped (docs/operations/deployment.md). Each handler is called
// here as Next.js calls it, and NOT through the proxy, against a provisioned
// database. The identity routes and the sign-up route have their own tests of
// the same (content-type.test.ts, sign-up.test.ts); the signed admission
// routes make no such check (tests/unit/route-origin.test.ts says why).
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('route_origin');
const { auth, db, valkey } = await load();
const { proxy } = await import('../../src/proxy.ts');
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/onboarding.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const one = await import('../../src/app/api/documents/[id]/route.ts');
const restoring = await import('../../src/app/api/documents/[id]/restore/route.ts');
const acknowledgement = await import('../../src/app/api/account/onboarding/acknowledgement/route.ts');

// The proxy's answer, byte for byte (src/lib/auth/route-answers.ts).
const FORBIDDEN =
  '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}';

// What a request of another origin can hold where an `Origin` goes: those of
// the sign-up route's own test, and a request without the header, with what a
// browser says of a request across sites and without it. `undefined` is no header.
const FOREIGN: Record<string, string | undefined>[] = [
  { origin: 'https://evil.example' },
  { origin: 'null' },
  { origin: `${ORIGIN}.evil.example` },
  { origin: ORIGIN.replace('https:', 'http:') },
  { origin: '' },
  { origin: undefined },
  { origin: undefined, 'sec-fetch-site': 'cross-site' },
  { origin: undefined, 'sec-fetch-site': 'same-site' },
  // The check reads `Origin` and nothing else: not even this passes without one.
  { origin: undefined, 'sec-fetch-site': 'same-origin' },
];

let people = 0;
async function person() {
  const email = `owner${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;

const row = (id: string) => db().document.findUniqueOrThrow({ where: { id } });
const context = (id: string) => ({ params: Promise.resolve({ id }) });
const entries = (where: object = {}) => db().securityLogEntry.count({ where });

/** One route that changes state: its request, the state it would change, and its answer where it may. */
interface Case {
  name: string;
  method: string;
  body?: unknown;
  /** What exists before the request; the identifier of the document, where there is one. */
  arrange: (owner: Person) => Promise<string>;
  path: (id: string) => string;
  call: (request: Request, id: string) => Promise<Response>;
  /** The state the request would change, read from the database. */
  state: (owner: Person, id: string) => Promise<unknown>;
  status: number;
}

const live = async (owner: Person) => (await createDocument(owner.id)).id;

const CASES: Case[] = [
  {
    name: 'POST /api/documents',
    method: 'POST',
    body: {},
    arrange: async () => '',
    path: () => '/api/documents',
    call: (request) => collection.POST(request),
    state: (owner) => db().document.count({ where: { ownerId: owner.id } }),
    status: 201,
  },
  {
    name: 'PATCH /api/documents/[id]',
    method: 'PATCH',
    body: { title: 'Another' },
    arrange: live,
    path: (id) => `/api/documents/${id}`,
    call: (request, id) => one.PATCH(request, context(id)),
    state: async (_, id) => (await row(id)).title,
    status: 200,
  },
  {
    // It reads no body: nothing but the origin tells this request from another site's.
    name: 'DELETE /api/documents/[id]',
    method: 'DELETE',
    arrange: live,
    path: (id) => `/api/documents/${id}`,
    call: (request, id) => one.DELETE(request, context(id)),
    state: async (_, id) => (await row(id)).deletedAt,
    status: 204,
  },
  {
    // Nor does this.
    name: 'POST /api/documents/[id]/restore',
    method: 'POST',
    arrange: async (owner) => {
      const id = await live(owner);
      await db().document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: owner.id } });
      return id;
    },
    path: (id) => `/api/documents/${id}/restore`,
    call: (request, id) => restoring.POST(request, context(id)),
    state: async (_, id) => (await row(id)).deletedAt,
    status: 200,
  },
  {
    name: 'POST /api/account/onboarding/acknowledgement',
    method: 'POST',
    body: { version: CLOSED_ALPHA_NOTICE_VERSION },
    arrange: async () => '',
    path: () => '/api/account/onboarding/acknowledgement',
    call: (request) => acknowledgement.POST(request),
    state: (owner) =>
      db().user.findUniqueOrThrow({
        where: { id: owner.id },
        select: { closedAlphaNoticeVersion: true, closedAlphaNoticeAcknowledgedAt: true },
      }),
    status: 200,
  },
];

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a request of another origin, made to the handler itself (NFR-SE-17 (c))', () => {
  it.each(CASES.map((each, index) => [each.name, each, index] as const))(
    '%s refuses it as the proxy does and changes nothing, and answers the application’s own origin',
    async (_, each, index) => {
      const owner = await person();
      const id = await each.arrange(owner);
      // An address of its own for each route: the entry is one for each period and address.
      const from = `203.0.113.${index + 1}`;
      const send = (headers: Record<string, string | undefined>) => {
        const sent = new Headers({ 'x-forwarded-for': from });
        if (each.body !== undefined) sent.set('content-type', 'application/json');
        for (const [name, value] of Object.entries(headers)) if (value !== undefined) sent.set(name, value);
        const body = each.body === undefined ? undefined : JSON.stringify(each.body);
        return each.call(
          new Request(ORIGIN + each.path(id), { method: each.method, headers: sent, body }),
          id,
        );
      };
      const before = await each.state(owner, id);
      const logged = await entries();
      const unnamed = await entries({ kind: 'forbidden', userId: null });

      for (const foreign of FOREIGN) {
        const response = await send({ ...foreign, cookie: owner.cookie });
        expect(response.status, JSON.stringify(foreign)).toBe(403);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text(), JSON.stringify(foreign)).toBe(FORBIDDEN);
        expect(await each.state(owner, id), JSON.stringify(foreign)).toEqual(before);
      }
      // The origin comes first, as in the identity routes: without a session
      // the answer is the same 403, and not the 401 that would follow it.
      expect((await send({ origin: 'https://evil.example' })).status).toBe(403);
      expect((await send({ origin: ORIGIN })).status).toBe(401);

      // NFR-SE-19: a 403 has its entry, one for the period and the network
      // address, however many requests were refused in it, and nothing else
      // was written: no deletion, and no refusal of the document's own.
      expect((await entries()) - logged).toBe(1);
      expect((await entries({ kind: 'forbidden', userId: null })) - unnamed).toBe(1);
      const forbidden = await entries({ kind: 'forbidden' });

      // From the application's own origin the request is carried out.
      const response = await send({ origin: ORIGIN, cookie: owner.cookie });
      expect(response.status).toBe(each.status);
      expect(await each.state(owner, id)).not.toEqual(before);
      expect(await entries({ kind: 'forbidden' })).toBe(forbidden);
    },
  );
});

// One request is refused once, and logged once. A request the proxy refuses
// is answered by the proxy and is never handed to a route, so the route's
// check writes nothing for it; a request the proxy hands on has the
// application's own origin, which the route's check passes without a word.
describe('the proxy and the route together', () => {
  it('write one entry for a request the proxy refuses, and none for one it passes on', async () => {
    const owner = await person();
    const id = await live(owner);
    const through = async (origin: string) => {
      const headers = { cookie: owner.cookie, origin, 'x-forwarded-for': '203.0.113.99' };
      const init = { method: 'DELETE', headers };
      const path = `${ORIGIN}/api/documents/${id}`;
      const answer = await proxy(new NextRequest(path, init));
      // Next.js calls the route only where the proxy answered "next".
      if (answer.headers.get('x-middleware-next') !== '1') return answer;
      return one.DELETE(new Request(path, init), context(id));
    };
    const logged = await entries();
    const forbidden = await entries({ kind: 'forbidden' });

    const refused = await through('https://evil.example');
    expect(refused.status).toBe(403);
    expect(await refused.text()).toBe(FORBIDDEN);
    expect((await row(id)).deletedAt).toBeNull();
    // The proxy's entry, which names the user, and no second one of the route's.
    expect((await entries()) - logged).toBe(1);
    expect(await entries({ kind: 'forbidden', userId: owner.id })).toBe(1);

    expect((await through(ORIGIN)).status).toBe(204);
    expect((await row(id)).deletedAt).not.toBeNull();
    expect((await entries({ kind: 'forbidden' })) - forbidden).toBe(1);
  });
});
