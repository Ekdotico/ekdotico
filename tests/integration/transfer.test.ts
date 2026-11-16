// The transfer of all documents (FR-AU-92; FR-ED-47, FR-ED-42, FR-AU-58, FR-AU-91; NFR-SE-03, NFR-SE-04, NFR-SE-07,
// NFR-SE-19, NFR-RE-15; register D72, D99, D100, D219; docs/plan/slice-24.md): the authorisation, the exactness of what
// is confirmed, the rules (a) and (b), the states, the exclusions, the accounts in deletion, the limit, the email and
// what is logged, against a provisioned database, with the routes as Next.js calls them. The races are in
// transfer-races.test.ts. Each test of a rule names the weakening that makes it fail (section 9 of the plan).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeOf, DAY_MS, json, MAIL, TITLE, world } from './clearing.ts';
import { MemoryStorage } from './image-storage.ts';
import { cookiesOf, load, PASSWORD, prepare, sunk } from './identity.ts';

// What a route leaves for after its response is collected here and run by the test when it wants it.
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const database = prepare('transfer', { EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { transferScreen, confirmTransfer } = await import('../../src/lib/account/transfer.ts');
const { deliverBatch, deliverUnsentBatches } = await import('../../src/lib/account/transfer-email.ts');
const { answerOffer, makeOffer, deliverUnsentOffers, withdrawOffer } =
  await import('../../src/lib/documents/ownership.ts');
const { takeLimit, clearLimit } = await import('../../src/lib/rate-limit.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');
const transferRoute = await import('../../src/app/api/account/documents/transfer/route.ts');
const deletionRoute = await import('../../src/app/api/account/deletion/route.ts');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, deletedAgo, request, row } = w;

afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(() => {
  later.length = 0;
  useImageStorage(new MemoryStorage());
});
afterEach(() => {
  vi.restoreAllMocks();
  later.length = 0;
});

type Person = Awaited<ReturnType<typeof person>>;

/** FR-AU-92, D285: the request holds the password beside its own fields. */
const prompted = (body: unknown) =>
  typeof body === 'object' && body !== null && !Array.isArray(body) ? { ...body, password: PASSWORD } : body;
const post = (cookie: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  transferRoute.POST(request('POST', '/api/account/documents/transfer', cookie, prompted(body), headers));
const getDeletion = (cookie: string) => deletionRoute.GET(request('GET', '/api/account/deletion', cookie));

// One instant for every time the rule of (a) reads, so that two Editors "held it equally long" exactly.
const T0 = Date.now();

/** An Editor of the document, with the times the rule of (a) reads, in days ago. */
async function editorOf(documentId: string, user: Person, since = 1, added = since) {
  return db().documentCollaborator.create({
    data: {
      documentId,
      userId: user.id,
      role: 'EDITOR',
      roleSince: new Date(T0 - since * DAY_MS),
      addedAt: new Date(T0 - added * DAY_MS),
    },
  });
}

const offersOf = (documentId: string) =>
  db().ownershipOffer.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
const offerNotifications = (recipientId: string) =>
  db().notification.findMany({ where: { recipientId, kind: 'ownership_offer' } });

/** The request of a confirmation for exactly what the screen shows now. */
async function everything(owner: Person) {
  const screen = await transferScreen(owner.id);
  return { mode: 'longest', documentIds: screen.longest.documentIds };
}

/** Runs what the routes left for after their responses. */
async function afterResponses() {
  for (const task of later.splice(0)) await task();
}

describe('authorisation', () => {
  // Mutation T01: the route does not read the session.
  it('answers a request without a session 401, and one from another origin 403, and offers nothing', async () => {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, editor);
    const body = await everything(owner);
    expect((await post(undefined, body)).status).toBe(401);
    expect((await post(owner.cookie, body, { origin: 'https://evil.example' })).status).toBe(403);
    expect(await offersOf(documentId)).toHaveLength(0);
  });

  // Mutation T02: the session's row is not read: a cookie whose session has ended is believed.
  it('refuses a session that has ended', async () => {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, editor);
    const body = await everything(owner);
    await db().session.deleteMany({ where: { userId: owner.id } });
    expect((await post(owner.cookie, body)).status).toBe(401);
    expect(await offersOf(documentId)).toHaveLength(0);
  });

  // Mutation T02a: the route reads the signed copy of the session, which serves a request that reads, for one that changes state.
  it('reads the session’s row and not its signed copy: a copy that is still fresh does not admit an ended session', async () => {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, editor);
    const body = await everything(owner);
    const read = await loaded.auth().api.getSession({
      headers: new Headers({ cookie: owner.cookie }),
      query: { disableCookieCache: true },
      returnHeaders: true,
    });
    const token = owner.cookie.split('; ').find((cookie) => cookie.includes('session_token='));
    const copy = `${token}; ${cookiesOf(read)}`;
    expect(copy).toContain('session_data=');
    await db().session.deleteMany({ where: { userId: owner.id } });
    expect((await post(copy, body)).status).toBe(401);
    expect(await offersOf(documentId)).toHaveLength(0);
  });

  // Mutation T02b: the session's row is not held inside the transaction.
  it('refuses, inside its transaction, a session that has ended since the request was authorised', async () => {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, editor);
    const body = await everything(owner);
    const session = await db().session.findFirstOrThrow({ where: { userId: owner.id } });
    await db().session.delete({ where: { id: session.id } });
    const result = await confirmTransfer(
      { userId: owner.id, sessionId: session.id },
      { mode: 'longest', documentIds: body.documentIds },
    );
    expect(result.outcome).toBe('ended');
    expect(await offersOf(documentId)).toHaveLength(0);
  });

  // Mutation T03: the lock and the plan read the documents of every account, not the Owner's.
  it('never offers a document of another account, and a request that names one offers nothing at all', async () => {
    const owner = await person();
    const other = await person('other');
    const editor = await person('editor');
    const mine = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    await editorOf(mine, editor);
    await editorOf(theirs, editor);
    const own = (await everything(owner)).documentIds;
    expect(own).toEqual([mine]);
    for (const documentIds of [[mine, theirs], [theirs]]) {
      const response = await post(owner.cookie, { mode: 'longest', documentIds });
      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe('documents_changed');
    }
    expect(await offersOf(mine)).toHaveLength(0);
    expect(await offersOf(theirs)).toHaveLength(0);
    expect(await offerNotifications(editor.id)).toHaveLength(0);
  });

  // Mutation T04: the row of "To one person" is not tied to the caller's documents.
  it("does not take a collaborator's row of another account's document for a person to offer to", async () => {
    const owner = await person();
    const other = await person('other');
    const editor = await person('editor');
    const mine = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    await editorOf(mine, editor);
    const row = await editorOf(theirs, editor);
    const response = await post(owner.cookie, {
      mode: 'person',
      collaboratorId: row.id,
      documentIds: [mine],
    });
    expect(response.status).toBe(404);
    expect(await offersOf(mine)).toHaveLength(0);
    expect(await offersOf(theirs)).toHaveLength(0);
  });

  // Mutation T05: the role of the row is not asked.
  it('offers to an Editor only: the row of a Viewer or a Reviewer is no person to offer to', async () => {
    const owner = await person();
    const viewer = await person('viewer');
    const documentId = await documentOf(owner.id);
    const viewing = await db().documentCollaborator.create({
      data: { documentId, userId: viewer.id, role: 'VIEWER' },
    });
    const response = await post(owner.cookie, {
      mode: 'person',
      collaboratorId: viewing.id,
      documentIds: [documentId],
    });
    expect(response.status).toBe(404);
    expect(await offersOf(documentId)).toHaveLength(0);
  });

  // Mutation T06: the body is not held to its fields.
  it('refuses a request of the wrong shape with a 422, and a body that is not JSON with a 415', async () => {
    const owner = await person();
    const documentId = await documentOf(owner.id);
    for (const body of [
      { mode: 'longest' },
      { mode: 'longest', documentIds: [documentId], userId: 'x' },
      { mode: 'person', documentIds: [documentId] },
      { mode: 'person', collaboratorId: '../x', documentIds: [documentId] },
      { mode: 'all', documentIds: [documentId] },
      { mode: 'longest', documentIds: ['not-a-document'] },
      { mode: 'longest', documentIds: [documentId.toUpperCase()] },
      [documentId],
      null,
    ]) {
      expect((await post(owner.cookie, body)).status, JSON.stringify(body)).toBe(422);
    }
    const plain = await transferRoute.POST(
      new Request('https://app.example.test/api/account/documents/transfer', {
        method: 'POST',
        headers: { origin: 'https://app.example.test', 'content-type': 'text/plain', cookie: owner.cookie },
        body: '{}',
      }),
    );
    expect(plain.status).toBe(415);
  });
});

describe('the identifiers are exactly what would be offered, and the rows decide', () => {
  // Mutation T07: the identifiers are not compared with the locked rows.
  it('offers nothing where the documents are not exactly those that were confirmed', async () => {
    const owner = await person();
    const editor = await person('editor');
    const one = await documentOf(owner.id);
    const two = await documentOf(owner.id);
    await editorOf(one, editor);
    await editorOf(two, editor);
    for (const documentIds of [[one], [one, two, randomUUID()], [one, one, two], []]) {
      const response = await post(owner.cookie, { mode: 'longest', documentIds });
      expect(response.status, JSON.stringify(documentIds)).toBe(409);
    }
    expect(await offersOf(one)).toHaveLength(0);
    expect(await offersOf(two)).toHaveLength(0);
  });

  // Mutation T08: the plan is made before the lock, from the screen's read.
  it('refuses what changed after the screen was read: a document deleted, one that gained its first Editor, an Editor removed', async () => {
    const owner = await person();
    const editor = await person('editor');
    const stays = await documentOf(owner.id);
    const goes = await documentOf(owner.id);
    await editorOf(stays, editor);
    const removable = await editorOf(goes, editor);
    const body = await everything(owner);
    expect(body.documentIds.sort()).toEqual([stays, goes].sort());

    await db().documentCollaborator.delete({ where: { id: removable.id } });
    expect((await post(owner.cookie, body)).status).toBe(409);
    await deletedAgo(goes, owner.id, 1000);
    expect((await post(owner.cookie, body)).status).toBe(409);
    expect(await offersOf(stays)).toHaveLength(0);

    // The refreshed screen is accepted.
    const fresh = await everything(owner);
    expect(fresh.documentIds).toEqual([stays]);
    expect((await post(owner.cookie, fresh)).status).toBe(201);

    const late = await documentOf(owner.id);
    await editorOf(late, editor);
    expect((await post(owner.cookie, fresh)).status).toBe(409);
  });

  it('answers 409 when there is nothing to offer, and offers nothing', async () => {
    const owner = await person();
    await documentOf(owner.id);
    const response = await post(owner.cookie, { mode: 'longest', documentIds: [] });
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe('nothing_to_offer');
  });
});

describe('the rules (a) and (b), each offer being an offer of FR-ED-47', () => {
  // Mutations T09 (the sort is by addedAt), T10 (the tie falls to the identifier first), T11 (the former Owner is counted from
  // the start of the collaboration).
  it('offers each document to its longest-standing Editor, with a tie to the earlier collaboration', async () => {
    const owner = await person();
    const [a, b, c] = [await person('a'), await person('b'), await person('c')];
    const byRole = await documentOf(owner.id);
    await editorOf(byRole, a, 5, 90);
    await editorOf(byRole, b, 40, 50);
    await editorOf(byRole, c, 20, 400);
    const byTie = await documentOf(owner.id);
    await editorOf(byTie, a, 10, 30);
    await editorOf(byTie, b, 10, 90);
    await editorOf(byTie, c, 10, 60);
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(201);
    expect((await offersOf(byRole)).map(({ toUserId }) => toUserId)).toEqual([b.id]);
    expect((await offersOf(byTie)).map(({ toUserId }) => toUserId)).toEqual([b.id]);
  });

  it('counts a former Owner from the time of the transfer, as the acceptance wrote it', async () => {
    const first = await person('first');
    const next = await person('next');
    const long = await person('long');
    const documentId = await documentOf(first.id);
    const mine = await editorOf(documentId, next);
    await editorOf(documentId, long, 30, 30);
    const made = await makeOffer(documentId, first.id, mine.id);
    expect(made.outcome).toBe('offered');
    const [offer] = await offersOf(documentId);
    expect((await answerOffer(next.id, offer!.id, 'accept')).outcome).toBe('accepted');
    // `first` is an Editor since the transfer, a moment ago: `long` has held the role for 30 days.
    const response = await post(next.cookie, await everything(next));
    expect(response.status).toBe(201);
    const [, second] = await offersOf(documentId);
    expect(second?.toUserId).toBe(long.id);
  });

  it('makes offers that are FR-ED-47’s: pending, fourteen days, one notification each, one expiry, one batch', async () => {
    const owner = await person();
    const editor = await person('editor');
    const second = await person('second');
    const one = await documentOf(owner.id);
    const two = await documentOf(owner.id);
    await editorOf(one, editor);
    await editorOf(two, second);
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ offered: 2, kept: 0, cannot: 0 });
    const offers = [...(await offersOf(one)), ...(await offersOf(two))];
    expect(offers).toHaveLength(2);
    expect(new Set(offers.map(({ expiresAt }) => expiresAt.getTime())).size).toBe(1);
    expect(new Set(offers.map(({ batchId }) => batchId)).size).toBe(1);
    expect(offers[0]?.batchId).toMatch(/^[0-9a-f-]{36}$/);
    for (const offer of offers) {
      expect(offer.state).toBe('PENDING');
      expect(offer.fromUserId).toBe(owner.id);
      expect(offer.expiresAt.getTime() - offer.createdAt.getTime()).toBe(14 * DAY_MS);
    }
    const notices = await offerNotifications(editor.id);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toEqual({ offerId: (await offersOf(one))[0]!.id });
    // Ownership has not changed: the Owner stays the Owner until an Editor accepts.
    expect((await row(one))?.ownerId).toBe(owner.id);
  });

  // Mutation T12: "To one person" offers every document with an Editor.
  it('offers a chosen person only the documents they edit, and counts the others as not offered', async () => {
    const owner = await person();
    const ada = await person('ada');
    const bo = await person('bo');
    const both = await documentOf(owner.id);
    const adaOnly = await documentOf(owner.id);
    const boOnly = await documentOf(owner.id);
    const adaRow = await editorOf(both, ada, 5);
    await editorOf(both, bo, 50);
    const adaOnlyRow = await editorOf(adaOnly, ada);
    await editorOf(boOnly, bo);

    const screen = await transferScreen(owner.id);
    // The screen names a person by one of their rows.
    const asAda = screen.people.find(({ collaboratorId }) =>
      [adaRow.id, adaOnlyRow.id].includes(collaboratorId),
    );
    expect(asAda).toMatchObject({ offered: 2, cannot: 1 });
    // The screen names each person once, by one row, and sends no account identifier.
    expect(screen.people).toHaveLength(2);
    expect(JSON.stringify(screen.people)).not.toContain(ada.id);

    const response = await post(owner.cookie, {
      mode: 'person',
      collaboratorId: asAda!.collaboratorId,
      documentIds: asAda!.documentIds,
    });
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ offered: 2, kept: 0, cannot: 1 });
    // `bo` is the longest-standing Editor of `both`, but the user chose Ada.
    expect((await offersOf(both)).map(({ toUserId }) => toUserId)).toEqual([ada.id]);
    expect((await offersOf(adaOnly)).map(({ toUserId }) => toUserId)).toEqual([ada.id]);
    expect(await offersOf(boOnly)).toHaveLength(0);
  });

  // Mutation T13: a pending offer is replaced by a new one, or counted again.
  it('keeps a document’s pending offer, counts it as offered, and makes no second offer, notification or email', async () => {
    const owner = await person();
    const kept = await person('kept');
    const better = await person('better');
    const documentId = await documentOf(owner.id);
    const keptRow = await editorOf(documentId, kept, 1);
    await editorOf(documentId, better, 100);
    const fresh = await documentOf(owner.id);
    await editorOf(fresh, better);
    expect((await makeOffer(documentId, owner.id, keptRow.id)).outcome).toBe('offered');
    const response = await post(owner.cookie, await everything(owner));
    expect(await json(response)).toEqual({ offered: 1, kept: 1, cannot: 0 });
    const offers = await offersOf(documentId);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.toUserId).toBe(kept.id);
    expect(await offerNotifications(kept.id)).toHaveLength(1);
    expect(await offerNotifications(better.id)).toHaveLength(1);
    // Repeating the confirmed action makes nothing new.
    const again = await post(owner.cookie, await everything(owner));
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ offered: 0, kept: 2, cannot: 0 });
    expect(await offersOf(fresh)).toHaveLength(1);
  });

  // Mutation T13b: the pending offers are not settled under the lock.
  it('settles an offer whose Editor lost the role without the offer being ended, and does not keep it', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    const edRow = await editorOf(documentId, ed);
    expect((await makeOffer(documentId, owner.id, edRow.id)).outcome).toBe('offered');
    const body = await everything(owner);
    expect(body.documentIds).toEqual([documentId]);
    // The role is lowered by a write that does not end the offer: the stored offer is pending, and wrong.
    await db().documentCollaborator.update({ where: { id: edRow.id }, data: { role: 'VIEWER' } });
    const response = await post(owner.cookie, body);
    expect(response.status).toBe(409);
    const [offer] = await offersOf(documentId);
    expect(offer?.state).toBe('WITHDRAWN');
  });

  // Mutation T14: the Editor who declined is offered again by the rule of (a).
  it('offers the Editor who is next after a decline or an expiry, and not the same one again', async () => {
    const owner = await person();
    const first = await person('first');
    const second = await person('second');
    const declined = await documentOf(owner.id);
    await editorOf(declined, first, 50);
    await editorOf(declined, second, 10);
    const expired = await documentOf(owner.id);
    await editorOf(expired, first, 50);
    await editorOf(expired, second, 10);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    const [d] = await offersOf(declined);
    const [e] = await offersOf(expired);
    expect(d?.toUserId).toBe(first.id);
    await answerOffer(first.id, d!.id, 'decline');
    await db().ownershipOffer.update({
      where: { id: e!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const screen = await transferScreen(owner.id);
    expect(screen.documents.find(({ id }) => id === declined)?.state).toMatchObject({ kind: 'declined' });
    expect(screen.documents.find(({ id }) => id === expired)?.state).toMatchObject({ kind: 'expired' });
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    expect((await offersOf(declined)).map(({ toUserId }) => toUserId)).toEqual([first.id, second.id]);
    expect((await offersOf(expired)).map(({ toUserId }) => toUserId)).toEqual([first.id, second.id]);

    // Nobody is left: the document has no other Editor, and cannot be offered by (a).
    await answerOffer(second.id, (await offersOf(declined))[1]!.id, 'decline');
    const last = await transferScreen(owner.id);
    expect(last.documents.find(({ id }) => id === declined)?.state).toMatchObject({
      kind: 'no_other_editor',
    });
    expect(last.longest.documentIds).toEqual([expired]);
  });
});

describe('the state of each document', () => {
  it('lists offered, declined, expired, without an Editor, not offered yet, deleted, being deleted and not transferable', async () => {
    const owner = await person();
    const ed = await person('ed');
    const offered = await documentOf(owner.id, 'offered');
    const declined = await documentOf(owner.id, 'declined');
    const expired = await documentOf(owner.id, 'expired');
    const none = await documentOf(owner.id, 'none');
    const ready = await documentOf(owner.id, 'ready');
    const deleted = await documentOf(owner.id, 'deleted');
    const being = await documentOf(owner.id, 'being');
    const recorded = await documentOf(owner.id, 'recorded');
    const rows: Record<string, { id: string; row: Awaited<ReturnType<typeof editorOf>> }> = {};
    for (const [name, id] of Object.entries({
      offered,
      declined,
      expired,
      ready,
      deleted,
      being,
      recorded,
    })) {
      rows[name] = { id, row: await editorOf(id, ed) };
    }
    await makeOffer(offered, owner.id, rows.offered!.row.id);
    await makeOffer(declined, owner.id, rows.declined!.row.id);
    await makeOffer(expired, owner.id, rows.expired!.row.id);
    const [dec] = await offersOf(declined);
    await answerOffer(ed.id, dec!.id, 'decline');
    await db().ownershipOffer.updateMany({
      where: { documentId: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await deletedAgo(deleted, owner.id, DAY_MS);
    await db().document.update({ where: { id: being }, data: { clearingAt: new Date(Date.now() - 1000) } });
    await db().document.update({ where: { id: recorded }, data: { recording: 'RECORDED' } });

    const screen = await transferScreen(owner.id);
    const state = (id: string) => screen.documents.find((d) => d.id === id)?.state;
    expect(state(offered)).toMatchObject({ kind: 'offered', toName: 'A Person' });
    expect(state(declined)).toMatchObject({ kind: 'no_other_editor' });
    expect(state(expired)).toMatchObject({ kind: 'no_other_editor' });
    expect(state(none)).toEqual({ kind: 'no_editor' });
    expect(state(ready)).toEqual({ kind: 'ready' });
    expect(state(deleted)).toEqual({ kind: 'deleted' });
    expect(state(being)).toEqual({ kind: 'being_deleted' });
    expect(state(recorded)).toEqual({ kind: 'not_transferable' });
    // The offered one is kept and the ready one is offered; the declined and the expired one have no Editor next by the rule of (a).
    expect(screen.longest.offered).toBe(1);
    expect(screen.longest.kept).toBe(1);
    expect(screen.longest.cannot).toBe(6);
  });

  it('shows a document of an earlier transfer that was accepted, while the account holds a role on it', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    expect((await transferScreen(owner.id)).accepted).toEqual([]);
    const [offer] = await offersOf(documentId);
    expect((await answerOffer(ed.id, offer!.id, 'accept')).outcome).toBe('accepted');
    const after = await transferScreen(owner.id);
    expect(after.documents).toEqual([]);
    expect(after.accepted).toEqual([{ id: documentId, title: TITLE, toName: 'A Person' }]);
    // The new Owner's screen does not list it as theirs to transfer back as accepted.
    expect((await transferScreen(ed.id)).accepted).toEqual([]);
    // Nor does it list it for a third person who holds a role on it: the list is the account's own offers.
    const bystander = await person('bystander');
    await editorOf(documentId, bystander);
    expect((await transferScreen(bystander.id)).accepted).toEqual([]);
    // When the account leaves the document, it leaves the list.
    await db().documentCollaborator.deleteMany({ where: { documentId, userId: owner.id } });
    expect((await transferScreen(owner.id)).accepted).toEqual([]);
  });

  // Mutation T15: the route lists every account's documents, or sends an address.
  it('answers GET /api/account/deletion with the account’s own documents and states, and no address or identifier of another account', async () => {
    const owner = await person();
    const other = await person('other');
    const ed = await person('ed');
    const mine = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    const edRow = await editorOf(mine, ed);
    await editorOf(theirs, ed);
    await makeOffer(mine, owner.id, edRow.id);
    const response = await getDeletion(owner.cookie);
    expect(response.status).toBe(200);
    const text = await response.clone().text();
    const body = (await json(response)) as {
      owned: number;
      deleted: number;
      documents: { id: string; state: string; to?: string }[];
    };
    expect(body.owned).toBe(1);
    expect(body.documents.map(({ id }) => id)).toEqual([mine]);
    expect(body.documents[0]).toMatchObject({ state: 'offered', to: 'A Person' });
    for (const secret of [ed.id, ed.email, other.id, other.email, theirs]) expect(text).not.toContain(secret);
    expect((await deletionRoute.GET(request('GET', '/api/account/deletion'))).status).toBe(401);
  });
});

describe('what cannot be offered', () => {
  // Mutations T16 (a deleted document is offered), T17 (a document whose day has come is offered).
  it('offers neither a deleted document nor one whose day of clearing has come, and offers one in its notice period', async () => {
    const owner = await person();
    const ed = await person('ed');
    const live = await documentOf(owner.id);
    const deleted = await documentOf(owner.id);
    const due = await documentOf(owner.id);
    const waiting = await documentOf(owner.id);
    for (const id of [live, deleted, due, waiting]) await editorOf(id, ed);
    await deletedAgo(deleted, owner.id, DAY_MS);
    await db().document.update({ where: { id: due }, data: { clearingAt: new Date(Date.now() - 1000) } });
    await db().document.update({
      where: { id: waiting },
      data: { clearingAt: new Date(Date.now() + 3 * DAY_MS) },
    });
    const body = await everything(owner);
    expect(body.documentIds.sort()).toEqual([live, waiting].sort());
    expect((await post(owner.cookie, body)).status).toBe(201);
    expect(await offersOf(deleted)).toHaveLength(0);
    expect(await offersOf(due)).toHaveLength(0);
    expect(await offersOf(waiting)).toHaveLength(1);
    // The same documents named with the deleted one are refused.
    expect(
      (await post(owner.cookie, { mode: 'longest', documentIds: [live, waiting, deleted] })).status,
    ).toBe(409);
  });

  // Mutation T18: the acceptance of a bulk offer does not take the document out of the clearing.
  it('lets the Editor’s acceptance of an offer made here take a document out of its clearing (FR-AU-91)', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    await db().document.update({
      where: { id: documentId },
      data: { clearingAt: new Date(Date.now() + 3 * DAY_MS) },
    });
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    const [offer] = await offersOf(documentId);
    expect((await answerOffer(ed.id, offer!.id, 'accept')).outcome).toBe('accepted');
    const after = await row(documentId);
    expect(after?.ownerId).toBe(ed.id);
    expect(after?.clearingAt).toBeNull();
  });

  // Mutation T19: the document that is not transferable is offered.
  it('does not offer a recorded document', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    await db().document.update({ where: { id: documentId }, data: { recording: 'RECORDED' } });
    const response = await post(owner.cookie, { mode: 'longest', documentIds: [] });
    expect(response.status).toBe(409);
    expect(await offersOf(documentId)).toHaveLength(0);
  });
});

describe('an account in deletion can neither make nor receive an offer', () => {
  const leaving = (userId: string) =>
    db().accountDeletion.create({ data: { userId, requestedAt: new Date() } });

  // Mutation T20: the plan does not ask for the deletion of the Editors.
  it('passes over an Editor whose deletion is confirmed, for the next, and has no offer where there is no other', async () => {
    const owner = await person();
    const going = await person('going');
    const staying = await person('staying');
    const both = await documentOf(owner.id);
    const only = await documentOf(owner.id);
    await editorOf(both, going, 90);
    await editorOf(both, staying, 5);
    await editorOf(only, going, 90);
    await leaving(going.id);
    const screen = await transferScreen(owner.id);
    expect(screen.longest.documentIds).toEqual([both]);
    expect(screen.documents.find(({ id }) => id === only)?.state).toEqual({ kind: 'no_editor' });
    expect((await post(owner.cookie, { mode: 'longest', documentIds: [both] })).status).toBe(201);
    expect((await offersOf(both)).map(({ toUserId }) => toUserId)).toEqual([staying.id]);
    expect(await offersOf(only)).toHaveLength(0);
    expect(await offerNotifications(going.id)).toHaveLength(0);
  });

  // Mutation T21: the chosen person is not asked for their deletion.
  it('refuses to offer to a person whose deletion is confirmed, or whose account is a tombstone', async () => {
    const owner = await person();
    const going = await person('going');
    const erased = await person('erased');
    const documentId = await documentOf(owner.id);
    const goingRow = await editorOf(documentId, going);
    const erasedRow = await editorOf(documentId, erased);
    await leaving(going.id);
    await db().user.update({
      where: { id: erased.id },
      data: { email: null, name: null, erasedAt: new Date() },
    });
    for (const collaboratorId of [goingRow.id, erasedRow.id]) {
      const response = await post(owner.cookie, {
        mode: 'person',
        collaboratorId,
        documentIds: [documentId],
      });
      expect(response.status).toBe(404);
    }
    expect(await offersOf(documentId)).toHaveLength(0);
    const screen = await transferScreen(owner.id);
    expect(screen.people).toEqual([]);
    expect(screen.documents[0]?.state).toEqual({ kind: 'no_editor' });
  });

  // Mutation T22: the caller's own deletion is not asked for.
  it('makes no offer for an account whose deletion is confirmed', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    const body = await everything(owner);
    await leaving(owner.id);
    // By the route: the account has no session from the record.
    expect((await post(owner.cookie, body)).status).toBe(401);
    // By the library, with the session rows still there (the backstop of the rule).
    const session = await db().session.findFirstOrThrow({ where: { userId: owner.id } });
    const result = await confirmTransfer(
      { userId: owner.id, sessionId: session.id },
      { mode: 'longest', documentIds: body.documentIds },
    );
    expect(result.outcome).toBe('not_found');
    expect(await offersOf(documentId)).toHaveLength(0);
  });
});

describe('the limit of offers (NFR-SE-07, D219; one for each person emailed, D268)', () => {
  /** `count` documents of one owner, shared among `people` Editors, each document with one. */
  async function owning(count: number, people = 1) {
    const owner = await person();
    const editors: Person[] = [];
    for (let n = 0; n < people; n++) editors.push(await person('ed'));
    const ids: string[] = [];
    for (let n = 0; n < count; n++) {
      const id = await documentOf(owner.id);
      await editorOf(id, editors[n % people]!);
      ids.push(id);
    }
    return { owner, ids };
  }

  // Mutation T23: the action counts one for each document, or one for the action, or none.
  it('counts one for each person emailed: twenty people take the whole hour, and a further offer on its own is refused', async () => {
    const { owner, ids } = await owning(20, 20);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    const extra = await documentOf(owner.id);
    const ed = await person('ed2');
    const edRow = await editorOf(extra, ed);
    expect((await makeOffer(extra, owner.id, edRow.id)).outcome).toBe('rate_limited');
    expect(ids).toHaveLength(20);
  });

  // Mutation T23b (D268): the count goes back to one for each document.
  it('counts forty documents offered to one person as one, and thirty offered to three people as three', async () => {
    const one = await owning(40);
    expect((await post(one.owner.cookie, await everything(one.owner))).status).toBe(201);
    for (const id of one.ids) expect(await offersOf(id)).toHaveLength(1);
    // One of the twenty is used: nineteen more are allowed, and the twentieth is not.
    expect((await takeLimit('OFFERS_PER_USER', one.owner.id, 19)).ok).toBe(true);
    expect((await takeLimit('OFFERS_PER_USER', one.owner.id, 1)).ok).toBe(false);

    const three = await owning(30, 3);
    expect((await post(three.owner.cookie, await everything(three.owner))).status).toBe(201);
    expect((await takeLimit('OFFERS_PER_USER', three.owner.id, 17)).ok).toBe(true);
    expect((await takeLimit('OFFERS_PER_USER', three.owner.id, 1)).ok).toBe(false);
  });

  // Mutation T23c (D268): an offer made on its own counts one, and from the allowance that the action shares.
  it('counts an offer made on its own as one, from the allowance that the action shares', async () => {
    const { owner, ids } = await owning(4, 2);
    const first = await db().documentCollaborator.findFirstOrThrow({ where: { documentId: ids[0]! } });
    expect((await makeOffer(ids[0]!, owner.id, first.id)).outcome).toBe('offered');
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 17)).ok).toBe(true);
    // Eighteen of the twenty are taken, and the action emails two people: the two that are left.
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ offered: 3, kept: 1, cannot: 0 });
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 1)).ok).toBe(false);
  });

  // Mutation T23d (D268): a person whose document keeps its offer, and is not emailed, is counted.
  it('counts only the people it emails, and not a person whose document already has an offer', async () => {
    const { owner, ids } = await owning(2, 2);
    const first = await db().documentCollaborator.findFirstOrThrow({ where: { documentId: ids[0]! } });
    expect((await makeOffer(ids[0]!, owner.id, first.id)).outcome).toBe('offered');
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 18)).ok).toBe(true);
    // The first document keeps its offer, so the action emails one person, and one of the twenty is left.
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ offered: 1, kept: 1, cannot: 0 });
  });

  // Mutation T23e (D268): the refusal counts documents.
  it('refuses a whole action whose people are over the figure of the limit with a 409 that counts people, and offers nothing', async () => {
    const { owner, ids } = await owning(42, 21);
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(409);
    expect(await codeOf(response)).toBe('too_many_offers');
    const message = (await json(response)).error?.message ?? '';
    expect(message).toContain('at most 20 people');
    // 42 documents and 21 people: the refusal says 21.
    expect(message).toContain('This one would email 21.');
    expect(message).not.toContain('42');
    for (const id of ids) expect(await offersOf(id)).toHaveLength(0);
    // Nothing was counted: a single offer is still possible in full.
    const row = await db().documentCollaborator.findFirstOrThrow({ where: { documentId: ids[0]! } });
    expect((await makeOffer(ids[0]!, owner.id, row.id)).outcome).toBe('offered');
  });

  // Mutation T24: the action is partly done where the allowance is short.
  it('refuses the whole action with a 429 that states when to try again where the allowance is short for its people, and offers nothing', async () => {
    const { owner, ids } = await owning(10, 6);
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 15)).ok).toBe(true);
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(429);
    expect(Number(response.headers.get('retry-after'))).toBeGreaterThan(0);
    for (const id of ids) expect(await offersOf(id)).toHaveLength(0);
    // Nothing of this action was counted: with the hour cleared it goes through, in full.
    await clearLimit('OFFERS_PER_USER', owner.id);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
  });

  // Mutation T24b (D268): the allowance is judged by the documents.
  it('does not refuse an action for the documents it offers where the allowance covers its people', async () => {
    const { owner, ids } = await owning(10, 5);
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 15)).ok).toBe(true);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    for (const id of ids) expect(await offersOf(id)).toHaveLength(1);
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 1)).ok).toBe(false);
  });

  // Mutation T25: a kept offer is counted.
  it('does not count an offer that is kept, so that repeating the action with the allowance used up still answers', async () => {
    const { owner, ids } = await owning(4, 2);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    // The two people it emailed are counted: the rest of the hour is used up.
    expect((await takeLimit('OFFERS_PER_USER', owner.id, 18)).ok).toBe(true);
    const again = await post(owner.cookie, await everything(owner));
    expect(again.status).toBe(200);
    expect(await json(again)).toEqual({ offered: 0, kept: 4, cannot: 0 });
    expect(ids).toHaveLength(4);
  });

  // Mutation T25b: a kept offer is counted with the new ones.
  it('counts only the new offers of an action that also keeps some: nineteen kept and one new fit the hour', async () => {
    const { owner, ids } = await owning(20);
    for (const id of ids.slice(0, 19)) {
      const found = await db().documentCollaborator.findFirstOrThrow({ where: { documentId: id } });
      expect((await makeOffer(id, owner.id, found.id)).outcome).toBe('offered');
    }
    const response = await post(owner.cookie, await everything(owner));
    expect(response.status).toBe(201);
    expect(await json(response)).toEqual({ offered: 1, kept: 19, cannot: 0 });
  });
});

describe('the email (NFR-RE-15, FR-AU-92), and what is logged (NFR-SE-19)', () => {
  const sinkBefore = async () => (await sunk(MAIL)).length;
  // The timers hand over every unsent offer of the database: what earlier tests left unsent is not these tests’.
  beforeEach(() =>
    db().ownershipOffer.updateMany({ where: { emailClaimedAt: null }, data: { emailClaimedAt: new Date() } }),
  );

  // Mutation T26: one email for each offer, or the number is not stated.
  it('sends one email to each person offered, stating how many documents, and one for a single document in FR-ED-47’s words', async () => {
    const owner = await person();
    const many = await person('many');
    const solo = await person('solo');
    const ids = [await documentOf(owner.id), await documentOf(owner.id), await documentOf(owner.id)];
    await editorOf(ids[0]!, many);
    await editorOf(ids[1]!, many);
    await editorOf(ids[2]!, solo);
    const before = await sinkBefore();
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    await afterResponses();
    const sent = (await sunk(MAIL)).slice(before);
    expect(sent).toHaveLength(2);
    const toMany = sent.find(({ to }) => to === many.email);
    const toSolo = sent.find(({ to }) => to === solo.email);
    expect(toMany?.subject).toBe('An offer of ownership of 2 documents in Ekdotico');
    expect(toMany?.text).toContain('has offered you ownership of 2 documents that you edit in Ekdotico.');
    expect(toMany?.text).toContain('To accept or decline each one, open your notifications in Ekdotico:');
    expect(toSolo?.subject).toBe('An offer of ownership of a document in Ekdotico');
    expect(toSolo?.text).toContain('has offered you ownership of a document that you edit in Ekdotico.');
    // No title, no content, no document link, anywhere in the sink.
    for (const message of sent) {
      expect(`${message.subject}\n${message.text}`).not.toContain(TITLE);
      expect(message.text).not.toMatch(/\/documents\//);
    }
  });

  // Mutation T27: the claim is not made, so each delivery sends.
  it('sends it once however often it is handed over, on two deliveries at once and by the timer', async () => {
    const owner = await person();
    const ed = await person('ed');
    const ids = [await documentOf(owner.id), await documentOf(owner.id)];
    for (const id of ids) await editorOf(id, ed);
    const before = await sinkBefore();
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    const batchId = (await offersOf(ids[0]!))[0]!.batchId!;
    const sends: string[] = [];
    const spy = async (message: { subject: string }) => void sends.push(message.subject);
    await Promise.all([deliverBatch(batchId, ed.id, spy), deliverBatch(batchId, ed.id, spy)]);
    await deliverUnsentBatches(spy);
    await afterResponses();
    expect(sends).toHaveLength(1);
    expect((await sunk(MAIL)).length).toBe(before);
  });

  // Mutation T28: the timer does not hand over what a stopped process left.
  it('hands over, by the timer, what a process that stopped after the commit left, and the single path sends nothing for it', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    later.length = 0; // the process stopped: the tasks left for after the response never ran
    const sends: string[] = [];
    const spy = async (message: { to: string }) => void sends.push(message.to);
    await deliverUnsentOffers(spy);
    expect(sends).toEqual([]);
    await deliverUnsentBatches(spy);
    expect(sends).toEqual([ed.email]);
    await deliverUnsentBatches(spy);
    expect(sends).toHaveLength(1);
  });

  // Mutation T29: an offer that ended is counted, or an account in deletion is written to.
  it('counts only the offers still open, and sends nothing to an account whose deletion is confirmed', async () => {
    const owner = await person();
    const ed = await person('ed');
    const gone = await person('gone');
    const ids = [await documentOf(owner.id), await documentOf(owner.id), await documentOf(owner.id)];
    await editorOf(ids[0]!, ed);
    await editorOf(ids[1]!, ed);
    await editorOf(ids[2]!, gone);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    await answerOffer(ed.id, (await offersOf(ids[1]!))[0]!.id, 'decline');
    await db().accountDeletion.create({ data: { userId: gone.id, requestedAt: new Date() } });
    const batchId = (await offersOf(ids[0]!))[0]!.batchId!;
    const sends: { to: string; subject: string }[] = [];
    const spy = async (message: { to: string; subject: string }) => void sends.push(message);
    await deliverBatch(batchId, ed.id, spy);
    await deliverBatch(batchId, gone.id, spy);
    expect(sends.map(({ to, subject }) => ({ to, subject }))).toEqual([
      { to: ed.email, subject: 'An offer of ownership of a document in Ekdotico' },
    ]);
  });

  // Mutation T30: a title reaches a log line, or the action writes a line of the security log.
  it('writes no title to any log line and no line to the security log for the action itself', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    const lines: string[] = [];
    for (const channel of ['log', 'info', 'warn', 'error'] as const) {
      vi.spyOn(console, channel).mockImplementation(
        (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
      );
    }
    const logBefore = await db().securityLogEntry.count();
    const body = await everything(owner);
    expect((await post(owner.cookie, body)).status).toBe(201);
    expect((await post(owner.cookie, { mode: 'longest', documentIds: [randomUUID()] })).status).toBe(409);
    await afterResponses();
    expect(lines.filter((line) => line.includes(TITLE))).toEqual([]);
    expect(await db().securityLogEntry.count()).toBe(logBefore);
  });
});

describe('one Owner for every document', () => {
  // Mutation T31: the bulk writes the Owner or the roles itself (the one place is the acceptance).
  it('leaves each document with exactly one Owner after any mix of acceptance, decline and silence', async () => {
    const owner = await person();
    const [a, b, c] = [await person('a'), await person('b'), await person('c')];
    const ids = [await documentOf(owner.id), await documentOf(owner.id), await documentOf(owner.id)];
    await editorOf(ids[0]!, a);
    await editorOf(ids[1]!, b);
    await editorOf(ids[2]!, c);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    // Nothing has changed hands by the offers alone.
    for (const id of ids) expect((await row(id))?.ownerId).toBe(owner.id);
    await answerOffer(a.id, (await offersOf(ids[0]!))[0]!.id, 'accept');
    await answerOffer(b.id, (await offersOf(ids[1]!))[0]!.id, 'decline');
    for (const id of ids) {
      const document = await db().document.findUniqueOrThrow({
        where: { id },
        include: { collaborators: true },
      });
      const holders = [document.ownerId, ...document.collaborators.map(({ userId }) => userId)];
      // The Owner holds no collaborator row; nobody appears twice.
      expect(new Set(holders).size).toBe(holders.length);
      expect(document.collaborators.map(({ userId }) => userId)).not.toContain(document.ownerId);
    }
    const first = await db().document.findUniqueOrThrow({
      where: { id: ids[0]! },
      include: { collaborators: true },
    });
    expect(first.ownerId).toBe(a.id);
    expect(first.collaborators).toMatchObject([{ userId: owner.id, role: 'EDITOR' }]);
    expect((await row(ids[1]!))?.ownerId).toBe(owner.id);
    expect((await row(ids[2]!))?.ownerId).toBe(owner.id);
  });
});

// The review of pull request 64 (docs/plan/slice-24.md, section 10).
describe('review of pull request 64', () => {
  // Item 2, mutation I2: the offers are settled with a statement for each document, and the transaction runs out of time.
  it('settles thousands of stale offers inside the time of the transaction, as the same writes as for one document', async () => {
    const owner = await person();
    const ed = await person('ed');
    const template = await documentOf(owner.id);
    const { id, ...fields } = await db().document.findUniqueOrThrow({ where: { id: template } });
    expect(id).toBe(template);
    const COUNT = 6000;
    const copies = Array.from({ length: COUNT }, () => ({
      ...fields,
      permissionSet: fields.permissionSet as never,
      id: randomUUID(),
    }));
    await db().document.createMany({ data: copies });
    const ids = [template, ...copies.map(({ id }) => id)];
    await db().documentCollaborator.createMany({
      data: ids.map((documentId) => ({ documentId, userId: ed.id, role: 'EDITOR' as const })),
    });
    // All but the template carry an offer stored pending whose time has passed; `ed` is an Editor of each, so the
    // offers are expired and not withdrawn.
    await db().ownershipOffer.createMany({
      data: ids.slice(1).map((documentId) => ({
        documentId,
        fromUserId: owner.id,
        toUserId: ed.id,
        createdAt: new Date(Date.now() - 20 * DAY_MS),
        expiresAt: new Date(Date.now() - 6 * DAY_MS),
      })),
    });
    // Only the template is offered: the Editor of the others let an offer expire, and is passed over (S24-3).
    const started = performance.now();
    const made = await post(owner.cookie, { mode: 'longest', documentIds: [template] });
    const took = performance.now() - started;
    expect(made.status).toBe(201);
    expect(await json(made)).toEqual({ offered: 1, kept: 0, cannot: COUNT });
    expect(took).toBeLessThan(4500);
    // The offers were written expired, and the Owner was told of each, as `settle` does for one document.
    expect(await db().ownershipOffer.count({ where: { fromUserId: owner.id, state: 'PENDING' } })).toBe(1);
    expect(await db().ownershipOffer.count({ where: { fromUserId: owner.id, state: 'EXPIRED' } })).toBe(
      COUNT,
    );
    expect(
      await db().notification.count({ where: { recipientId: owner.id, kind: 'ownership_offer_ended' } }),
    ).toBe(COUNT);
  }, 120_000);

  // Item 3, mutation I3: no state of its own for a document whose every Editor was passed over.
  it('says there is no other Editor where each has declined, and the same after a withdrawal', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    const edRow = await editorOf(documentId, ed);
    expect((await makeOffer(documentId, owner.id, edRow.id)).outcome).toBe('offered');
    await answerOffer(ed.id, (await offersOf(documentId))[0]!.id, 'decline');
    expect((await transferScreen(owner.id)).documents[0]?.state).toEqual({ kind: 'no_other_editor' });
    // Offered once more on its own, withdrawn: it is not "Not offered yet" for a rule that passes the Editor over.
    expect((await makeOffer(documentId, owner.id, edRow.id)).outcome).toBe('offered');
    await withdrawOffer(documentId, owner.id);
    const screen = await transferScreen(owner.id);
    expect(screen.documents[0]?.state).toEqual({ kind: 'no_other_editor' });
    expect(screen.longest.documentIds).toEqual([]);
    // "To one person" still offers it to them.
    expect(screen.people).toMatchObject([{ offered: 1 }]);
  });

  // Item 4, mutation I4: a document that already has an offer is counted under the chosen person.
  it('counts only the new offers of a choice, and states the documents that already have an offer apart', async () => {
    const owner = await person();
    const alice = await person('alice');
    const bob = await person('bob');
    const kept: string[] = [];
    for (let n = 0; n < 3; n++) {
      const id = await documentOf(owner.id);
      const aliceRow = await editorOf(id, alice, 5);
      await makeOffer(id, owner.id, aliceRow.id);
      kept.push(id);
    }
    const bobs = await documentOf(owner.id);
    const bobRow = await editorOf(bobs, bob, 5);
    const screen = await transferScreen(owner.id);
    // Alice has nothing new to be offered; Bob has one.
    expect(screen.people).toHaveLength(1);
    expect(screen.people[0]).toMatchObject({ offered: 1, kept: 3, cannot: 0 });
    expect(screen.longest).toMatchObject({ offered: 1, kept: 3, cannot: 0 });
    const response = await post(owner.cookie, {
      mode: 'person',
      collaboratorId: bobRow.id,
      documentIds: screen.people[0]!.documentIds,
    });
    expect(await json(response)).toEqual({ offered: 1, kept: 3, cannot: 0 });
    // The offers that were kept are not claimed by the batch: they are handed over as single offers, by their own path.
    const singles = await db().ownershipOffer.findMany({ where: { documentId: { in: kept } } });
    expect(singles.map(({ batchId }) => batchId)).toEqual([null, null, null]);
    // Everything now has an offer: nothing new, and the person is no longer one to pick.
    const after = await transferScreen(owner.id);
    expect(after.longest).toMatchObject({ offered: 0, kept: 4, cannot: 0 });
    expect(after.people).toEqual([]);
  });

  // Item 8, mutation I8: the screen and the plan read every role, not the Editors.
  it('offers to an Editor only: a long-standing Viewer beside a newer Editor is not the longest-standing Editor', async () => {
    const owner = await person();
    const viewer = await person('viewer');
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await db().documentCollaborator.create({
      data: {
        documentId,
        userId: viewer.id,
        role: 'VIEWER',
        roleSince: new Date(T0 - 300 * DAY_MS),
        addedAt: new Date(T0 - 300 * DAY_MS),
      },
    });
    await editorOf(documentId, editor, 2);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    expect((await offersOf(documentId)).map(({ toUserId }) => toUserId)).toEqual([editor.id]);
  });

  it('offers a chosen person only the documents they are an Editor of, not those they only view', async () => {
    const owner = await person();
    const ada = await person('ada');
    const edits = await documentOf(owner.id);
    const views = await documentOf(owner.id);
    const row = await editorOf(edits, ada);
    await db().documentCollaborator.create({ data: { documentId: views, userId: ada.id, role: 'VIEWER' } });
    const screen = await transferScreen(owner.id);
    expect(screen.documents.find(({ id }) => id === views)?.state).toEqual({ kind: 'no_editor' });
    expect(screen.people).toMatchObject([{ offered: 1, cannot: 1 }]);
    const response = await post(owner.cookie, {
      mode: 'person',
      collaboratorId: row.id,
      documentIds: screen.people[0]!.documentIds,
    });
    expect(response.status).toBe(201);
    expect(await offersOf(edits)).toHaveLength(1);
    expect(await offersOf(views)).toHaveLength(0);
  });
});
