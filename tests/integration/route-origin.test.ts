// NFR-SE-17 (c), and the owner's decision R50 of 12 October 2026: every route
// that changes state refuses a request of another origin itself, since the
// proxy can be skipped (docs/operations/deployment.md). Each handler is called
// here as Next.js calls it, and NOT through the proxy, against a provisioned
// database. The identity routes and the sign-up route have their own tests of
// the same (content-type.test.ts, sign-up.test.ts); the signed admission
// routes make no such check (tests/unit/route-origin.test.ts says why).
import { NextRequest } from 'next/server';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mustCheckOrigin } from '../routes.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

// Every reading of a session by a route, counted: none is made for a request
// of another origin. The functions themselves are the application's own.
const sessionReads = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../src/lib/auth/session.ts', async (original) => {
  const actual = await original<typeof import('../../src/lib/auth/session.ts')>();
  const counted =
    <Call extends (...given: never[]) => unknown>(call: Call) =>
    (...given: Parameters<Call>) => {
      sessionReads.count += 1;
      return call(...given) as ReturnType<Call>;
    };
  return {
    ...actual,
    validateSession: counted(actual.validateSession),
    validateSessionRow: counted(actual.validateSessionRow),
  };
});

const database = prepare('route_origin');
const { auth, db, valkey } = await load();
const { proxy } = await import('../../src/proxy.ts');
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/onboarding.ts');
// Every handler that changes state and must check the origin, by `route METHOD`,
// read from the route files (tests/routes.ts): a new one has no case below, and fails.
const handlers = new Map(await mustCheckOrigin());
type Handler = (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>;

// Those of them that are called, with a request of another origin, by a test of their own.
const ELSEWHERE: Record<string, string> = {
  'src/app/api/auth/[...all]/route.ts POST':
    'tests/integration/content-type.test.ts: every endpoint of the identity handler, "the origin is looked at first"',
  'src/app/api/sign-up/route.ts POST':
    'tests/integration/sign-up.test.ts: "a request from another origin (NFR-SE-17 (c))"',
};

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
  /** The handler, as tests/routes.ts names it: the route file and the method it is exported under. */
  handler: string;
  body?: unknown;
  /** What exists before the request; the identifier of the document, where there is one. */
  arrange: (owner: Person) => Promise<string>;
  path: (id: string) => string;
  /** The state the request would change, read from the database. */
  state: (owner: Person, id: string) => Promise<unknown>;
  status: number;
}

const live = async (owner: Person) => (await createDocument(owner.id)).id;

const CASES: Case[] = [
  {
    handler: 'src/app/api/documents/route.ts POST',
    body: {},
    arrange: async () => '',
    path: () => '/api/documents',
    state: (owner) => db().document.count({ where: { ownerId: owner.id } }),
    status: 201,
  },
  {
    handler: 'src/app/api/documents/[id]/route.ts PATCH',
    body: { title: 'Another' },
    arrange: live,
    path: (id) => `/api/documents/${id}`,
    state: async (_, id) => (await row(id)).title,
    status: 200,
  },
  {
    // It reads no body: nothing but the origin tells this request from another site's.
    handler: 'src/app/api/documents/[id]/route.ts DELETE',
    arrange: live,
    path: (id) => `/api/documents/${id}`,
    state: async (_, id) => (await row(id)).deletedAt,
    status: 204,
  },
  {
    // Nor does this.
    handler: 'src/app/api/documents/[id]/restore/route.ts POST',
    arrange: async (owner) => {
      const id = await live(owner);
      await db().document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: owner.id } });
      return id;
    },
    path: (id) => `/api/documents/${id}/restore`,
    state: async (_, id) => (await row(id)).deletedAt,
    status: 200,
  },
  {
    handler: 'src/app/api/account/onboarding/acknowledgement/route.ts POST',
    body: { version: CLOSED_ALPHA_NOTICE_VERSION },
    arrange: async () => '',
    path: () => '/api/account/onboarding/acknowledgement',
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
  it('has a case for every handler that changes state, here or in a test of its own', () => {
    expect([...CASES.map((each) => each.handler), ...Object.keys(ELSEWHERE)].sort()).toEqual(
      [...handlers.keys()].sort(),
    );
  });

  it.each(CASES.map((each, index) => [each.handler, each, index] as const))(
    '%s refuses it as the proxy does and changes nothing, and answers the application’s own origin',
    async (_, each, index) => {
      // The handler the route file exports, called as Next.js calls it.
      const call = handlers.get(each.handler) as Handler;
      const method = each.handler.split(' ')[1]!;
      const owner = await person();
      const id = await each.arrange(owner);
      // An address of its own for each route: the entry is one for each period and address.
      const from = `203.0.113.${index + 1}`;
      const send = (headers: Record<string, string | undefined>) => {
        const sent = new Headers({ 'x-forwarded-for': from });
        if (each.body !== undefined) sent.set('content-type', 'application/json');
        for (const [name, value] of Object.entries(headers)) if (value !== undefined) sent.set(name, value);
        const body = each.body === undefined ? undefined : JSON.stringify(each.body);
        return call(new Request(ORIGIN + each.path(id), { method, headers: sent, body }), context(id));
      };
      const before = await each.state(owner, id);
      const logged = await entries();
      const unnamed = await entries({ kind: 'forbidden', userId: null });
      const read = sessionReads.count;

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
      // And no session was read for any of them: nothing of a request of
      // another origin is looked at, not even whose it is.
      expect(sessionReads.count).toBe(read);
      expect((await send({ origin: ORIGIN })).status).toBe(401);
      expect(sessionReads.count).toBe(read + 1);

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
      const remove = handlers.get('src/app/api/documents/[id]/route.ts DELETE') as Handler;
      return remove(new Request(path, init), context(id));
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
