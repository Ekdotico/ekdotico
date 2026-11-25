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
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, prepare, signIn } from './identity.ts';

// Every reading of a session by a route, counted: none is made for a request
// of another origin. The functions themselves are the application's own.
// `after` of Next.js exists only inside a request of the framework; the
// invitation routes leave their email to it. Nothing it is given runs here.
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: () => {},
}));

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
const { CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/closed-alpha-notice.ts');
const { hashToken } = await import('../../src/lib/token.ts');
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
  'src/app/api/account/documents/clear/route.ts POST':
    'tests/integration/clearing.test.ts: "answers a request without a session 401 and one from another origin 403"',
  'src/app/api/account/documents/clear/route.ts DELETE':
    'tests/integration/clearing.test.ts: "refuses a cancellation from another origin"',
  'src/app/api/account/documents/clear/[documentId]/route.ts DELETE':
    'tests/integration/clearing.test.ts: "refuses a cancellation from another origin"',
  'src/app/api/account/documents/transfer/route.ts POST':
    'tests/integration/transfer.test.ts: "answers a request without a session 401, and one from another origin 403, and offers nothing"',
  // Its body is the bytes of an image and not JSON, which the cases here send.
  'src/app/api/documents/[id]/images/route.ts POST':
    'tests/integration/image-routes.test.ts: "checks the origin before anything is read or counted"',
  // It sends the file of an archive, and reads no body.
  'src/app/api/documents/[id]/export/draft/route.ts POST':
    'tests/integration/export.test.ts: "checks the origin before anything is locked, counted or read"',
  'src/app/api/feedback/route.ts POST':
    'tests/integration/feedback-route.test.ts: "refuses a request of another origin 403 and sends nothing"',
  // Closed as a route that does not exist while FEEDBACK_INTAKE_ENABLED is off, which the cases here leave off.
  'src/app/api/account/feedback-notice/acknowledgement/route.ts POST':
    'tests/integration/feedback-notice.test.ts: "refuses a request of another origin 403 and records nothing"',
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
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
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
  /** The segments of the path, where they are more than the document's identifier. */
  params?: (id: string) => Record<string, string>;
}

const live = async (owner: Person) => (await createDocument(owner.id)).id;

// FR-ED-21: an invitation of a document of `from`, to `to`, pending, with a known token.
const TOKEN = 'A'.repeat(43);
async function invitation(from: string, to: string, token = TOKEN) {
  const documentId = (await createDocument(from)).id;
  const { id } = await db().documentInvitation.create({
    data: {
      documentId,
      email: to,
      role: 'VIEWER',
      invitedById: from,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      // Sent: an invitation sent to no one cannot be answered (FR-ED-37).
      emailClaimedAt: new Date(),
    },
  });
  return { documentId, id };
}
// FR-ED-47: a document of `from`, with `to` as its Editor, and an open offer of its ownership to `to`.
async function offered(from: string, to: string) {
  const documentId = (await createDocument(from)).id;
  await db().documentCollaborator.create({ data: { documentId, userId: to, role: 'EDITOR' } });
  const { id } = await db().ownershipOffer.create({
    data: { documentId, fromUserId: from, toUserId: to, expiresAt: new Date(Date.now() + 60 * 60 * 1000) },
  });
  return { documentId, id };
}
/** Two identifiers carried as one, for a case whose path has two. */
const pair = (id: string) => id.split(' ') as [string, string];
const invitationState = async (id: string) =>
  (await db().documentInvitation.findUniqueOrThrow({ where: { id: pair(id)[1] } })).state;

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
    handler: 'src/app/api/account/closed-alpha-notice/acknowledgement/route.ts POST',
    body: { version: CLOSED_ALPHA_NOTICE_VERSION },
    arrange: async () => '',
    path: () => '/api/account/closed-alpha-notice/acknowledgement',
    state: (owner) =>
      db().user.findUniqueOrThrow({
        where: { id: owner.id },
        select: { closedAlphaNoticeVersion: true, closedAlphaNoticeAcknowledgedAt: true },
      }),
    status: 200,
  },
  {
    // FR-AU-58: the deletion of the session's own account, which owns no document, with its password.
    handler: 'src/app/api/account/route.ts DELETE',
    body: { password: PASSWORD },
    arrange: async () => '',
    path: () => '/api/account',
    state: (owner) => db().accountDeletion.count({ where: { userId: owner.id } }),
    status: 200,
  },
  {
    handler: 'src/app/api/documents/[id]/invitations/route.ts POST',
    body: { emails: ['someone@example.com'], role: 'viewer' },
    arrange: live,
    path: (id) => `/api/documents/${id}/invitations`,
    state: (_, id) => db().documentInvitation.count({ where: { documentId: id } }),
    status: 201,
  },
  {
    // It reads no body.
    handler: 'src/app/api/documents/[id]/invitations/[invitationId]/route.ts DELETE',
    arrange: async (owner) => {
      const made = await invitation(owner.id, 'someone@example.com', `${TOKEN.slice(1)}B`);
      return `${made.documentId} ${made.id}`;
    },
    path: (id) => `/api/documents/${pair(id)[0]}/invitations/${pair(id)[1]}`,
    params: (id) => ({ id: pair(id)[0], invitationId: pair(id)[1] }),
    state: (_, id) => invitationState(id),
    status: 200,
  },
  {
    handler: 'src/app/api/documents/[id]/invitations/[invitationId]/resend/route.ts POST',
    arrange: async (owner) => {
      const made = await invitation(owner.id, 'someone@example.com', `${TOKEN.slice(1)}C`);
      return `${made.documentId} ${made.id}`;
    },
    path: (id) => `/api/documents/${pair(id)[0]}/invitations/${pair(id)[1]}/resend`,
    params: (id) => ({ id: pair(id)[0], invitationId: pair(id)[1] }),
    state: (_, id) => invitationState(id),
    status: 201,
  },
  {
    // FR-ED-38: a collaborator of the session's own document, named by the identifier of its row.
    handler: 'src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts PATCH',
    body: { role: 'viewer' },
    arrange: async (owner) => {
      const documentId = await live(owner);
      const row = await db().documentCollaborator.create({
        data: { documentId, userId: (await person()).id, role: 'EDITOR' },
      });
      return `${documentId} ${row.id}`;
    },
    path: (id) => `/api/documents/${pair(id)[0]}/collaborators/${pair(id)[1]}`,
    params: (id) => ({ id: pair(id)[0], collaboratorId: pair(id)[1] }),
    state: async (_, id) =>
      (await db().documentCollaborator.findUniqueOrThrow({ where: { id: pair(id)[1] } })).role,
    status: 200,
  },
  {
    // It reads no body.
    handler: 'src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts DELETE',
    arrange: async (owner) => {
      const documentId = await live(owner);
      const row = await db().documentCollaborator.create({
        data: { documentId, userId: (await person()).id, role: 'VIEWER' },
      });
      return `${documentId} ${row.id}`;
    },
    path: (id) => `/api/documents/${pair(id)[0]}/collaborators/${pair(id)[1]}`,
    params: (id) => ({ id: pair(id)[0], collaboratorId: pair(id)[1] }),
    state: (_, id) => db().documentCollaborator.count({ where: { id: pair(id)[1] } }),
    status: 200,
  },
  {
    // FR-ED-45: the Owner changes a cell of the permission set of the session's own document.
    handler: 'src/app/api/documents/[id]/permissions/route.ts PUT',
    body: { changes: { 'document.rename': { editor: true } } },
    arrange: live,
    path: (id) => `/api/documents/${id}/permissions`,
    state: async (_, id) => JSON.stringify((await row(id)).permissionSet),
    status: 200,
  },
  {
    // The session's account is a collaborator of another account's document, and leaves it. No body.
    handler: 'src/app/api/documents/[id]/leave/route.ts POST',
    arrange: async (owner) => {
      const documentId = await live(await person());
      await db().documentCollaborator.create({ data: { documentId, userId: owner.id, role: 'EDITOR' } });
      return documentId;
    },
    path: (id) => `/api/documents/${id}/leave`,
    state: (owner, id) => db().documentCollaborator.count({ where: { documentId: id, userId: owner.id } }),
    status: 204,
  },
  {
    // The session's account is the one invited, by another account's document.
    handler: 'src/app/api/invitations/[token]/[answer]/route.ts POST',
    arrange: async (owner) => {
      const made = await invitation((await person()).id, owner.email, `${TOKEN.slice(1)}D`);
      return `${made.documentId} ${made.id}`;
    },
    path: () => `/api/invitations/${TOKEN.slice(1)}D/accept`,
    params: () => ({ token: `${TOKEN.slice(1)}D`, answer: 'accept' }),
    state: (_, id) => invitationState(id),
    status: 200,
  },
  {
    handler: 'src/app/api/invitations/received/[invitationId]/[answer]/route.ts POST',
    arrange: async (owner) => {
      const made = await invitation((await person()).id, owner.email, `${TOKEN.slice(1)}E`);
      return `${made.documentId} ${made.id}`;
    },
    path: (id) => `/api/invitations/received/${pair(id)[1]}/decline`,
    params: (id) => ({ invitationId: pair(id)[1], answer: 'decline' }),
    state: (_, id) => invitationState(id),
    status: 200,
  },
  {
    // FR-ED-47: ownership offered to an Editor of the session's own document, named by the identifier of its row.
    handler: 'src/app/api/documents/[id]/ownership-offer/route.ts POST',
    body: { collaboratorId: 'editor-row-of-the-offer', password: PASSWORD },
    arrange: async (owner) => {
      const documentId = await live(owner);
      await db().documentCollaborator.create({
        data: { id: 'editor-row-of-the-offer', documentId, userId: (await person()).id, role: 'EDITOR' },
      });
      return documentId;
    },
    path: (id) => `/api/documents/${id}/ownership-offer`,
    state: (_, id) => db().ownershipOffer.count({ where: { documentId: id } }),
    status: 201,
  },
  {
    // It reads no body.
    handler: 'src/app/api/documents/[id]/ownership-offer/route.ts DELETE',
    arrange: async (owner) => (await offered(owner.id, (await person()).id)).documentId,
    path: (id) => `/api/documents/${id}/ownership-offer`,
    state: async (_, id) => (await db().ownershipOffer.findFirstOrThrow({ where: { documentId: id } })).state,
    status: 200,
  },
  {
    // The session's account is the Editor the offer names, by another account's document. It reads no body.
    handler: 'src/app/api/ownership-offers/[offerId]/[answer]/route.ts POST',
    arrange: async (owner) => {
      const made = await offered((await person()).id, owner.id);
      return `${made.documentId} ${made.id}`;
    },
    path: (id) => `/api/ownership-offers/${pair(id)[1]}/decline`,
    params: (id) => ({ offerId: pair(id)[1], answer: 'decline' }),
    state: async (_, id) =>
      (await db().ownershipOffer.findUniqueOrThrow({ where: { id: pair(id)[1] } })).state,
    status: 200,
  },
  {
    handler: 'src/app/api/notifications/[id]/route.ts PATCH',
    // A notification the list shows: of a pending invitation sent to the session's account.
    arrange: async (owner) => {
      const made = await invitation((await person()).id, owner.email, `${TOKEN.slice(1)}F`);
      const notification = await db().notification.create({
        data: { recipientId: owner.id, kind: 'document_invitation', payload: { invitationId: made.id } },
      });
      return notification.id;
    },
    path: (id) => `/api/notifications/${id}`,
    state: async (_, id) => (await db().notification.findUniqueOrThrow({ where: { id } })).readAt,
    status: 204,
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
        const params = each.params ? { params: Promise.resolve(each.params(id)) } : context(id);
        return call(new Request(ORIGIN + each.path(id), { method, headers: sent, body }), params as never);
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
