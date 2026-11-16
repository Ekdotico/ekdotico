// The transfer of ownership (FR-ED-47, FR-ED-40 (h), FR-ED-42, FR-AU-13;
// NFR-SE-04, NFR-SE-17 (c), NFR-SE-19, NFR-RE-15): the routes as Next.js calls
// them, against a provisioned database and the real Valkey, whose channel
// (FR-ED-40) a subscriber of the test listens on. Each test of a security rule
// names the weakening that makes it fail. What an acceptance does to an open
// connection is in collab-ownership.test.ts.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { until } from './channel.ts';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, prepare, signIn, sunk } from './identity.ts';

// `after` of Next.js exists only inside a request of the framework: what a route leaves for after its
// response is collected here and run by the test when it wants it, so that "after" can be told from "before".
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const MAIL = join(tmpdir(), `ekdotico-ownership-mail-${randomUUID()}`);
const database = prepare('ownership', {
  EMAIL_SINK_DIRECTORY: MAIL,
  RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600',
});
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { deleteDocument } = await import('../../src/lib/documents/deletion.ts');
const { lockDocument } = await import('../../src/lib/documents/sharing.ts');
const { answerOffer, deliverOffer, deliverUnsentOffers, expireOffers } =
  await import('../../src/lib/documents/ownership.ts');
const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
const offering = await import('../../src/app/api/documents/[id]/ownership-offer/route.ts');
const answering = await import('../../src/app/api/ownership-offers/[offerId]/[answer]/route.ts');
const one = await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
const leaving = await import('../../src/app/api/documents/[id]/leave/route.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const notifications = await import('../../src/app/api/notifications/route.ts');
const notification = await import('../../src/app/api/notifications/[id]/route.ts');

// ── Valkey: what is published ───────────────────────────────────────────────

const heard: string[] = [];
const subscriber = new Redis(process.env.VALKEY_URL!);
beforeAll(async () => {
  subscriber.on('message', (_channel, message) => void heard.push(message));
  await subscriber.subscribe(COLLAB_EVENTS_CHANNEL);
});
afterAll(async () => {
  subscriber.disconnect();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
  later.length = 0;
});

/** The messages about this document that were published, in order. The channel is shared by every run on the machine. */
const heardFor = (documentId: string) => heard.filter((message) => message.includes(documentId));

// ── Requests ────────────────────────────────────────────────────────────────

const request = (method: string, path: string, cookie: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { origin }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

const offer = (cookie: string, id: string, collaboratorId: unknown) =>
  offering.POST(
    request('POST', `/api/documents/${id}/ownership-offer`, cookie, { collaboratorId, password: PASSWORD }),
    at({ id }),
  );
const withdraw = (cookie: string, id: string) =>
  offering.DELETE(request('DELETE', `/api/documents/${id}/ownership-offer`, cookie), at({ id }));
const answer = (cookie: string, offerId: string, chosen: string) =>
  answering.POST(
    request('POST', `/api/ownership-offers/${offerId}/${chosen}`, cookie),
    at({ offerId, answer: chosen }),
  );
const accept = (cookie: string, offerId: string) => answer(cookie, offerId, 'accept');
const decline = (cookie: string, offerId: string) => answer(cookie, offerId, 'decline');
const changeRole = (cookie: string, id: string, collaboratorId: string, role: string) =>
  one.PATCH(
    request('PATCH', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie, { role }),
    at({ id, collaboratorId }),
  );
const removal = (cookie: string, id: string, collaboratorId: string) =>
  one.DELETE(
    request('DELETE', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie),
    at({ id, collaboratorId }),
  );
const leave = (cookie: string, id: string) =>
  leaving.POST(request('POST', `/api/documents/${id}/leave`, cookie), at({ id }));
const listOf = async (cookie: string) =>
  (
    (await (await collection.GET(request('GET', '/api/documents', cookie))).json()) as {
      documents: { id: string; canDelete: boolean }[];
    }
  ).documents;
const code = async (response: Response) => (await response.clone().json()).error.code as string;
const message = async (response: Response) => (await response.clone().json()).error.message as string;

// ── Accounts, documents, roles ──────────────────────────────────────────────

let count = 0;
async function person(name = 'A Person') {
  const email = `offer${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;

/** A collaborator as an accepted invitation makes one, and the identifier of its row. */
async function grant(documentId: string, who: Person, role: 'EDITOR' | 'VIEWER' | 'REVIEWER') {
  return (await db().documentCollaborator.create({ data: { documentId, userId: who.id, role } })).id;
}

/** An Owner with an Editor, and a document. */
async function pair() {
  const owner = await person('Ada Owner');
  const editor = await person('Ben Editor');
  const id = (await createDocument(owner.id)).id;
  const row = await grant(id, editor, 'EDITOR');
  return { owner, editor, id, row };
}

const offerOf = (documentId: string) => db().ownershipOffer.findFirstOrThrow({ where: { documentId } });
const offersOf = (documentId: string) =>
  db().ownershipOffer.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
const notificationsFor = (userId: string) =>
  db().notification.findMany({ where: { recipientId: userId, kind: 'ownership_offer' } });
const logged = (documentId: string) =>
  db().securityLogEntry.findMany({
    where: { documentId },
    select: { kind: true, userId: true },
    orderBy: { createdAt: 'asc' },
  });
const mail = () => sunk(MAIL);
/** Runs what the routes left for after their responses. */
async function afterResponses() {
  for (const task of later.splice(0)) await task();
}

/** Everything that says who holds what on a document, as the rows have it. */
async function standing(documentId: string) {
  const document = await db().document.findUniqueOrThrow({ where: { id: documentId } });
  const rows = await db().documentCollaborator.findMany({ where: { documentId } });
  return {
    ownerId: document.ownerId,
    workspaceId: document.workspaceId,
    collaborators: rows.map(({ userId, role }) => `${userId}:${role}`).sort(),
    owners: rows.filter(({ userId }) => userId === document.ownerId).length,
    pending: await db().ownershipOffer.count({ where: { documentId, state: 'PENDING' } }),
  };
}

/**
 * Holds the document's row for the length of `during`, as a request that is
 * on its way would, and runs `during` once it does. What `then` writes is
 * written under that hold and committed when it returns.
 */
async function holding<T>(
  documentId: string,
  during: () => Promise<T>,
  then: (
    tx: Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0],
  ) => Promise<void> = async () => {},
): Promise<T> {
  let locked!: () => void;
  let release!: () => void;
  const holds = new Promise<void>((resolve) => (locked = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const transaction = db().$transaction(
    async (tx) => {
      expect(await lockDocument(tx, documentId)).toBe(true);
      locked();
      await gate;
      await then(tx);
    },
    { timeout: 20_000 },
  );
  await holds;
  const pending = during();
  // The request has authorised and now waits for the row: the database says one statement waits on a lock.
  await until(() =>
    /(^|\n)[1-9]\d*$/.test(
      database.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'`),
    ),
  );
  release();
  await transaction;
  return pending;
}

// ── Offering ────────────────────────────────────────────────────────────────

describe('offering ownership (FR-ED-47)', () => {
  it('creates one pending offer and the Editor’s notification, and changes nothing else', async () => {
    const { owner, editor, id, row } = await pair();
    const before = await standing(id);

    const response = await offer(owner.cookie, id, row);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { message: string; expiresAt: string };
    expect(body.message).toBe('Ownership offered to Ben Editor.');

    const made = await offerOf(id);
    expect(made).toMatchObject({ fromUserId: owner.id, toUserId: editor.id, state: 'PENDING' });
    // FR-ED-47: 14 days after it was created, an initial value.
    expect(made.expiresAt.getTime() - made.createdAt.getTime()).toBe(14 * 24 * 60 * 60 * 1000);
    expect(body.expiresAt).toBe(made.expiresAt.toISOString());
    // FR-ED-42: one notification, addressed to the Editor, whose payload names the offer and nothing else.
    expect(await notificationsFor(editor.id)).toMatchObject([
      { payload: { offerId: made.id }, readAt: null },
    ]);
    expect(await notificationsFor(owner.id)).toEqual([]);
    expect(Object.keys((await notificationsFor(editor.id))[0]!.payload as object)).toEqual(['offerId']);
    // "Ownership changes only when that user accepts": no one's role has changed.
    expect(await standing(id)).toEqual({ ...before, pending: 1 });
    // Not logged: no one's role changed (S17-3). Not published: nothing open changed.
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
  });

  // Weakening: the email handed over in the request, or handed over twice.
  it('hands the email over once, after the response: before it nothing is written, and a second run writes nothing', async () => {
    const { owner, editor, id, row } = await pair();
    // A title that must reach no email (the owner's decision of 19 October 2026).
    await db().document.update({ where: { id }, data: { title: 'Zebra quartz title' } });
    const sent = (await mail()).length;
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await mail()).length).toBe(sent);
    expect(later).toHaveLength(1);

    await afterResponses();
    const written = (await mail()).slice(sent);
    expect(written).toHaveLength(1);
    expect(written[0]!.to).toBe(editor.email);
    expect(written[0]!.subject).toBe('An offer of ownership of a document in Ekdotico');
    const expires = (await offerOf(id)).expiresAt;
    expect(written[0]!.text).toBe(
      `Ada Owner has offered you ownership of a document that you edit in Ekdotico. To accept or decline, open your notifications in Ekdotico: ${ORIGIN}/notifications. The offer is open until ${expires.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][expires.getUTCMonth()]} ${expires.getUTCFullYear()}, ${String(expires.getUTCHours()).padStart(2, '0')}:${String(expires.getUTCMinutes()).padStart(2, '0')} UTC. If you accept, you become the Owner of the document and Ada Owner becomes an Editor.`,
    );
    expect(JSON.stringify(written)).not.toContain('Zebra');
    expect((await offerOf(id)).emailClaimedAt).not.toBeNull();

    // At most once: the row is marked, and a marked row is never handed over again.
    await deliverOffer((await offerOf(id)).id);
    await Promise.all([deliverOffer((await offerOf(id)).id), deliverOffer((await offerOf(id)).id)]);
    expect((await mail()).length).toBe(sent + 1);
  });

  it('does not try again where the hand-over fails, and says so in one line that names no one', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const lines = vi.spyOn(console, 'error').mockImplementation(() => {});
    const calls: unknown[] = [];
    const made = await offerOf(id);
    await deliverOffer(made.id, async (sent) => {
      calls.push(sent);
      throw Object.assign(new Error(`down ${editor.email}`), { code: 'ECONNREFUSED' });
    });
    await deliverOffer(made.id, async (sent) => void calls.push(sent));
    // "Where the outcome of a send is unknown the email is not sent a second time."
    expect(calls).toHaveLength(1);
    expect(lines.mock.calls).toEqual([
      [`ownership offer ${made.id}: email not delivered (Error ECONNREFUSED)`],
    ]);
    expect(JSON.stringify(lines.mock.calls)).not.toContain(editor.email);
  });

  it('sends nothing for an offer that is no longer open', async () => {
    const { owner, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await withdraw(owner.cookie, id)).status).toBe(200);
    const sent = (await mail()).length;
    await afterResponses();
    expect((await mail()).length).toBe(sent);
  });

  it('is for an Editor and no one else: a Viewer, a Reviewer, a row of another document, and a row that does not exist are refused, and nothing is created', async () => {
    const { owner, id, row } = await pair();
    const viewer = await person();
    const reviewer = await person();
    const viewerRow = await grant(id, viewer, 'VIEWER');
    const reviewerRow = await grant(id, reviewer, 'REVIEWER');
    const other = (await createDocument(owner.id)).id;
    const elsewhere = await person();
    const elsewhereRow = await grant(other, elsewhere, 'EDITOR');

    // Weakening: any collaborator offered, or the Editor role read from the offer's request.
    for (const refused of [viewerRow, reviewerRow]) {
      const response = await offer(owner.cookie, id, refused);
      expect(response.status).toBe(409);
      expect(await code(response)).toBe('not_an_editor');
    }
    // The row of an Editor of another document is no row of this one (IDOR).
    for (const refused of [elsewhereRow, randomUUID(), 'x'.repeat(100), '../x', '']) {
      const response = await offer(owner.cookie, id, refused);
      expect(response.status, refused).toBe(404);
      expect(await message(response)).toBe(
        'This person is not a collaborator on this document. Reload the page to see the people.',
      );
    }
    expect(await offersOf(id)).toEqual([]);
    expect(await offersOf(other)).toEqual([]);
    // And it is for the Editor of this document.
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
  });

  it('offers nothing to a deleted account, which has no address and holds no role (FR-AU-58)', async () => {
    const { owner, editor, id, row } = await pair();
    await db().user.update({ where: { id: editor.id }, data: { email: null, name: null } });
    const response = await offer(owner.cookie, id, row);
    expect(response.status).toBe(409);
    expect(await code(response)).toBe('not_an_editor');
    expect(await offersOf(id)).toEqual([]);
  });

  it('refuses a body that is not exactly the identifier of a row, and a body that is not JSON', async () => {
    const { owner, id, row } = await pair();
    // The password is asked for first (FR-ED-47, D285): with it, a body of the wrong shape is told so.
    const refuse = async (body: unknown, words = 'No offer was made. Choose an Editor.') => {
      const response = await offering.POST(
        request('POST', `/api/documents/${id}/ownership-offer`, owner.cookie, body),
        at({ id }),
      );
      expect(response.status, JSON.stringify(body)).toBe(422);
      expect(await code(response)).toBe('invalid_request');
      expect(await message(response)).toBe(words);
    };
    const word = (body: object) => ({ ...body, password: PASSWORD });
    await refuse(word({}));
    await refuse(word({ collaboratorId: 7 }));
    await refuse(word({ collaboratorId: null }));
    await refuse(word({ collaboratorId: row, userId: 'someone-else' }));
    await refuse(word({ userId: 'someone-else' }));
    // Without the password, or not an object, it is the password that is asked for.
    const ASKED = 'No offer was made. Enter your current password to offer ownership.';
    await refuse({ collaboratorId: row }, ASKED);
    await refuse([], ASKED);
    await refuse('text', ASKED);
    const text = await offering.POST(
      new Request(`${ORIGIN}/api/documents/${id}/ownership-offer`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: owner.cookie, 'content-type': 'text/plain' },
        body: JSON.stringify({ collaboratorId: row }),
      }),
      at({ id }),
    );
    expect(text.status).toBe(415);
    expect(await offersOf(id)).toEqual([]);
  });

  // Weakening: the Owner's role read from the session, or the permission read as held by an Editor.
  it('is the Owner’s alone: an Editor, even given every adjustable permission, and a Viewer are refused 403 and logged; a stranger is a 404', async () => {
    const { owner, editor, id, row } = await pair();
    const viewer = await person();
    await grant(id, viewer, 'VIEWER');
    const stranger = await person();
    const set = defaultPermissionSet();
    for (const permission of Object.keys(set) as (keyof typeof set)[]) set[permission].editor = true;
    await db().document.update({ where: { id }, data: { permissionSet: set } });
    const second = await person();
    const secondRow = await grant(id, second, 'EDITOR');

    for (const who of [editor, viewer]) {
      const refused = await offer(who.cookie, id, secondRow);
      expect(refused.status).toBe(403);
      expect(await code(refused)).toBe('forbidden');
      expect(await message(refused)).toBe('Only the Owner of the document can do this.');
      expect((await withdraw(who.cookie, id)).status).toBe(403);
    }
    for (const response of [await offer(stranger.cookie, id, row), await withdraw(stranger.cookie, id)]) {
      expect(response.status).toBe(404);
    }
    expect(await offersOf(id)).toEqual([]);
    // NFR-SE-19: the 403s are logged with the user and the document and nothing else.
    expect(await logged(id)).toEqual([
      { kind: 'forbidden', userId: editor.id },
      { kind: 'forbidden', userId: editor.id },
      { kind: 'forbidden', userId: viewer.id },
      { kind: 'forbidden', userId: viewer.id },
    ]);
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
  });

  // Weakening: no lock on the document, and no index.
  it('is one at a time: a second offer is refused, and two at once make one', async () => {
    const { owner, id, row } = await pair();
    const other = await person();
    const otherRow = await grant(id, other, 'EDITOR');
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    for (const refused of [row, otherRow]) {
      const response = await offer(owner.cookie, id, refused);
      expect(response.status).toBe(409);
      expect(await code(response)).toBe('offer_pending');
    }
    expect(await offersOf(id)).toHaveLength(1);

    for (let round = 0; round < 6; round++) {
      const fresh = await pair();
      const third = await person();
      const thirdRow = await grant(fresh.id, third, 'EDITOR');
      const results = await Promise.all([
        offer(fresh.owner.cookie, fresh.id, fresh.row),
        offer(fresh.owner.cookie, fresh.id, thirdRow),
      ]);
      expect(results.map((each) => each.status).sort()).toEqual([201, 409]);
      expect(await offersOf(fresh.id)).toHaveLength(1);
      expect((await standing(fresh.id)).pending).toBe(1);
    }
  });

  it('is held by the database too: a second pending offer cannot be written, whatever wrote it', async () => {
    const { owner, editor, id } = await pair();
    const data = {
      documentId: id,
      fromUserId: owner.id,
      toUserId: editor.id,
      expiresAt: new Date(Date.now() + 1e6),
    };
    await db().ownershipOffer.create({ data });
    await expect(db().ownershipOffer.create({ data })).rejects.toThrow();
    // Another state is no obstacle, and ownership is not offered to oneself.
    await db().ownershipOffer.create({ data: { ...data, state: 'DECLINED' } });
    await expect(
      db().ownershipOffer.create({ data: { ...data, state: 'DECLINED', toUserId: owner.id } }),
    ).rejects.toThrow();
  });

  it('is not made for a recorded document or one in an institutional workspace (Q34), and nothing is created', async () => {
    const { owner, id, row } = await pair();
    await db().document.update({ where: { id }, data: { recording: 'RECORDED' } });
    const recorded = await offer(owner.cookie, id, row);
    expect(recorded.status).toBe(409);
    expect(await code(recorded)).toBe('not_transferable');
    expect(await message(recorded)).toBe(
      'No offer was made. This document cannot be transferred in this release. You stay its Owner.',
    );
    await db().document.update({ where: { id }, data: { recording: 'UNRECORDED' } });

    const { id: workspaceId } = await db().workspace.create({ data: { type: 'INSTITUTIONAL' } });
    const personal = (await db().document.findUniqueOrThrow({ where: { id } })).workspaceId;
    await db().document.update({ where: { id }, data: { workspaceId } });
    const institutional = await offer(owner.cookie, id, row);
    expect(institutional.status).toBe(409);
    expect(await code(institutional)).toBe('not_transferable');
    expect(await offersOf(id)).toEqual([]);
    await db().document.update({ where: { id }, data: { workspaceId: personal } });
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
  });

  it('is not made for a deleted document, and not by an Owner who is no longer one when the request reaches the row (read again under the lock)', async () => {
    const { owner, editor, id, row } = await pair();
    // The Owner's request was authorised; ownership passes before it takes the row.
    const response = await holding(
      id,
      () => offer(owner.cookie, id, row),
      async (tx) => {
        await tx.documentCollaborator.delete({ where: { id: row } });
        await tx.document.update({ where: { id }, data: { ownerId: editor.id } });
        await tx.documentCollaborator.create({ data: { documentId: id, userId: owner.id, role: 'EDITOR' } });
      },
    );
    // The caller holds a role that is not the Owner's now: a 403, and nothing created.
    expect(response.status).toBe(403);
    expect(await offersOf(id)).toEqual([]);

    const gone = await pair();
    const refused = await holding(
      gone.id,
      () => offer(gone.owner.cookie, gone.id, gone.row),
      async (tx) =>
        void (await tx.document.update({
          where: { id: gone.id },
          data: { deletedAt: new Date(), deletedById: gone.owner.id },
        })),
    );
    expect(refused.status).toBe(404);
    expect(await offersOf(gone.id)).toEqual([]);
  });
});

// ── Withdrawing ─────────────────────────────────────────────────────────────

describe('withdrawing an offer (FR-ED-47)', () => {
  it('withdraws the pending offer and its notification, and lets the Owner offer again', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const response = await withdraw(owner.cookie, id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Offer of ownership to Ben Editor withdrawn.' });
    expect(await offersOf(id)).toMatchObject([{ state: 'WITHDRAWN' }]);
    expect((await offersOf(id))[0]!.respondedAt).not.toBeNull();
    expect(await notificationsFor(editor.id)).toEqual([]);
    expect(await logged(id)).toEqual([]);

    const again = await withdraw(owner.cookie, id);
    expect(again.status).toBe(404);
    expect(await code(again)).toBe('no_open_offer');
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await standing(id)).pending).toBe(1);
  });

  it('withdraws the offer of its own document: an Owner of two documents withdraws the one in the path', async () => {
    const { owner, id, row } = await pair();
    const other = (await createDocument(owner.id)).id;
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    // Weakening: the offer found by the Owner and not by the document.
    const response = await withdraw(owner.cookie, other);
    expect(response.status).toBe(404);
    expect((await offerOf(id)).state).toBe('PENDING');
  });

  it('cannot withdraw an offer that is over: past its time it has expired', async () => {
    const { owner, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    await db().ownershipOffer.updateMany({
      where: { documentId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await withdraw(owner.cookie, id)).status).toBe(404);
    expect((await offerOf(id)).state).toBe('PENDING');
  });
});

// ── Answering ───────────────────────────────────────────────────────────────

describe('accepting an offer (FR-ED-47, FR-AU-13, FR-ED-19)', () => {
  it('moves the Owner, the roles and the workspace in one transaction, and nothing else about the document', async () => {
    const { owner, editor, id, row } = await pair();
    const third = await person();
    const thirdRow = await grant(id, third, 'VIEWER');
    // What FR-ED-47 says stays as it was: the permission set (changed from the default), a pending invitation, the content, the title.
    const set = defaultPermissionSet();
    set['document.rename'].editor = true;
    // D300: the former Owner's pending invitation survives only where an Editor may invite (the other case is in
    // invitation-revocation.test.ts).
    set['document.collaborators.invite'].editor = true;
    await db().document.update({
      where: { id },
      data: { permissionSet: set, yjsState: Buffer.from([1, 2, 3]), title: 'A title' },
    });
    const invitation = await db().documentInvitation.create({
      data: {
        documentId: id,
        email: 'someone@example.com',
        role: 'VIEWER',
        invitedById: owner.id,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 1e6),
      },
    });
    const before = await db().document.findUniqueOrThrow({ where: { id } });
    const ownerWorkspace = before.workspaceId;
    // The Editor has never created a document: no workspace yet (the backstop of FR-AU-09 creates it in the transaction).
    expect(await db().workspace.findUnique({ where: { ownerId: editor.id } })).toBeNull();

    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    const response = await accept(editor.cookie, made.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ documentId: id });

    const after = await db().document.findUniqueOrThrow({ where: { id } });
    const workspace = await db().workspace.findUniqueOrThrow({ where: { ownerId: editor.id } });
    expect(after.ownerId).toBe(editor.id);
    expect(after.workspaceId).toBe(workspace.id);
    expect(workspace.id).not.toBe(ownerWorkspace);
    expect(workspace.type).toBe('PERSONAL');
    // Nothing else: identifier, content, title, permission set, mark of FR-ED-43, the time of the last edit.
    expect(after).toEqual({ ...before, ownerId: editor.id, workspaceId: workspace.id });
    // The content is not in the row `db()` reads by default (src/lib/db.ts).
    const content = await db().document.findUniqueOrThrow({ where: { id }, select: { yjsState: true } });
    expect(Buffer.from(content.yjsState!)).toEqual(Buffer.from([1, 2, 3]));
    expect(after.permissionSet).toEqual(set);
    expect(after.recording).toBe('UNRECORDED');
    // The roles: one Owner, who has no row; the former Owner an Editor; the others as they were.
    expect(await standing(id)).toEqual({
      ownerId: editor.id,
      workspaceId: workspace.id,
      collaborators: [`${owner.id}:EDITOR`, `${third.id}:VIEWER`].sort(),
      owners: 0,
      pending: 0,
    });
    expect((await db().documentCollaborator.findUniqueOrThrow({ where: { id: thirdRow } })).role).toBe(
      'VIEWER',
    );
    expect(await db().documentCollaborator.findUnique({ where: { id: row } })).toBeNull();
    // The pending invitation stays as it was.
    expect(await db().documentInvitation.findUniqueOrThrow({ where: { id: invitation.id } })).toEqual(
      invitation,
    );
    // The offer is accepted, and its notification is gone: it stays only while the offer is pending.
    expect(await offersOf(id)).toMatchObject([{ state: 'ACCEPTED' }]);
    expect(await notificationsFor(editor.id)).toEqual([]);
    // Each person's list shows the role now held.
    expect(await listOf(editor.cookie)).toMatchObject([{ id, canDelete: true }]);
    expect(await listOf(owner.cookie)).toMatchObject([{ id, canDelete: false }]);
    // The former Owner may now leave (FR-ED-38), and the new Owner may not.
    expect((await leave(editor.cookie, id)).status).toBe(403);
  });

  it('uses the personal workspace the Editor has already', async () => {
    const { editor, owner, id, row } = await pair();
    const own = (await createDocument(editor.id)).id;
    const workspaceId = (await db().document.findUniqueOrThrow({ where: { id: own } })).workspaceId;
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    expect((await db().document.findUniqueOrThrow({ where: { id } })).workspaceId).toBe(workspaceId);
    expect(await db().workspace.count({ where: { ownerId: editor.id } })).toBe(1);
  });

  it('tells the collaboration servers of both people after the commit, and not before', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const publish = valkey().publish.bind(valkey());
    const seen: string[] = [];
    vi.spyOn(valkey(), 'publish').mockImplementation((async (...given: Parameters<typeof publish>) => {
      const document = await db().document.findUniqueOrThrow({ where: { id } });
      seen.push(document.ownerId);
      return publish(...given);
    }) as never);
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    // Weakening: the notice published inside the transaction, before the commit.
    expect(seen).toEqual([editor.id, editor.id]);
    await until(() => heardFor(id).length === 2);
    expect(heardFor(id).sort()).toEqual(
      [
        `{"kind":"collaborator-changed","documentId":"${id}","userId":"${owner.id}"}`,
        `{"kind":"collaborator-changed","documentId":"${id}","userId":"${editor.id}"}`,
      ].sort(),
    );
  });

  it('stands where the notice cannot be published, says so in lines that name no person, and answers', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const lines = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(valkey(), 'publish').mockRejectedValue(
      Object.assign(new Error(`down ${editor.email}`), { code: 'ECONNREFUSED' }),
    );
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    expect((await standing(id)).ownerId).toBe(editor.id);
    expect(lines.mock.calls).toHaveLength(2);
    for (const [line] of lines.mock.calls) {
      expect(line).toMatch(
        new RegExp(
          `^collab events: collaborator-changed not published for document ${id} \\(Error ECONNREFUSED\\)$`,
        ),
      );
    }
    expect(JSON.stringify(lines.mock.calls)).not.toContain(editor.email);
    expect(JSON.stringify(lines.mock.calls)).not.toContain(editor.id);
  });

  // Weakening: the entry written after the commit; no entry; an entry for a refusal.
  it('writes one entry, owner_changed, with the user who accepted and the document, in the transaction of the change', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    expect(await logged(id)).toEqual([{ kind: 'owner_changed', userId: editor.id }]);
    // Nothing else is in the entry: no address, no name, no title (NFR-SE-19).
    const entry = await db().securityLogEntry.findFirstOrThrow({ where: { documentId: id } });
    expect(JSON.stringify(entry)).not.toMatch(/example\.com|Ada|Ben/);
  });

  it('leaves everything as it was, and tells no one, where the entry of the security log cannot be written', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const before = await standing(id);
    database.sql(
      `CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
       CREATE TRIGGER refuse_for_test BEFORE INSERT ON "SecurityLogEntry" FOR EACH ROW WHEN (NEW.kind = 'owner_changed') EXECUTE FUNCTION refuse_for_test();`,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(500);
    } finally {
      database.sql(`DROP TRIGGER refuse_for_test ON "SecurityLogEntry"; DROP FUNCTION refuse_for_test();`);
    }
    expect(await standing(id)).toEqual({ ...before, pending: 1 });
    expect((await offerOf(id)).state).toBe('PENDING');
    expect(await notificationsFor(editor.id)).toHaveLength(1);
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
    // The offer is still open and is answered when the log can be written.
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    expect((await standing(id)).ownerId).toBe(editor.id);
    expect(owner.id).not.toBe(editor.id);
  });

  it('is the account the offer names alone: another Editor, a Viewer, the Owner and a stranger are told what is told of an offer that does not exist, and nothing changes', async () => {
    const { owner, editor, id, row } = await pair();
    const other = await person();
    await grant(id, other, 'EDITOR');
    const viewer = await person();
    await grant(id, viewer, 'VIEWER');
    const stranger = await person();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    const before = await standing(id);

    const nothing = await accept(editor.cookie, 'cm0000000000000000000000');
    expect(nothing.status).toBe(404);
    expect(await code(nothing)).toBe('not_open_to_account');
    const body = await nothing.clone().text();
    // Weakening: acceptance by the identifier of the offer alone.
    for (const who of [other, viewer, owner, stranger]) {
      for (const chosen of ['accept', 'decline']) {
        const response = await answer(who.cookie, made.id, chosen);
        expect(response.status, `${who.name} ${chosen}`).toBe(404);
        expect(await response.text()).toBe(body);
      }
    }
    expect(await standing(id)).toEqual(before);
    expect((await offerOf(id)).state).toBe('PENDING');
    expect(await notificationsFor(editor.id)).toHaveLength(1);
    expect(await logged(id)).toEqual([]);
    // Names that are no identifier, and an action that is none.
    for (const odd of ['../x', 'x'.repeat(100), '%00']) {
      expect((await accept(editor.cookie, odd)).status).toBe(404);
    }
    const none = await answer(editor.cookie, made.id, 'transfer');
    expect(none.status).toBe(404);
    expect(await message(none)).toBe('There is no such action.');
    expect((await offerOf(id)).state).toBe('PENDING');
  });

  it('is refused to the account it names once it holds no Editor role on the document, and the offer is settled', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    // The row says Viewer, and no hook has run: a reader never trusts the stored state alone.
    await db().documentCollaborator.update({ where: { id: row }, data: { role: 'VIEWER' } });
    const response = await accept(editor.cookie, (await offerOf(id)).id);
    expect(response.status).toBe(404);
    expect(await code(response)).toBe('no_longer_open');
    expect((await standing(id)).ownerId).toBe(owner.id);
    expect(await offersOf(id)).toMatchObject([{ state: 'WITHDRAWN' }]);
    expect(await notificationsFor(editor.id)).toEqual([]);
  });

  it('is refused where the maker of the offer is no longer the Owner', async () => {
    const { owner, editor, id, row } = await pair();
    const third = await person();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    // Ownership passed by another way (there is none; this is the state a fault would leave).
    await db().document.update({ where: { id }, data: { ownerId: third.id } });
    const response = await accept(editor.cookie, made.id);
    expect(response.status).toBe(404);
    expect(await code(response)).toBe('no_longer_open');
    expect((await standing(id)).ownerId).toBe(third.id);
  });

  it('is refused for a recorded document, and for one that is deleted', async () => {
    for (const change of ['recorded', 'deleted'] as const) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      await db().document.update({
        where: { id },
        data:
          change === 'recorded'
            ? { recording: 'RECORDED' }
            : { deletedAt: new Date(), deletedById: owner.id },
      });
      const response = await accept(editor.cookie, (await offerOf(id)).id);
      expect(response.status, change).toBe(404);
      expect((await standing(id)).ownerId).toBe(owner.id);
    }
  });

  // Weakening: the signed copy of the session used for a request that changes state.
  it('reads the row of the session, and never the copy a cookie carries', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    await db().session.deleteMany({ where: { userId: editor.id } });
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(401);
    await db().session.deleteMany({ where: { userId: owner.id } });
    expect((await withdraw(owner.cookie, id)).status).toBe(401);
    expect((await offer(owner.cookie, id, row)).status).toBe(401);
    expect((await offerOf(id)).state).toBe('PENDING');
    expect((await standing(id)).ownerId).toBe(owner.id);
    expect(await logged(id)).toEqual([]);
  });

  it('checks the origin before anything of the request, and a request that is refused changes nothing', async () => {
    const { owner, editor, id, row } = await pair();
    const foreign = 'https://elsewhere.example';
    expect(
      (
        await offering.POST(
          request(
            'POST',
            `/api/documents/${id}/ownership-offer`,
            owner.cookie,
            { collaboratorId: row },
            foreign,
          ),
          at({ id }),
        )
      ).status,
    ).toBe(403);
    expect(await offersOf(id)).toEqual([]);
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    expect(
      (
        await offering.DELETE(
          request('DELETE', `/api/documents/${id}/ownership-offer`, owner.cookie, undefined, foreign),
          at({ id }),
        )
      ).status,
    ).toBe(403);
    for (const chosen of ['accept', 'decline']) {
      const response = await answering.POST(
        request('POST', `/api/ownership-offers/${made.id}/${chosen}`, editor.cookie, undefined, foreign),
        at({ offerId: made.id, answer: chosen }),
      );
      expect(response.status).toBe(403);
    }
    expect((await offerOf(id)).state).toBe('PENDING');
    expect((await standing(id)).ownerId).toBe(owner.id);
  });

  // Weakening: a terminal state read as open.
  it('refuses every answer to an offer that was accepted, declined, withdrawn or expired, and changes nothing', async () => {
    const states = ['accepted', 'declined', 'withdrawn', 'expired'] as const;
    for (const state of states) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      if (state === 'accepted') expect((await accept(editor.cookie, made.id)).status).toBe(200);
      if (state === 'declined') expect((await decline(editor.cookie, made.id)).status).toBe(200);
      if (state === 'withdrawn') expect((await withdraw(owner.cookie, id)).status).toBe(200);
      if (state === 'expired') {
        await db().ownershipOffer.update({
          where: { id: made.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
        // Written by the timer; an answer to one that is not yet written settles it (tested below).
        await expireOffers();
      }
      const before = await standing(id);
      const offerBefore = await offerOf(id);
      // The recipient is told that it is over; the account that was Owner or Editor learns nothing more.
      for (const chosen of ['accept', 'decline']) {
        for (const who of [editor, owner]) {
          const response = await answer(who.cookie, made.id, chosen);
          expect(response.status, `${state} ${chosen}`).toBe(404);
        }
        const recipient = await answer(editor.cookie, made.id, chosen);
        expect(await code(recipient), `${state} ${chosen}`).toBe('no_longer_open');
      }
      expect(await standing(id)).toEqual(before);
      expect(await offerOf(id)).toEqual(offerBefore);
    }
  });

  it('is not an acceptance twice: two accepts at once make one transfer', async () => {
    for (let round = 0; round < 6; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      const results = await Promise.all([accept(editor.cookie, made.id), accept(editor.cookie, made.id)]);
      expect(results.map((each) => each.status).sort()).toEqual([200, 404]);
      const after = await standing(id);
      expect(after).toMatchObject({ ownerId: editor.id, owners: 0, pending: 0 });
      expect(after.collaborators).toEqual([`${owner.id}:EDITOR`]);
      expect(await logged(id)).toEqual([{ kind: 'owner_changed', userId: editor.id }]);
    }
  });

  it('is not the offer of another document: an offer is answered by its own identifier and gives its own document', async () => {
    const { owner, editor, id, row } = await pair();
    // The same Editor holds a role on a second document, whose Owner offers too.
    const second = await person('Cy Owner');
    const other = (await createDocument(second.id)).id;
    const otherRow = await grant(other, editor, 'EDITOR');
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await offer(second.cookie, other, otherRow)).status).toBe(201);
    const response = await accept(editor.cookie, (await offerOf(other)).id);
    expect(await response.json()).toEqual({ documentId: other });
    expect((await standing(id)).ownerId).toBe(owner.id);
    expect((await standing(other)).ownerId).toBe(editor.id);
    expect((await offerOf(id)).state).toBe('PENDING');
  });
});

describe('declining an offer (FR-ED-47)', () => {
  it('declines it, deletes the notification, changes no one’s role, and lets the Owner offer again', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const before = await standing(id);
    const response = await decline(editor.cookie, (await offerOf(id)).id);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Offer declined.' });
    expect(await offersOf(id)).toMatchObject([{ state: 'DECLINED' }]);
    expect(await notificationsFor(editor.id)).toEqual([]);
    expect(await standing(id)).toEqual({ ...before, pending: 0 });
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
  });
});

// ── Expiry ──────────────────────────────────────────────────────────────────

describe('expiry (FR-ED-47: 14 days after it was created)', () => {
  // Weakening: the time read as of the page, or "past" read as "at".
  it('is from the stored time: open until the instant, over at it', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    // At the instant itself it is over (an answer settles it as expired).
    const refused = await answerOffer(editor.id, made.id, 'accept', made.expiresAt);
    expect(refused).toEqual({ outcome: 'no_longer_open' });
    expect((await standing(id)).ownerId).toBe(owner.id);
    expect((await offerOf(id)).state).toBe('EXPIRED');

    // One millisecond before it, another offer is open.
    const fresh = await pair();
    expect((await offer(fresh.owner.cookie, fresh.id, fresh.row)).status).toBe(201);
    const open = await offerOf(fresh.id);
    const just = await answerOffer(
      fresh.editor.id,
      open.id,
      'accept',
      new Date(open.expiresAt.getTime() - 1),
    );
    expect(just).toEqual({ outcome: 'accepted', documentId: fresh.id });
    expect((await standing(fresh.id)).ownerId).toBe(fresh.editor.id);
  });

  it('is over once the time has passed though the row still says pending: refused by the route, left out of the list, and the Owner may offer again', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    await db().ownershipOffer.update({
      where: { id: made.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await offerOf(id)).state).toBe('PENDING');
    const response = await accept(editor.cookie, made.id);
    expect(response.status).toBe(404);
    expect(await code(response)).toBe('no_longer_open');
    const list = (await (
      await notifications.GET(request('GET', '/api/notifications', editor.cookie))
    ).json()) as {
      unread: number;
      notifications: { kind: string }[];
    };
    expect(list.notifications.filter(({ kind }) => kind === 'ownership_offer')).toEqual([]);
    expect(list.unread).toBe(0);
    // A new offer settles the old one and stands.
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect(await offersOf(id)).toMatchObject([{ state: 'EXPIRED' }, { state: 'PENDING' }]);
    expect(await notificationsFor(editor.id)).toHaveLength(1);
  });

  it('is written by the timer, which deletes the notifications; two instances at once do it once and neither fails', async () => {
    const { owner, editor, id, row } = await pair();
    const fresh = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await offer(fresh.owner.cookie, fresh.id, fresh.row)).status).toBe(201);
    await db().ownershipOffer.updateMany({
      where: { documentId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const ran = await Promise.all([expireOffers(), expireOffers()]);
    expect(ran.reduce((sum, deleted) => sum + deleted, 0)).toBe(1);
    expect(await offersOf(id)).toMatchObject([{ state: 'EXPIRED' }]);
    expect((await offersOf(id))[0]!.respondedAt).not.toBeNull();
    expect(await notificationsFor(editor.id)).toEqual([]);
    // The offer that is open stands, with its notification.
    expect((await offerOf(fresh.id)).state).toBe('PENDING');
    expect(await notificationsFor(fresh.editor.id)).toHaveLength(1);
    expect(await expireOffers()).toBe(0);
    // Nothing of an expiry is logged or published.
    expect(await logged(id)).toEqual([]);
  });

  it('sends no email for an offer that has expired', async () => {
    const { owner, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    await db().ownershipOffer.updateMany({
      where: { documentId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const sent = (await mail()).length;
    await afterResponses();
    expect((await mail()).length).toBe(sent);
  });
});

// ── What ends an offer without anyone's action ──────────────────────────────

describe('an offer is withdrawn without anyone’s action (FR-ED-47)', () => {
  const standingOffer = async () => {
    const made = await pair();
    expect((await offer(made.owner.cookie, made.id, made.row)).status).toBe(201);
    return made;
  };
  const withdrawn = async (id: string, editor: Person) => {
    expect(await offersOf(id)).toMatchObject([{ state: 'WITHDRAWN' }]);
    expect((await offersOf(id))[0]!.respondedAt).not.toBeNull();
    expect(await notificationsFor(editor.id)).toEqual([]);
  };

  // Weakening: the withdrawal left out of the change of role.
  it('where the Editor is made a Viewer, and is not where the role is the one held', async () => {
    const { owner, editor, id, row } = await standingOffer();
    expect((await changeRole(owner.cookie, id, row, 'editor')).status).toBe(200);
    expect((await offerOf(id)).state).toBe('PENDING');
    expect((await changeRole(owner.cookie, id, row, 'viewer')).status).toBe(200);
    await withdrawn(id, editor);
    // And it cannot be accepted by a Viewer.
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(404);
    expect((await standing(id)).ownerId).toBe(owner.id);
  });

  // Weakening: the withdrawal left out of the removal.
  it('where the Editor is removed', async () => {
    const { owner, editor, id, row } = await standingOffer();
    expect((await removal(owner.cookie, id, row)).status).toBe(200);
    await withdrawn(id, editor);
  });

  // Weakening: the withdrawal left out of the leave.
  it('where the Editor leaves', async () => {
    const { editor, id } = await standingOffer();
    expect((await leave(editor.cookie, id)).status).toBe(204);
    await withdrawn(id, editor);
  });

  // Weakening: the withdrawal left out of the deletion.
  it('where the document is deleted', async () => {
    const { owner, editor, id } = await standingOffer();
    expect(await deleteDocument({ id }, owner.id)).toBe(true);
    await withdrawn(id, editor);
  });

  it('is not the offer of another Editor: the removal of one Editor leaves the offer to another', async () => {
    const { owner, id, row } = await standingOffer();
    const other = await person();
    const otherRow = await grant(id, other, 'EDITOR');
    expect((await removal(owner.cookie, id, otherRow)).status).toBe(200);
    expect(await db().documentCollaborator.count({ where: { id: row } })).toBe(1);
    expect((await offerOf(id)).state).toBe('PENDING');
  });

  // Weakening: a deletion carried out in the name of someone who is no longer the Owner.
  it('does not delete a document in the name of its former Owner: a deletion authorised just before the transfer', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const deleted = await holding(
      id,
      () => deleteDocument({ id }, owner.id),
      async (tx) => {
        // The acceptance, committed first.
        await tx.document.update({ where: { id }, data: { ownerId: editor.id } });
      },
    );
    expect(deleted).toBe(false);
    expect((await db().document.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
  });
});

// ── Under the lock ──────────────────────────────────────────────────────────

describe('what authorises an answer is read again under the lock of the document', () => {
  // Weakening: no lock on the document in the acceptance, or the rows read before it.
  it('an acceptance waits for the row, and meets an Editor who was removed while it waited', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    const response = await holding(
      id,
      () => accept(editor.cookie, made.id),
      // The removal, committed first, without the withdrawal that the route makes: the rows alone are read.
      async (tx) => void (await tx.documentCollaborator.delete({ where: { id: row } })),
    );
    expect(response.status).toBe(404);
    expect(await code(response)).toBe('no_longer_open');
    expect((await standing(id)).ownerId).toBe(owner.id);
    expect(await offersOf(id)).toMatchObject([{ state: 'WITHDRAWN' }]);
    expect(await logged(id)).toEqual([]);
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(0);
  });

  it('an acceptance meets an offer that was withdrawn while it waited', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    const response = await holding(
      id,
      () => accept(editor.cookie, made.id),
      async (tx) =>
        void (await tx.ownershipOffer.update({
          where: { id: made.id },
          data: { state: 'WITHDRAWN', respondedAt: new Date() },
        })),
    );
    expect(response.status).toBe(404);
    expect((await standing(id)).ownerId).toBe(owner.id);
  });

  // Weakening: the time read before the wait for the row.
  it('an acceptance that waited for the row past the offer’s time is refused', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    await db().ownershipOffer.update({
      where: { id: made.id },
      data: { expiresAt: new Date(Date.now() + 1500) },
    });
    const response = await holding(
      id,
      () => accept(editor.cookie, made.id),
      // Still holding the row, past the time of the offer.
      async () => void (await sleep(2200)),
    );
    expect(response.status).toBe(404);
    expect(await code(response)).toBe('no_longer_open');
    expect((await standing(id)).ownerId).toBe(owner.id);
  });

  it('an acceptance meets a document that was deleted while it waited', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    const response = await holding(
      id,
      () => accept(editor.cookie, made.id),
      async (tx) =>
        void (await tx.document.update({
          where: { id },
          data: { deletedAt: new Date(), deletedById: owner.id },
        })),
    );
    expect(response.status).toBe(404);
    expect((await standing(id)).ownerId).toBe(owner.id);
    expect((await offerOf(id)).state).toBe('PENDING');
  });

  // Weakening: the Owner's role not read again in the withdrawal.
  it('a withdrawal by an Owner who passed the document on while it waited is refused, and the offer stands as accepted', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);
    const response = await holding(
      id,
      () => withdraw(owner.cookie, id),
      async (tx) => {
        // The acceptance, committed first.
        await tx.ownershipOffer.update({ where: { id: made.id }, data: { state: 'ACCEPTED' } });
        await tx.documentCollaborator.delete({ where: { id: row } });
        await tx.document.update({ where: { id }, data: { ownerId: editor.id } });
        await tx.documentCollaborator.create({ data: { documentId: id, userId: owner.id, role: 'EDITOR' } });
      },
    );
    expect(response.status).toBe(403);
    expect((await offerOf(id)).state).toBe('ACCEPTED');
  });
});

// ── The email, with the timer as its backstop ───────────────────────────────

describe('the email of an offer: after the response, and by the timer where that did not happen (NFR-RE-15; S17-6)', () => {
  const sunkFor = async (address: string) => (await mail()).filter(({ to }) => to === address);

  // Weakening: no timer, or a timer that sends without the claim.
  it('sends an open offer that nothing sent, once, and sends it no more', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    // The process stopped between the commit and the hand-over: what the response left is lost.
    later.length = 0;
    expect((await offerOf(id)).emailClaimedAt).toBeNull();
    expect(await sunkFor(editor.email)).toHaveLength(0);
    expect(await deliverUnsentOffers()).toBe(0);
    expect(await sunkFor(editor.email)).toHaveLength(1);
    expect((await offerOf(id)).emailClaimedAt).not.toBeNull();
    expect(await deliverUnsentOffers()).toBe(0);
    expect(await sunkFor(editor.email)).toHaveLength(1);
  });

  it('sends one where the hand-over after the response and the timer race, and two timers at once', async () => {
    for (let round = 0; round < 4; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      await Promise.all([afterResponses(), deliverUnsentOffers(), deliverUnsentOffers()]);
      expect(await sunkFor(editor.email), String(round)).toHaveLength(1);
    }
  });

  it('sends nothing for an offer that was sent, expired or withdrawn', async () => {
    const sent = await pair();
    expect((await offer(sent.owner.cookie, sent.id, sent.row)).status).toBe(201);
    await afterResponses();
    const expired = await pair();
    expect((await offer(expired.owner.cookie, expired.id, expired.row)).status).toBe(201);
    await db().ownershipOffer.updateMany({
      where: { documentId: expired.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const withdrawn = await pair();
    expect((await offer(withdrawn.owner.cookie, withdrawn.id, withdrawn.row)).status).toBe(201);
    expect((await withdraw(withdrawn.owner.cookie, withdrawn.id)).status).toBe(200);
    later.length = 0;
    await deliverUnsentOffers();
    for (const each of [sent, expired, withdrawn]) {
      expect(await sunkFor(each.editor.email)).toHaveLength(each === sent ? 1 : 0);
    }
  });
});

// ── The former Owner's address (S17-12) ─────────────────────────────────────

describe('inviting the address of a former Owner (FR-ED-37; S17-12)', () => {
  it('is refused to the Owner as an address of a person who already holds a role, and nothing is created', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    const { POST } = await import('../../src/app/api/documents/[id]/invitations/route.ts');
    const asked = (cookie: string, email: string) =>
      POST(
        request('POST', `/api/documents/${id}/invitations`, cookie, { emails: [email], role: 'viewer' }),
        at({ id }),
      );
    // Weakening: the refusal keyed on an accepted invitation alone.
    const refused = await asked(editor.cookie, owner.email);
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe('collaborator_address');
    expect(await db().documentInvitation.count({ where: { documentId: id } })).toBe(0);
    // An address that holds no role is invited as before.
    expect((await asked(editor.cookie, 'someone@example.com')).status).toBe(201);
  });
});

// ── The conflict on the index of one pending offer ──────────────────────────

describe('the index of one pending offer, met by an offer that the check did not see', () => {
  // Weakening: the catch of the conflict left out, which answers a 500.
  it('answers 409 offer_pending and leaves no offer', async () => {
    const { owner, id, row } = await pair();
    // A pending offer that appears as the offer is written, which the check before it could not have seen.
    database.sql(
      `CREATE FUNCTION shadow_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
         INSERT INTO "ekdotico"."OwnershipOffer" ("id", "documentId", "fromUserId", "toUserId", "expiresAt")
         VALUES ('shadow-' || NEW."id", NEW."documentId", NEW."toUserId", NEW."fromUserId", NEW."expiresAt");
         RETURN NEW; END $$;
       CREATE TRIGGER shadow_for_test BEFORE INSERT ON "OwnershipOffer" FOR EACH ROW WHEN (NEW."id" NOT LIKE 'shadow-%') EXECUTE FUNCTION shadow_for_test();`,
    );
    try {
      const response = await offer(owner.cookie, id, row);
      expect(response.status).toBe(409);
      expect(await code(response)).toBe('offer_pending');
    } finally {
      database.sql(`DROP TRIGGER shadow_for_test ON "OwnershipOffer"; DROP FUNCTION shadow_for_test();`);
    }
    expect(await offersOf(id)).toEqual([]);
    expect(
      await notificationsFor(
        (await db().documentCollaborator.findUniqueOrThrow({ where: { id: row } })).userId,
      ),
    ).toEqual([]);
  });
});

// ── The delete that a transfer overtook ─────────────────────────────────────

describe('a deletion authorised before a transfer', () => {
  it('is answered by a logged 403 to the former Owner, and the document is not deleted', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const document = await import('../../src/app/api/documents/[id]/route.ts');
    const response = await holding(
      id,
      () => document.DELETE(request('DELETE', `/api/documents/${id}`, owner.cookie), at({ id })),
      async (tx) => {
        await tx.documentCollaborator.delete({ where: { id: row } });
        await tx.document.update({ where: { id }, data: { ownerId: editor.id } });
        await tx.documentCollaborator.create({ data: { documentId: id, userId: owner.id, role: 'EDITOR' } });
      },
    );
    expect(response.status).toBe(403);
    expect(await message(response)).toBe('Only the Owner of the document can do this.');
    expect((await db().document.findUniqueOrThrow({ where: { id } })).deletedAt).toBeNull();
    expect((await logged(id)).at(-1)).toEqual({ kind: 'forbidden', userId: owner.id });
  });
});

// ── Invitations after a transfer ────────────────────────────────────────────

describe('an invitation request that was authorised before a transfer meets the rows as the transfer left them', () => {
  const invitations = () => import('../../src/app/api/documents/[id]/invitations/route.ts');
  const revocation = () => import('../../src/app/api/documents/[id]/invitations/[invitationId]/route.ts');
  /** The acceptance's writes, committed under the hold. */
  const transfer =
    (id: string, owner: Person, editor: Person, row: string) =>
    async (tx: Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0]) => {
      await tx.documentCollaborator.delete({ where: { id: row } });
      await tx.document.update({ where: { id }, data: { ownerId: editor.id } });
      await tx.documentCollaborator.create({ data: { documentId: id, userId: owner.id, role: 'EDITOR' } });
    };

  // Weakening: the inviter's role and permission not read again under the lock.
  it('refuses the former Owner’s invitation, and creates none', async () => {
    const { owner, editor, id, row } = await pair();
    const { POST } = await invitations();
    const response = await holding(
      id,
      () =>
        POST(
          request('POST', `/api/documents/${id}/invitations`, owner.cookie, {
            emails: ['someone@example.com'],
            role: 'viewer',
          }),
          at({ id }),
        ),
      transfer(id, owner, editor, row),
    );
    expect(response.status).toBe(403);
    expect(await code(response)).toBe('forbidden');
    expect(await db().documentInvitation.count({ where: { documentId: id } })).toBe(0);
  });

  it('refuses the former Owner’s revocation, and revokes none', async () => {
    const { owner, editor, id, row } = await pair();
    const made = await db().documentInvitation.create({
      data: {
        documentId: id,
        email: 'someone@example.com',
        role: 'VIEWER',
        invitedById: owner.id,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 1e6),
      },
    });
    const { DELETE } = await revocation();
    const response = await holding(
      id,
      () =>
        DELETE(
          request('DELETE', `/api/documents/${id}/invitations/${made.id}`, owner.cookie),
          at({ id, invitationId: made.id }),
        ),
      transfer(id, owner, editor, row),
    );
    expect(response.status).toBe(403);
    expect((await db().documentInvitation.findUniqueOrThrow({ where: { id: made.id } })).state).toBe(
      'PENDING',
    );
  });
});

// ── Expired and removed ─────────────────────────────────────────────────────

describe('an offer past its time is left to the timer', () => {
  it('is written expired by the timer, and not withdrawn by a removal or a deletion that meets it first', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    await db().ownershipOffer.updateMany({
      where: { documentId: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await removal(owner.cookie, id, row)).status).toBe(200);
    expect((await offerOf(id)).state).toBe('PENDING');
    expect(await expireOffers()).toBeGreaterThanOrEqual(1);
    expect((await offerOf(id)).state).toBe('EXPIRED');
    expect(editor.id).not.toBe(owner.id);
  });
});

// ── Accept against the rest, at once ────────────────────────────────────────

describe('an acceptance and a change at once are one after the other, and there is one Owner after each (FR-ED-19)', () => {
  const rounds = 6;
  const invariant = async (id: string) => {
    const after = await standing(id);
    // One Owner, who holds no row; at most one pending offer.
    expect(after.owners).toBe(0);
    expect(after.pending).toBeLessThanOrEqual(1);
    expect(await db().document.count({ where: { id } })).toBe(1);
    return after;
  };

  // Weakening: no lock on the document.
  it('an acceptance and a withdrawal', async () => {
    for (let round = 0; round < rounds; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      const [accepted, withdrawn] = await Promise.all([
        accept(editor.cookie, made.id),
        withdraw(owner.cookie, id),
      ]);
      const after = await invariant(id);
      if (accepted.status === 200) {
        // The acceptance came first: the Owner of the request is no Owner now.
        expect(after.ownerId).toBe(editor.id);
        expect([403, 404]).toContain(withdrawn.status);
        expect((await offerOf(id)).state).toBe('ACCEPTED');
      } else {
        expect(accepted.status).toBe(404);
        expect(withdrawn.status).toBe(200);
        expect(after.ownerId).toBe(owner.id);
        expect((await offerOf(id)).state).toBe('WITHDRAWN');
      }
    }
  });

  it('an acceptance and an expiry', async () => {
    for (let round = 0; round < rounds; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      await db().ownershipOffer.update({
        where: { id: made.id },
        data: { expiresAt: new Date(Date.now() + 150) },
      });
      await sleep(120);
      const [accepted] = await Promise.all([
        accept(editor.cookie, made.id),
        expireOffers(new Date(Date.now() + 1000)),
      ]);
      const after = await invariant(id);
      // Whichever came first decided; the offer is in one terminal state and the roles agree with it.
      const state = (await offerOf(id)).state;
      if (state === 'ACCEPTED') {
        expect(accepted.status).toBe(200);
        expect(after.ownerId).toBe(editor.id);
      } else {
        expect(state).toBe('EXPIRED');
        expect(accepted.status).toBe(404);
        expect(after.ownerId).toBe(owner.id);
      }
    }
  });

  it('an acceptance and the removal of the Editor', async () => {
    for (let round = 0; round < rounds; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      const [accepted, removed] = await Promise.all([
        accept(editor.cookie, made.id),
        removal(owner.cookie, id, row),
      ]);
      const after = await invariant(id);
      if (accepted.status === 200) {
        // The acceptance first: the row removed was the Owner's own (deleted), so the request found no one.
        expect(after.ownerId).toBe(editor.id);
        expect([403, 404]).toContain(removed.status);
      } else {
        expect(removed.status).toBe(200);
        expect(after.ownerId).toBe(owner.id);
        expect((await offerOf(id)).state).toBe('WITHDRAWN');
        expect(after.collaborators).toEqual([]);
      }
    }
  });

  it('an acceptance and a change of the Editor’s role', async () => {
    for (let round = 0; round < rounds; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      const [accepted, changed] = await Promise.all([
        accept(editor.cookie, made.id),
        changeRole(owner.cookie, id, row, 'viewer'),
      ]);
      const after = await invariant(id);
      if (accepted.status === 200) {
        expect(after.ownerId).toBe(editor.id);
        expect([403, 404]).toContain(changed.status);
        expect(after.collaborators).toEqual([`${owner.id}:EDITOR`]);
      } else {
        expect(changed.status).toBe(200);
        expect(after.ownerId).toBe(owner.id);
        expect(after.collaborators).toEqual([`${editor.id}:VIEWER`]);
      }
    }
  });

  it('an acceptance and the deletion of the document', async () => {
    for (let round = 0; round < rounds; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      const [accepted, deleted] = await Promise.all([
        accept(editor.cookie, made.id),
        deleteDocument({ id }, owner.id),
      ]);
      const after = await invariant(id);
      const document = await db().document.findUniqueOrThrow({ where: { id } });
      if (accepted.status === 200) {
        // Transferred first: the deletion, in the name of the former Owner, found nothing to delete.
        expect(deleted).toBe(false);
        expect(document.deletedAt).toBeNull();
        expect(after.ownerId).toBe(editor.id);
      } else {
        expect(deleted).toBe(true);
        expect(document.deletedAt).not.toBeNull();
        expect(after.ownerId).toBe(owner.id);
        expect((await offerOf(id)).state).toBe('WITHDRAWN');
      }
    }
  });

  it('an acceptance and a leave of the Editor', async () => {
    for (let round = 0; round < rounds; round++) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const made = await offerOf(id);
      const [accepted, left] = await Promise.all([accept(editor.cookie, made.id), leave(editor.cookie, id)]);
      const after = await invariant(id);
      if (accepted.status === 200) {
        expect(after.ownerId).toBe(editor.id);
        // The new Owner cannot leave: refused by the permission (403), or the row is gone when the leave reaches the lock (404).
        expect([403, 404]).toContain(left.status);
      } else {
        expect(left.status).toBe(204);
        expect(after.ownerId).toBe(owner.id);
      }
      void row;
    }
  });

  it('an offer and an offer of the same document, by the former Owner and the new', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    // The former Owner, an Editor now, offers nothing; the new Owner offers it back.
    const back = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId: id, userId: owner.id },
    });
    expect((await offer(owner.cookie, id, back.id)).status).toBe(403);
    expect((await offer(editor.cookie, id, back.id)).status).toBe(201);
    expect((await accept(owner.cookie, (await offersOf(id)).at(-1)!.id)).status).toBe(200);
    const after = await standing(id);
    expect(after).toMatchObject({ ownerId: owner.id, owners: 0, pending: 0 });
    expect(after.collaborators).toEqual([`${editor.id}:EDITOR`]);
  });
});

// ── The notification list ───────────────────────────────────────────────────

describe('the notification list (FR-ED-42)', () => {
  // One list: the offers' notifications are of the kind `ownership_offer`, beside the others (src/lib/documents/sharing.ts).
  const list = async (who: Person) => {
    const body = (await (
      await notifications.GET(request('GET', '/api/notifications', who.cookie))
    ).json()) as {
      unread: number;
      notifications: { kind: string }[];
    };
    return {
      unread: body.unread,
      notifications: body.notifications.filter(({ kind }) => kind !== 'ownership_offer'),
      offers: body.notifications.filter(({ kind }) => kind === 'ownership_offer') as unknown as {
        id: string;
        offerId: string;
        ownerName: string;
        title: string;
        read: boolean;
      }[],
    };
  };
  const mark = (who: Person, id: string) =>
    notification.PATCH(request('PATCH', `/api/notifications/${id}`, who.cookie), at({ id }));

  it('lists the offer to its Editor with the unread count, with the title and no content, and to no one else', async () => {
    const { owner, editor, id, row } = await pair();
    await db().document.update({ where: { id }, data: { title: 'A quartz title' } });
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await offerOf(id);

    const seen = await list(editor);
    expect(seen.unread).toBe(1);
    expect(seen.offers).toMatchObject([
      { offerId: made.id, ownerName: 'Ada Owner', title: 'A quartz title', read: false },
    ]);
    expect(Object.keys(seen.offers[0]!).sort()).toEqual([
      'createdAt',
      'id',
      'kind',
      'offerId',
      'ownerName',
      'read',
      'title',
    ]);
    // Weakening: the list read for any account, or by an identifier of the request.
    for (const who of [owner, await person()]) {
      const other = await list(who);
      expect(other.offers).toEqual([]);
      expect(other.unread).toBe(0);
    }
  });

  it('marks it read for its recipient alone: to any other account the identifier is a 404, and the unread count follows', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const shown = (await list(editor)).offers[0]!.id;
    for (const who of [owner, await person()]) {
      expect((await mark(who, shown)).status).toBe(404);
    }
    expect((await notificationsFor(editor.id))[0]!.readAt).toBeNull();
    const marked = await mark(editor, shown);
    expect(marked.status).toBe(204);
    expect(await marked.text()).toBe('');
    const after = await list(editor);
    expect(after.unread).toBe(0);
    expect(after.offers).toMatchObject([{ read: true }]);
    // Marked once, it is still in the list; a notification that is not there is a 404.
    expect((await mark(editor, 'cm0000000000000000000000')).status).toBe(404);
  });

  it('stands with the invitations’ in one list and one count, and leaves an invitation’s notification as it was', async () => {
    const { owner, editor, id, row } = await pair();
    const second = await person('Cy Owner');
    const other = (await createDocument(second.id)).id;
    const invitation = await db().documentInvitation.create({
      data: {
        documentId: other,
        email: editor.email,
        role: 'VIEWER',
        invitedById: second.id,
        tokenHash: `hash-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 1e6),
        emailClaimedAt: new Date(),
      },
    });
    await db().notification.create({
      data: { recipientId: editor.id, kind: 'document_invitation', payload: { invitationId: invitation.id } },
    });
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const seen = await list(editor);
    expect(seen.unread).toBe(2);
    expect(seen.notifications).toHaveLength(1);
    expect(seen.offers).toHaveLength(1);
    // Marking the offer's notification marks no other.
    expect((await mark(editor, seen.offers[0]!.id)).status).toBe(204);
    expect((await list(editor)).unread).toBe(1);
  });

  it('drops from the list the moment the offer is no longer pending: accepted, declined, withdrawn, expired, or the document deleted', async () => {
    for (const end of ['accept', 'decline', 'withdraw', 'expire', 'delete'] as const) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      expect((await list(editor)).offers).toHaveLength(1);
      const made = await offerOf(id);
      if (end === 'accept') await accept(editor.cookie, made.id);
      if (end === 'decline') await decline(editor.cookie, made.id);
      if (end === 'withdraw') await withdraw(owner.cookie, id);
      if (end === 'expire') {
        await db().ownershipOffer.update({
          where: { id: made.id },
          data: { expiresAt: new Date(Date.now() - 1000) },
        });
      }
      if (end === 'delete') await deleteDocument({ id }, owner.id);
      expect((await list(editor)).offers, end).toEqual([]);
      expect((await list(editor)).unread, end).toBe(0);
    }
  });
});

// ── The permission, through the real route ──────────────────────────────────

describe('the document listing after a transfer', () => {
  it('shows the document to each person with the role now held, once', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await accept(editor.cookie, (await offerOf(id)).id)).status).toBe(200);
    expect((await listOf(owner.cookie)).filter((each) => each.id === id)).toMatchObject([
      { canDelete: false },
    ]);
    expect((await listOf(editor.cookie)).filter((each) => each.id === id)).toMatchObject([
      { canDelete: true },
    ]);
  });
});
