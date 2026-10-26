// The day of a clearing (FR-AU-91, FR-ED-36, FR-ED-40 (c), FR-ED-42, FR-ED-47, NFR-RE-15, NFR-SE-19; docs/plan/slice-23.md):
// the deletion of the documents a clearing confirmed, by the timer, under the document's own claim, in the order of
// the permanent deletion of FR-ED-36; the notices of it; and what it leaves alone (a document cancelled, passed to
// another Owner, or deleted by retention meanwhile). Against a provisioned database, with the in-memory store of
// images and an Istorico port that reports the erasure capability where a test needs it.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, json, MAIL, TITLE, world } from './clearing.ts';
import { MemoryStorage } from './image-storage.ts';
import { load, PASSWORD, prepare, sunk } from './identity.ts';

const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const database = prepare('clearingday', { EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { carryOutClearings } = await import('../../src/lib/clearing/deletion.ts');
const { countScope } = await import('../../src/lib/clearing/clearing.ts');
const { CLAIM_STALE_MS, deleteExpiredDocuments } = await import('../../src/lib/documents/deletion.ts');
const { answerOffer, makeOffer } = await import('../../src/lib/documents/ownership.ts');
const { listNotifications } = await import('../../src/lib/documents/sharing.ts');
const { deleteExpiredRemovedNotifications } = await import('../../src/lib/documents/access-notifications.ts');
const { confirmDeletion, ownedDocuments } = await import('../../src/lib/account/deletion.ts');
const { authorise } = await import('../../src/lib/documents/access.ts');
const { istorico } = await import('../../src/lib/istorico/index.ts');
const { TIMERS } = await import('../../src/lib/timers.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, share, image, clear, cancelOne, row, exists, logged } = w;

let storage: MemoryStorage;
afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(async () => {
  // A run of the timer carries out every open clearing, as the timer does: one that an earlier test left open is not
  // this test’s to complete.
  await db().documentClearing.updateMany({
    where: { completedAt: null },
    data: { completedAt: new Date(Date.now() + 365 * DAY_MS) },
  });
  later.length = 0;
  storage = new MemoryStorage();
  useImageStorage(storage);
});
afterEach(() => {
  vi.restoreAllMocks();
  later.length = 0;
});

async function afterResponses() {
  for (const task of later.splice(0)) await task();
}
const everything = async (userId: string) => ({
  scope: 'all' as const,
  documentIds: (await countScope(userId, 'all')).documentIds,
  password: PASSWORD,
});
/** A clearing of one shared document of a new Owner, confirmed; and the day it will be deleted. */
async function sharedClearing(options: { readers?: number } = {}) {
  const owner = await person();
  const readers = [];
  for (let at = 0; at < (options.readers ?? 2); at++) readers.push(await person('reader'));
  const documentId = await documentOf(owner.id, 'The shared one');
  for (const reader of readers)
    await share(documentId, reader.id, at(readers, reader) === 0 ? 'EDITOR' : 'VIEWER');
  const key = await image(documentId, storage, owner.id);
  const response = await clear(owner.cookie, await everything(owner.id));
  expect(response.status).toBe(200);
  await afterResponses();
  const day = new Date((await json(response)).deleteOn as string);
  return { owner, readers, documentId, key, day };
}
const at = (readers: { id: string }[], reader: { id: string }) => readers.indexOf(reader);
/** The port, reporting the erasure capability, which the no-op adapter never does. */
function erasing() {
  const port = istorico();
  vi.spyOn(port, 'capabilities').mockReturnValue({ ...port.capabilities(), erasure: true });
  return vi.spyOn(port, 'erase');
}

describe('on its day, a shared document is deleted permanently, in the order of FR-ED-36', () => {
  // Mutation D01: the timer deletes a shared document before its day (the condition on the day is dropped).
  it('deletes it on its day and not a moment before, with its images, its collaborators and its entry', async () => {
    const { documentId, key, day, readers } = await sharedClearing();
    expect(await carryOutClearings(new Date(day.getTime() - 1))).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(documentId)).toBe(true);
    expect(storage.objects.has(key)).toBe(true);

    expect(await carryOutClearings(day)).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(documentId)).toBe(false);
    expect(storage.objects.has(key)).toBe(false);
    expect(await db().documentImage.count({ where: { documentId } })).toBe(0);
    expect(await db().documentCollaborator.count({ where: { documentId } })).toBe(0);
    for (const reader of readers) {
      expect((await authorise(reader.id, documentId, 'document.view')).outcome).toBe('not_found');
    }
    // NFR-SE-19: the entry of a permanent deletion, once, with the document and no user.
    expect(
      (await logged()).filter(
        ({ kind, documentId: each }) => kind === 'document_deleted_permanently' && each === documentId,
      ),
    ).toEqual([{ kind: 'document_deleted_permanently', userId: null, documentId }]);
  });

  // Mutation D02: the notice is written for the Owner, or not for the collaborators, or without the title.
  it('tells each person who held a role by one notification that names the title, and sends no email', async () => {
    const { owner, readers, documentId, day } = await sharedClearing();
    const mails = (await sunk(MAIL)).length;
    await carryOutClearings(day);
    expect((await sunk(MAIL)).length).toBe(mails);
    for (const reader of readers) {
      const { notifications } = await listNotifications(reader.id, day);
      expect(notifications.filter(({ kind }) => kind === 'clearing_notice')).toEqual([]);
      const told = notifications.filter(({ kind }) => kind === 'clearing_deleted');
      expect(told).toHaveLength(1);
      expect(told[0]).toMatchObject({ kind: 'clearing_deleted', title: 'The shared one', read: false });
    }
    expect((await listNotifications(owner.id, day)).notifications).toEqual([]);
    // It has no subject: the payload holds the title and nothing that leads to the document.
    const rows = await db().notification.findMany({ where: { kind: 'clearing_deleted' } });
    for (const each of rows) expect(each.payload).toEqual({ title: 'The shared one' });
    expect(
      await db().notification.count({ where: { payload: { path: ['documentId'], equals: documentId } } }),
    ).toBe(0);
  });

  // Mutation D03: the title is written to the security log or to a line of the timer.
  it('writes no title, name or address to the security log or to a line of the process', async () => {
    const lines: string[] = [];
    for (const method of ['error', 'log', 'warn'] as const) {
      vi.spyOn(console, method).mockImplementation((...parts) => void lines.push(parts.join(' ')));
    }
    const { documentId, day, owner, readers } = await sharedClearing();
    await carryOutClearings(day);
    const written = JSON.stringify(await db().securityLogEntry.findMany()) + lines.join('\n');
    expect(written).not.toContain('The shared one');
    for (const who of [owner, ...readers]) expect(written).not.toContain(who.email);
    expect(written).toContain(documentId);
  });

  // Mutation D04: the notice of a deletion stays for ever, or goes with the first run.
  it('keeps the notice of the deletion for 30 days, and a timer deletes it then', async () => {
    const { readers, day } = await sharedClearing({ readers: 1 });
    await carryOutClearings(day);
    const reader = readers[0]!;
    const kinds = async (now: Date) =>
      (await listNotifications(reader.id, now)).notifications.map(({ kind }) => kind);
    expect(await kinds(new Date(day.getTime() + 29 * DAY_MS))).toEqual(['clearing_deleted']);
    expect(await kinds(new Date(day.getTime() + 31 * DAY_MS))).toEqual([]);
    expect(
      await db().notification.count({ where: { kind: 'clearing_deleted', recipientId: reader.id } }),
    ).toBe(1);
    expect(
      await deleteExpiredRemovedNotifications(new Date(day.getTime() + 31 * DAY_MS)),
    ).toBeGreaterThanOrEqual(1);
    expect(
      await db().notification.count({ where: { kind: 'clearing_deleted', recipientId: reader.id } }),
    ).toBe(0);
  });

  // Mutation D05: the invitations and the offer are left behind, or the Owner is left a notice of an offer that ended.
  it('ends the pending offer of ownership and every invitation with it, and leaves no notification that names the document', async () => {
    const { owner, readers, documentId, day } = await sharedClearing();
    const editor = readers[0]!;
    const collaborator = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: editor.id },
    });
    const offered = await makeOffer(documentId, owner.id, collaborator.id);
    expect(offered.outcome).toBe('offered');
    expect(await db().ownershipOffer.count({ where: { documentId, state: 'PENDING' } })).toBe(1);
    expect(await db().notification.count({ where: { kind: 'ownership_offer' } })).toBeGreaterThan(0);
    await carryOutClearings(day);
    expect(await db().ownershipOffer.count({ where: { documentId } })).toBe(0);
    expect(
      await db().notification.count({ where: { kind: 'ownership_offer', recipientId: editor.id } }),
    ).toBe(0);
    expect(
      await db().notification.count({ where: { kind: 'ownership_offer_ended', recipientId: owner.id } }),
    ).toBe(0);
    expect(await db().documentInvitation.count({ where: { documentId } })).toBe(0);
  });

  // Mutation D06: the claim is not taken, or is not exclusive: of two runs at once both delete.
  it('deletes once whatever number of runs reach it together, and writes one entry', async () => {
    const { documentId, day, readers } = await sharedClearing();
    const told = () =>
      db().notification.count({
        where: { kind: 'clearing_deleted', recipientId: { in: readers.map(({ id }) => id) } },
      });
    const runs = await Promise.all([carryOutClearings(day), carryOutClearings(day), carryOutClearings(day)]);
    expect(runs.reduce((sum, { deleted }) => sum + deleted, 0)).toBe(1);
    expect(
      (await logged()).filter(
        ({ kind, documentId: each }) => kind === 'document_deleted_permanently' && each === documentId,
      ),
    ).toHaveLength(1);
    expect(await told()).toBe(2);
    // Idempotent: a later run finds nothing and writes nothing.
    expect(await carryOutClearings(new Date(day.getTime() + DAY_MS))).toEqual({ deleted: 0, kept: 0 });
    expect(await told()).toBe(2);
  });

  // Mutation D06b: the claim is not exclusive: of three runs that reach the document together, each asks Istorico.
  it('asks Istorico once whatever number of runs reach the document together', async () => {
    const { documentId, day } = await sharedClearing();
    await db().document.update({ where: { id: documentId }, data: { recording: 'RECORDED' } });
    const erase = erasing();
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    erase.mockImplementation(async () => {
      await opened;
      return { ok: true, value: [{ documentId, outcome: 'erased' }] } as never;
    });
    const runs = Promise.all([carryOutClearings(day), carryOutClearings(day), carryOutClearings(day)]);
    // Long enough for every run to have reached its claim, and the one that holds it to be waiting for Istorico.
    await new Promise((resolve) => setTimeout(resolve, 500));
    open();
    expect((await runs).reduce((sum, { deleted }) => sum + deleted, 0)).toBe(1);
    expect(erase).toHaveBeenCalledTimes(1);
    expect(await exists(documentId)).toBe(false);
  });

  // Mutation D07: the run takes over a claim that is not stale, or never takes over one that is.
  it('leaves a document another run holds, and takes over a claim that is an hour old', async () => {
    const { documentId, day } = await sharedClearing();
    await db().document.update({
      where: { id: documentId },
      data: { deletionClaimedAt: new Date(day.getTime() - 60_000) },
    });
    expect(await carryOutClearings(day)).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(documentId)).toBe(true);
    await db().document.update({
      where: { id: documentId },
      data: { deletionClaimedAt: new Date(day.getTime() - CLAIM_STALE_MS - 1000) },
    });
    expect(await carryOutClearings(day)).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(documentId)).toBe(false);
  });

  it('completes the clearing when every document is gone, and leaves the account free to be deleted', async () => {
    const { owner, day } = await sharedClearing();
    expect(
      (await db().documentClearing.findFirstOrThrow({ where: { userId: owner.id } })).completedAt,
    ).toBeNull();
    expect((await ownedDocuments(owner.id)).owned).toBe(1);
    expect((await confirmDeletion(owner.id, async () => 'held')).outcome).toBe('owns_documents');
    await carryOutClearings(day);
    expect(
      (await db().documentClearing.findFirstOrThrow({ where: { userId: owner.id } })).completedAt,
    ).not.toBeNull();
    expect((await ownedDocuments(owner.id)).owned).toBe(0);
    expect((await confirmDeletion(owner.id, async () => 'held')).outcome).toBe('confirmed');
  });
});

describe('what the day leaves alone', () => {
  // Mutation D08: the retention deletes a document that is in a clearing.
  it('is not the retention’s: a document deleted before, whose retention ends inside its period, waits for its day', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    // Deleted 29 days ago: its retention ends in a day, inside the 7 days of notice.
    await w.deletedAgo(documentId, owner.id, 29 * DAY_MS);
    const response = await clear(owner.cookie, await everything(owner.id));
    const day = new Date((await json(response)).deleteOn as string);
    const midway = new Date(Date.now() + 3 * DAY_MS);
    expect(await deleteExpiredDocuments(midway)).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(documentId)).toBe(true);
    expect(await carryOutClearings(midway)).toEqual({ deleted: 0, kept: 0 });
    expect(await carryOutClearings(day)).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(documentId)).toBe(false);
  });

  // Mutation D09: a document passed to another Owner is deleted by the old clearing.
  it('does not delete a document whose ownership passed during the period, and tells its people it will not be deleted', async () => {
    const { owner, readers, documentId, day } = await sharedClearing();
    const editor = readers[0]!;
    const viewer = readers[1]!;
    const collaborator = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: editor.id },
    });
    const offered = await makeOffer(documentId, owner.id, collaborator.id);
    if (offered.outcome !== 'offered') throw new Error('not offered');
    const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId, state: 'PENDING' } });
    expect(await answerOffer(editor.id, offer.id, 'accept')).toEqual({ outcome: 'accepted', documentId });

    const after = await row(documentId);
    expect(after?.ownerId).toBe(editor.id);
    expect(after?.clearingAt).toBeNull();
    // "its collaborators are told that it will not be deleted": the former Owner is one now, and so is the Viewer.
    for (const person of [owner, viewer]) {
      const kinds = (await listNotifications(person.id)).notifications.map((each) =>
        each.kind === 'clearing_cancelled' || each.kind === 'clearing_notice' ? each.kind : 'other',
      );
      expect(kinds.filter((kind) => kind !== 'other')).toEqual(['clearing_cancelled']);
    }
    expect(
      (await listNotifications(editor.id)).notifications.some(({ kind }) => kind === 'clearing_notice'),
    ).toBe(false);
    // The old clearing does not delete it, however long after, and does not delete it if it comes back to the old Owner.
    expect(await carryOutClearings(new Date(day.getTime() + DAY_MS))).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(documentId)).toBe(true);
    const clearing = await db().documentClearing.findFirstOrThrow({ where: { userId: owner.id } });
    expect(clearing.cancelledDocumentIds).toEqual([documentId]);
    expect(clearing.completedAt).not.toBeNull();
    await db().document.update({ where: { id: documentId }, data: { ownerId: owner.id } });
    expect(await carryOutClearings(new Date(day.getTime() + 2 * DAY_MS))).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(documentId)).toBe(true);
  });

  // Mutation O01: an acceptance after the day takes the document out of the clearing, which is then never deleted.
  // Mutation O02: an offer is made after the day.
  it('takes nothing out of a clearing whose day has come: an offer is neither accepted nor made, and the timer deletes the document', async () => {
    const { owner, readers, documentId, day } = await sharedClearing();
    const editor = readers[0]!;
    const collaborator = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: editor.id },
    });
    expect((await makeOffer(documentId, owner.id, collaborator.id)).outcome).toBe('offered');
    const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId, state: 'PENDING' } });
    const after = new Date(day.getTime() + 1);
    // Accepted a moment after the day, before any run of the timer: refused, and the offer stays pending.
    expect(await answerOffer(editor.id, offer.id, 'accept', after)).toEqual({ outcome: 'clearing_over' });
    const kept = await row(documentId);
    expect(kept?.ownerId).toBe(owner.id);
    expect(kept?.clearingAt?.getTime()).toBe(day.getTime());
    expect((await db().ownershipOffer.findUniqueOrThrow({ where: { id: offer.id } })).state).toBe('PENDING');
    // Declining stays open, and no new offer is made after the day.
    expect((await makeOffer(documentId, owner.id, collaborator.id, after)).outcome).toBe('clearing_over');
    await db().ownershipOffer.update({ where: { id: offer.id }, data: { state: 'WITHDRAWN' } });
    expect((await makeOffer(documentId, owner.id, collaborator.id, after)).outcome).toBe('clearing_over');
    expect(await carryOutClearings(after)).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(documentId)).toBe(false);
  });

  it('answers the acceptance of an offer after the day with the 409 of a cancellation that comes too late', async () => {
    const { owner, readers, documentId } = await sharedClearing();
    const editor = readers[0]!;
    const collaborator = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: editor.id },
    });
    expect((await makeOffer(documentId, owner.id, collaborator.id)).outcome).toBe('offered');
    const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId, state: 'PENDING' } });
    await db().document.update({
      where: { id: documentId },
      data: { clearingAt: new Date(Date.now() - 1000) },
    });
    const answering = await import('../../src/app/api/ownership-offers/[offerId]/[answer]/route.ts');
    const response = await answering.POST(
      w.request('POST', `/api/ownership-offers/${offer.id}/accept`, await editor.signedIn()),
      { params: Promise.resolve({ offerId: offer.id, answer: 'accept' }) },
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('too_late');
    expect((await row(documentId))?.ownerId).toBe(owner.id);
  });

  // Mutation D10: the claim does not check the day of the clearing, so a document of another clearing is deleted.
  it('deletes only the documents of the clearing, under the day that clearing gave them', async () => {
    const owner = await person();
    const reader = await person('reader');
    const first = await documentOf(owner.id);
    const second = await documentOf(owner.id);
    await share(first, reader.id);
    await share(second, reader.id);
    const one = await clear(owner.cookie, {
      scope: 'all',
      documentIds: (await countScope(owner.id, 'all')).documentIds,
      password: PASSWORD,
    });
    const day = new Date((await json(one)).deleteOn as string);
    // The second leaves the first clearing and enters another, whose day is later.
    expect((await cancelOne(owner.cookie, second)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const two = await clear(owner.cookie, { scope: 'all', documentIds: [second], password: PASSWORD });
    const later2 = new Date((await json(two)).deleteOn as string);
    expect(later2.getTime()).toBeGreaterThan(day.getTime());
    await carryOutClearings(day);
    expect(await exists(first)).toBe(false);
    expect(await exists(second)).toBe(true);
    await carryOutClearings(later2);
    expect(await exists(second)).toBe(false);
  });

  it('tells no one whose account is being deleted, and sends it nothing', async () => {
    const owner = await person();
    const leaving = await person('leaving');
    const staying = await person('staying');
    const documentId = await documentOf(owner.id);
    await share(documentId, leaving.id);
    await share(documentId, staying.id);
    expect((await confirmDeletion(leaving.id, async () => 'held')).outcome).toBe('confirmed');
    const mails = await sunk(MAIL);
    const response = await clear(owner.cookie, await everything(owner.id));
    await afterResponses();
    expect(
      await db().notification.count({ where: { recipientId: leaving.id, kind: 'clearing_notice' } }),
    ).toBe(0);
    expect(
      await db().notification.count({ where: { recipientId: staying.id, kind: 'clearing_notice' } }),
    ).toBe(1);
    const sent = (await sunk(MAIL)).slice(mails.length);
    expect(sent.map(({ to }) => to)).toEqual([staying.email]);
    // The document is still shared, for there is a row for the one who leaves: it waits for its day.
    expect((await json(response)).shared).toBe(1);
  });
});

describe('when a step cannot be done, the document is kept and the next run does it (NFR-RE-15)', () => {
  // Mutation K01: a document is deleted although Istorico did not erase it.
  it('keeps a recorded document that Istorico did not erase, with its access ended and its images, and deletes it when it has', async () => {
    const { documentId, key, day, readers } = await sharedClearing();
    await db().document.update({ where: { id: documentId }, data: { recording: 'RECORDED' } });
    const erase = erasing();
    erase.mockResolvedValueOnce({ ok: true, value: [{ documentId, outcome: 'held' }] } as never);
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...parts) => void errors.push(parts.join(' ')));

    expect(await carryOutClearings(day)).toEqual({ deleted: 0, kept: 1 });
    expect(await exists(documentId)).toBe(true);
    expect(storage.objects.has(key)).toBe(true);
    // Access ended at the claim, and stays ended; the document cannot be restored (it is in a clearing).
    expect((await row(documentId))?.deletedAt).not.toBeNull();
    // At the day the run was made for (the period is over from then on, S23-1; the test's clock is not the real one).
    expect((await authorise(readers[0]!.id, documentId, 'document.view', day)).outcome).toBe('not_found');
    expect((await row(documentId))?.deletionClaimedAt).toBeNull();
    // NFR-SE-19: the line names the clearing and the document and no title.
    expect(errors.join('\n')).toContain(documentId);
    expect(errors.join('\n')).not.toContain(TITLE);

    erase.mockResolvedValueOnce({ ok: true, value: [{ documentId, outcome: 'erased' }] } as never);
    expect(await carryOutClearings(new Date(day.getTime() + 60_000))).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(documentId)).toBe(false);
    // IC-29: asked for the owner, under the document's identifier.
    expect(erase).toHaveBeenLastCalledWith(
      expect.objectContaining({ documents: [{ documentId, role: 'owner', workspaceKind: 'personal' }] }),
    );
  });

  // Also held by the foreign key from the images to the row, so no weakening of the code alone makes it fail.
  it('keeps the document when an image cannot be removed, and deletes it on the next run', async () => {
    const { documentId, key, day } = await sharedClearing();
    storage.failing.set(key, new Error('the store is down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await carryOutClearings(day)).toEqual({ deleted: 0, kept: 1 });
    expect(await exists(documentId)).toBe(true);
    storage.failing.clear();
    // The claim was left for the next run to find stale, or to take at once where it is released.
    await db().document.update({ where: { id: documentId }, data: { deletionClaimedAt: null } });
    expect(await carryOutClearings(new Date(day.getTime() + 60_000))).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(documentId)).toBe(false);
  });

  // Mutation K03: a document that cannot be deleted holds the others of the run back.
  it('goes on with the other documents when one fails', async () => {
    const owner = await person();
    const reader = await person('reader');
    const bad = await documentOf(owner.id);
    const good = await documentOf(owner.id);
    await share(bad, reader.id);
    await share(good, reader.id);
    const badKey = await image(bad, storage, owner.id);
    const response = await clear(owner.cookie, await everything(owner.id));
    const day = new Date((await json(response)).deleteOn as string);
    storage.failing.set(badKey, new Error('the store is down'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await carryOutClearings(day)).toEqual({ deleted: 1, kept: 1 });
    expect(await exists(good)).toBe(false);
    expect(await exists(bad)).toBe(true);
  });
});

describe('the notices of a clearing and the deletion of their document by the retention (FR-ED-42)', () => {
  // Mutation N01: the permanent deletion of a document does not take the notices of a clearing with it.
  it('leaves no notice of a clearing behind a document that is deleted permanently, whatever its notice was', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    await clear(owner.cookie, { scope: 'all', documentIds: [documentId], password: PASSWORD });
    expect((await cancelOne(owner.cookie, documentId)).status).toBe(200);
    // A notice of the period too, as one that the cancellation did not replace would be.
    await db().notification.create({
      data: { recipientId: reader.id, kind: 'clearing_notice', payload: { documentId, clearingId: 'x' } },
    });
    expect(
      await db().notification.count({ where: { payload: { path: ['documentId'], equals: documentId } } }),
    ).toBe(2);
    await w.deletedAgo(documentId, owner.id, 31 * DAY_MS);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    expect(
      await db().notification.count({ where: { payload: { path: ['documentId'], equals: documentId } } }),
    ).toBe(0);
  });
});

describe('an upload that crosses the deletion of its document (NFR-SE-18, FR-AU-91)', () => {
  // Mutation I01: the upload does not look for its row after the put.
  it('removes the object it put after the document’s images were deleted, and says the document is not there', async () => {
    const owner = await person();
    const documentId = await documentOf(owner.id);
    const { png } = await import('../unit/image-fixtures.ts');
    const { deleteImagesOfDocument } = await import('../../src/lib/images/deletion.ts');
    // The deletion of the document's images runs between the reservation and the put.
    const crossing = new (class extends MemoryStorage {
      override async put(key: string, bytes: Uint8Array, contentType: string) {
        await deleteImagesOfDocument(this, documentId);
        await super.put(key, bytes, contentType);
      }
    })();
    useImageStorage(crossing);
    const uploads = await import('../../src/app/api/documents/[id]/images/route.ts');
    const response = await uploads.POST(
      new Request(`https://app.example.test/api/documents/${documentId}/images`, {
        method: 'POST',
        headers: { origin: 'https://app.example.test', cookie: owner.cookie, 'content-type': 'image/png' },
        body: new Uint8Array(png()),
      }),
      { params: Promise.resolve({ id: documentId }) },
    );
    expect(response.status).toBe(404);
    expect(crossing.objects.size).toBe(0);
    expect(await db().documentImage.count({ where: { documentId } })).toBe(0);
  });
});

describe('the timers (NFR-RE-15)', () => {
  it('lists the timer of the clearing and the backstop of its email', () => {
    expect(Object.keys(TIMERS)).toEqual(expect.arrayContaining(['clearing-deletion', 'clearing-email']));
  });

  it('run twice at once without a fault, and the first deletes what is due', async () => {
    const { documentId, day } = await sharedClearing();
    vi.useFakeTimers({ toFake: ['Date'], now: day });
    try {
      const counts = await Promise.all([TIMERS['clearing-deletion']!(), TIMERS['clearing-deletion']!()]);
      expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
      expect(await TIMERS['clearing-email']!()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    expect(await exists(documentId)).toBe(false);
  });
});
