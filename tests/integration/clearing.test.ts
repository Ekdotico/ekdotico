// Clearing the documents of an account (FR-AU-91; FR-ED-36, FR-ED-37, FR-ED-42, FR-ED-44 (d), FR-AU-58;
// NFR-RE-15, NFR-SE-19; register D72, D100, D117, A103; docs/plan/slice-23.md): the confirmation, its prompt, the
// scope, the split between what is deleted at once and what waits, the notices, the period, and the
// cancellation, against a provisioned database, with the routes as Next.js calls them. The day itself, the
// races and the open connections are in clearing-day.test.ts, clearing-races.test.ts and collab-clearing.test.ts.
// Each test of a rule names the weakening that makes it fail (the mutations of the pull request, section 9).
import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codeOf, DAY_MS, json, MAIL, NOTICE_DAYS, TITLE, world } from './clearing.ts';
import { MemoryStorage } from './image-storage.ts';
import { load, PASSWORD, post, prepare, sunk } from './identity.ts';
import { enrol, nextCode } from './second-factor.ts';

// `after` of Next.js exists only inside a request of the framework: what a route leaves for after its
// response is collected here and run by the test when it wants it, so that "after" can be told from "before".
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const MOST = 4;
const database = prepare('clearing', {
  EMAIL_SINK_DIRECTORY: MAIL,
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: `${MOST}/3600`,
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: '500/900',
});
const loaded = await load();
const { auth, db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { carryOutClearings } = await import('../../src/lib/clearing/deletion.ts');
const { countScope, confirmClearing } = await import('../../src/lib/clearing/clearing.ts');
const { authorise } = await import('../../src/lib/documents/access.ts');
const { listNotifications } = await import('../../src/lib/documents/sharing.ts');
const { ownedDocuments } = await import('../../src/lib/account/deletion.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, share, invite, deletedAgo, clear, cancelAll, cancelOne, row, exists, logged } = w;

const WRONG = 'a wrong password, long enough';
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

/** Runs what the routes left for after their responses. */
async function afterResponses() {
  for (const task of later.splice(0)) await task();
}
const idsOf = async (userId: string, scope: 'all' | 'deleted' = 'all') =>
  (await countScope(userId, scope)).documentIds;
/** The request of a confirmation for exactly what the account owns now. */
async function everything(userId: string, scope: 'all' | 'deleted' = 'all') {
  return { scope, documentIds: await idsOf(userId, scope), password: PASSWORD };
}

describe('the confirmation names the documents, and the rows decide', () => {
  // Mutation C01: the comparison of the identifiers with the locked rows is taken out.
  it('refuses identifiers that are not exactly the documents of the scope, and deletes nothing', async () => {
    const owner = await person();
    const other = await person();
    const mine = await documentOf(owner.id);
    const mine2 = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    const ids = await idsOf(owner.id);
    expect(ids.sort()).toEqual([mine, mine2].sort());

    for (const documentIds of [
      [mine], // fewer than it owns
      [mine, mine2, theirs], // a document of another account
      [mine, mine2, randomUUID()], // one that does not exist
      [mine, mine, mine2], // twice
      [],
    ]) {
      const refused = await clear(owner.cookie, { scope: 'all', documentIds, password: PASSWORD });
      expect(refused.status, JSON.stringify(documentIds)).toBe(409);
      expect(['documents_changed', 'nothing_to_clear']).toContain(await codeOf(refused));
    }
    await afterResponses();
    expect(await exists(mine)).toBe(true);
    expect(await exists(mine2)).toBe(true);
    expect(await exists(theirs)).toBe(true);
    expect(await db().documentClearing.count({ where: { userId: owner.id } })).toBe(0);
    expect((await row(mine))?.clearingAt).toBeNull();
  });

  // Mutation C02: the Owner is not part of the lock's query (any document is locked and listed).
  it('never clears a document of another account, whoever names it', async () => {
    const owner = await person();
    const other = await person();
    const theirs = await documentOf(other.id);
    const refused = await clear(owner.cookie, { scope: 'all', documentIds: [theirs], password: PASSWORD });
    expect(refused.status).toBe(409);
    expect(await exists(theirs)).toBe(true);
    expect((await row(theirs))?.clearingAt).toBeNull();
    // The other account's own request, for what it owns, works, and the first account's documents are not in it.
    const mine = await documentOf(owner.id);
    const ok = await clear(other.cookie, await everything(other.id));
    expect(ok.status).toBe(200);
    await afterResponses();
    expect(await exists(theirs)).toBe(false);
    expect(await exists(mine)).toBe(true);
  });

  it('refuses a scope with no document, and a body that is not exactly the named fields', async () => {
    const owner = await person();
    expect(
      await codeOf(await clear(owner.cookie, { scope: 'all', documentIds: [], password: PASSWORD })),
    ).toBe('nothing_to_clear');
    const mine = await documentOf(owner.id);
    for (const body of [
      {},
      [],
      { scope: 'all', documentIds: [mine] },
      { scope: 'all', documentIds: [mine], password: PASSWORD, extra: 1 },
      { scope: 'everything', documentIds: [mine], password: PASSWORD },
      { scope: 'all', documentIds: 'x', password: PASSWORD },
      { scope: 'all', documentIds: ['not an identifier'], password: PASSWORD },
      { scope: 'all', documentIds: [mine.toUpperCase()], password: PASSWORD },
      { scope: 'all', documentIds: [mine], password: 7 },
    ]) {
      const refused = await clear(owner.cookie, body);
      expect(refused.status, JSON.stringify(body)).toBe(422);
    }
    expect(await exists(mine)).toBe(true);
  });

  it('refuses more identifiers than a request may hold', async () => {
    const owner = await person();
    const names = Array.from({ length: 6001 }, () => randomUUID());
    const refused = await clear(owner.cookie, { scope: 'all', documentIds: names, password: PASSWORD });
    expect(refused.status).toBe(422);
    expect((await json(refused)).error?.message).toContain('at most 6,000 documents');
    // A body past the bound, however it is made, is told in the same words (review of pull request 60).
    const long = await clear(owner.cookie, { scope: 'all', documentIds: [], password: 'x'.repeat(300_000) });
    expect(long.status).toBe(422);
    expect((await json(long)).error?.message).toContain('at most 6,000 documents');
  });

  it('answers a request without a session 401 and one from another origin 403, and clears nothing', async () => {
    const owner = await person();
    const mine = await documentOf(owner.id);
    const body = { scope: 'all', documentIds: [mine], password: PASSWORD };
    const anonymous = await clearRoute.POST(
      new Request('https://app.example.test/api/account/documents/clear', {
        method: 'POST',
        headers: { origin: 'https://app.example.test', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
    expect(anonymous.status).toBe(401);
    const foreign = await clearRoute.POST(
      new Request('https://app.example.test/api/account/documents/clear', {
        method: 'POST',
        headers: {
          origin: 'https://elsewhere.example',
          'content-type': 'application/json',
          cookie: owner.cookie,
        },
        body: JSON.stringify(body),
      }),
    );
    expect(foreign.status).toBe(403);
    expect(await exists(mine)).toBe(true);
    expect(await db().documentClearing.count({ where: { userId: owner.id } })).toBe(0);
  });

  // NFR-SE-17 (c), R50: each of the three handlers that change state checks the origin itself (the integration
  // test of the origin of every handler names this one for them: tests/integration/route-origin.test.ts).
  // Mutation C18: the origin is not checked by the cancellation.
  it('refuses a cancellation from another origin before it reads the session, and cancels nothing', async () => {
    const owner = await person();
    const reader = await person('reader');
    const mine = await documentOf(owner.id);
    await share(mine, reader.id);
    await clear(owner.cookie, await everything(owner.id));
    const day = (await row(mine))!.clearingAt;
    const elsewhere = { origin: 'https://elsewhere.example', cookie: owner.cookie };
    const refusals = [
      await clearRoute.DELETE(
        new Request('https://app.example.test/api/account/documents/clear', {
          method: 'DELETE',
          headers: elsewhere,
        }),
      ),
      await oneRoute.DELETE(
        new Request(`https://app.example.test/api/account/documents/clear/${mine}`, {
          method: 'DELETE',
          headers: elsewhere,
        }),
        { params: Promise.resolve({ documentId: mine }) },
      ),
    ];
    for (const refusal of refusals) expect(refusal.status).toBe(403);
    expect((await row(mine))?.clearingAt).toEqual(day);
  });

  it('answers a body that is not JSON 415', async () => {
    const owner = await person();
    const refused = await clearRoute.POST(
      new Request('https://app.example.test/api/account/documents/clear', {
        method: 'POST',
        headers: { origin: 'https://app.example.test', 'content-type': 'text/plain', cookie: owner.cookie },
        body: 'scope=all',
      }),
    );
    expect(refused.status).toBe(415);
  });
});

describe('the prompt: the password, and the code where two-factor authentication is on (FR-AU-58)', () => {
  // Mutation C03: the password is not checked before the confirmation.
  it('refuses a wrong password with a 403, logs it, and clears nothing', async () => {
    const owner = await person();
    const mine = await documentOf(owner.id);
    const refused = await clear(owner.cookie, { scope: 'all', documentIds: [mine], password: WRONG });
    expect(refused.status).toBe(403);
    expect(await codeOf(refused)).toBe('password_refused');
    expect(await exists(mine)).toBe(true);
    expect((await row(mine))?.clearingAt).toBeNull();
    expect(await logged()).toContainEqual({ kind: 'forbidden', userId: owner.id, documentId: null });
    expect(await db().documentClearing.count({ where: { userId: owner.id } })).toBe(0);
  });

  // The count is the function `checkCredentials`'s, shared with the deletion of the account (slice 22): no weakening
  // of it is made here (docs/plan/slice-23.md, section 8).
  it('counts a wrong password as a failed sign-in, and refuses the right one once the limit is reached', async () => {
    const owner = await person();
    const mine = await documentOf(owner.id);
    for (let wrong = 0; wrong < MOST; wrong++) {
      const refused = await clear(owner.cookie, { scope: 'all', documentIds: [mine], password: WRONG });
      expect(refused.status).toBe(403);
    }
    // The limit of failed sign-ins for the address is reached: even the right password is refused, as at a sign-in.
    const right = await clear(owner.cookie, { scope: 'all', documentIds: [mine], password: PASSWORD });
    expect(right.status).toBe(403);
    expect(await exists(mine)).toBe(true);
  });

  // Mutation C05: the code is not asked for, or not checked, where two-factor authentication is on.
  it('asks for a code where two-factor authentication is on, and refuses a wrong one', async () => {
    const who = await person();
    const enrolled = await enrol(auth, who.cookie, {});
    const mine = await documentOf(who.id);
    const without = await clear(who.cookie, { scope: 'all', documentIds: [mine], password: PASSWORD });
    expect(without.status).toBe(422);
    const wrong = await clear(who.cookie, {
      scope: 'all',
      documentIds: [mine],
      password: PASSWORD,
      code: '000000',
    });
    expect(wrong.status).toBe(403);
    expect(await codeOf(wrong)).toBe('code_refused');
    expect(await exists(mine)).toBe(true);
    const right = await clear(who.cookie, {
      scope: 'all',
      documentIds: [mine],
      password: PASSWORD,
      code: nextCode(enrolled.secret),
    });
    expect(right.status).toBe(200);
    await afterResponses();
    expect(await exists(mine)).toBe(false);
  });
});

describe('a recovery code at the prompt (FR-AU-83: "accepted in its place and is then spent")', () => {
  // Mutation F01: the confirmation does not spend the recovery code that opened it.
  it('is spent by the clearing it opens, so that it opens no second, and is not spent by one that is refused', async () => {
    const who = await person();
    const enrolled = await enrol(auth, who.cookie, {});
    const [code] = enrolled.recoveryCodes;
    await documentOf(who.id);
    // A confirmation that the rows refuse (the identifiers are stale) costs the person no code.
    const stale = await clear(who.cookie, {
      scope: 'all',
      documentIds: [randomUUID()],
      password: PASSWORD,
      code,
    });
    expect(stale.status).toBe(409);
    const first = await clear(who.cookie, { ...(await everything(who.id)), code });
    expect(first.status).toBe(200);
    await afterResponses();
    // The same code, for another clearing, is refused as a wrong one is, and clears nothing.
    const later2 = await documentOf(who.id);
    const second = await clear(who.cookie, { ...(await everything(who.id)), code });
    expect(second.status).toBe(403);
    expect(await codeOf(second)).toBe('code_refused');
    expect(await exists(later2)).toBe(true);
    expect((await row(later2))?.clearingAt).toBeNull();
    // Another code of the ten still opens it.
    const other = await clear(who.cookie, { ...(await everything(who.id)), code: enrolled.recoveryCodes[1] });
    expect(other.status).toBe(200);
  });

  // Mutation F02: a code that another request spent first does not undo the confirmation that waited for it.
  it('undoes the confirmation of a request whose code another request spent first', async () => {
    const who = await person();
    const enrolled = await enrol(auth, who.cookie, {});
    const mine = await documentOf(who.id);
    const factor = await db().twoFactor.findFirstOrThrow({ where: { userId: who.id } });
    const { confirmClearing } = await import('../../src/lib/clearing/clearing.ts');
    void enrolled;
    const result = await confirmClearing(
      who.id,
      { scope: 'all', documentIds: [mine], spend: async () => false },
      async () => 'held',
    );
    expect(result.outcome).toBe('code_gone');
    expect((await row(mine))?.clearingAt).toBeNull();
    expect(await db().documentClearing.count({ where: { userId: who.id } })).toBe(0);
    expect(factor.id).toBeTruthy();
  });
});

describe('what is deleted at once and what waits (FR-AU-91)', () => {
  // Mutation C06: every document is treated as shared (or none is).
  it('deletes at once a document that is not shared, with its images, and keeps a shared one until its day', async () => {
    const owner = await person();
    const reader = await person('reader');
    const alone = await documentOf(owner.id);
    const shared = await documentOf(owner.id);
    await share(shared, reader.id);
    const aloneKey = await w.image(alone, storage, owner.id);
    const sharedKey = await w.image(shared, storage, owner.id);

    const before = Date.now();
    const response = await clear(owner.cookie, await everything(owner.id));
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({ documents: 2, shared: 1 });
    // "7 days after the confirmation (an initial value, and a setting)".
    const day = new Date(body.deleteOn as string).getTime();
    expect(day).toBeGreaterThanOrEqual(before + NOTICE_DAYS * DAY_MS);
    expect(day).toBeLessThanOrEqual(Date.now() + NOTICE_DAYS * DAY_MS);

    // Not before the response has gone: the confirmation records, the deletion follows it.
    expect(await exists(alone)).toBe(true);
    await afterResponses();
    expect(await exists(alone)).toBe(false);
    expect(storage.objects.has(aloneKey)).toBe(false);
    expect(await db().documentImage.count({ where: { documentId: alone } })).toBe(0);
    // The shared one stays, whole, read-only, with its day.
    expect(await exists(shared)).toBe(true);
    expect(storage.objects.has(sharedKey)).toBe(true);
    expect((await row(shared))?.clearingAt?.toISOString()).toBe(body.deleteOn);
    expect((await row(shared))?.deletedAt).toBeNull();
    // The entry of the permanent deletion, once, for the one deleted; none for the one that waits.
    const entries = (await logged()).filter(({ kind }) => kind === 'document_deleted_permanently');
    expect(entries.filter(({ documentId }) => documentId === alone)).toHaveLength(1);
    expect(entries.filter(({ documentId }) => documentId === shared)).toHaveLength(0);
  });

  // Mutation C07: a pending invitation makes the document shared.
  it('does not take a pending invitation for a sharer, and revokes it with its notification', async () => {
    const owner = await person();
    const invitee = await person('invitee');
    const mine = await documentOf(owner.id);
    const pending = await invite(mine, owner.id, invitee.email);
    await db().notification.create({
      data: { recipientId: invitee.id, kind: 'document_invitation', payload: { invitationId: pending.id } },
    });
    const response = await clear(owner.cookie, await everything(owner.id));
    expect(await json(response)).toMatchObject({ documents: 1, shared: 0, deleteOn: null });
    await afterResponses();
    expect(await exists(mine)).toBe(false);
    expect((await db().documentInvitation.findMany({ where: { id: pending.id } })).length).toBe(0);
    expect(await db().notification.count({ where: { recipientId: invitee.id } })).toBe(0);
  });

  // Mutation C08: the pending invitations of a shared document are not revoked.
  it('revokes the pending invitations of a shared document at the confirmation', async () => {
    const owner = await person();
    const reader = await person('reader');
    const invitee = await person('invitee');
    const mine = await documentOf(owner.id);
    await share(mine, reader.id);
    const pending = await invite(mine, owner.id, invitee.email);
    await db().notification.create({
      data: { recipientId: invitee.id, kind: 'document_invitation', payload: { invitationId: pending.id } },
    });
    await clear(owner.cookie, await everything(owner.id));
    const after = await db().documentInvitation.findUniqueOrThrow({ where: { id: pending.id } });
    expect(after.state).toBe('REVOKED');
    expect(
      await db().notification.count({ where: { recipientId: invitee.id, kind: 'document_invitation' } }),
    ).toBe(0);
  });

  // Mutation C09: a document deleted before the clearing is cleared at once whether or not it was shared.
  it('treats a document deleted before the clearing as shared where it had a collaborator, so that deleting first is no way round the notice', async () => {
    const owner = await person();
    const reader = await person('reader');
    const unshared = await documentOf(owner.id);
    const shared = await documentOf(owner.id);
    await share(shared, reader.id);
    await deletedAgo(unshared, owner.id, 2 * DAY_MS);
    await deletedAgo(shared, owner.id, 2 * DAY_MS);

    const response = await clear(owner.cookie, await everything(owner.id));
    expect(await json(response)).toMatchObject({ documents: 2, shared: 1 });
    await afterResponses();
    expect(await exists(unshared)).toBe(false);
    expect(await exists(shared)).toBe(true);
    const kept = await row(shared);
    expect(kept?.clearingAt).not.toBeNull();
    // Still in the list of deleted documents, with a collaborator told and a day.
    expect(kept?.deletedAt).not.toBeNull();
    expect(
      await db().notification.count({ where: { recipientId: reader.id, kind: 'clearing_notice' } }),
    ).toBe(1);
  });

  // Mutation C10: the deleted-only scope lists every document.
  it('clears the already-deleted documents alone, where that is the scope', async () => {
    const owner = await person();
    const live = await documentOf(owner.id);
    const gone = await documentOf(owner.id);
    await deletedAgo(gone, owner.id, DAY_MS);
    expect(await idsOf(owner.id, 'deleted')).toEqual([gone]);
    const refused = await clear(owner.cookie, {
      scope: 'deleted',
      documentIds: [live, gone],
      password: PASSWORD,
    });
    expect(refused.status).toBe(409);
    expect(await exists(live)).toBe(true);
    const ok = await clear(owner.cookie, await everything(owner.id, 'deleted'));
    expect(ok.status).toBe(200);
    await afterResponses();
    expect(await exists(gone)).toBe(false);
    expect(await exists(live)).toBe(true);
    expect((await row(live))?.clearingAt).toBeNull();
  });

  // Mutation C19: the scope of deleted documents does not leave out a document that waits for its day already.
  it('does not take a deleted document that is waiting for its day into the scope of the deleted documents', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    await deletedAgo(documentId, owner.id, DAY_MS);
    const first = await clear(owner.cookie, await everything(owner.id));
    const day = (await json(first)).deleteOn as string;
    expect(await idsOf(owner.id, 'deleted')).toEqual([]);
    const again = await clear(owner.cookie, {
      scope: 'deleted',
      documentIds: [documentId],
      password: PASSWORD,
    });
    expect(again.status).toBe(409);
    expect((await row(documentId))?.clearingAt?.toISOString()).toBe(day);
    expect(await db().documentClearing.count({ where: { userId: owner.id } })).toBe(1);
  });

  // Mutation C20: the pending invitations are revoked only for the documents that are shared.
  it('revokes the pending invitations of a document that is not shared at the confirmation itself, before its deletion', async () => {
    const owner = await person();
    const invitee = await person('invitee');
    const mine = await documentOf(owner.id);
    const pending = await invite(mine, owner.id, invitee.email);
    const confirmed = await confirmClearing(
      owner.id,
      { scope: 'all', documentIds: [mine] },
      async () => 'held',
    );
    expect(confirmed.outcome).toBe('confirmed');
    // The deletion has not run: the document is there, and the invitation is not open.
    expect(await exists(mine)).toBe(true);
    expect((await db().documentInvitation.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe(
      'REVOKED',
    );
  });

  // Mutation C21: the acceptance of an invitation does not read the column under the lock.
  it('does not accept an invitation to a document in a clearing, though one is still pending', async () => {
    const owner = await person();
    const invitee = await person('invitee');
    const mine = await documentOf(owner.id);
    const pending = await invite(mine, owner.id, invitee.email);
    await db().document.update({ where: { id: mine }, data: { clearingAt: new Date(Date.now() + DAY_MS) } });
    const { answerInvitation } = await import('../../src/lib/documents/sharing.ts');
    expect(await answerInvitation(invitee.id, { id: pending.id }, 'accept')).toEqual({
      outcome: 'no_longer_open',
    });
    expect(await db().documentCollaborator.count({ where: { documentId: mine } })).toBe(0);
  });

  // Mutation C11: a further clearing includes the documents already in a period (and starts their day again).
  it('does not start the period again for a document in one, and covers only the other documents', async () => {
    const owner = await person();
    const reader = await person('reader');
    const first = await documentOf(owner.id);
    await share(first, reader.id);
    const one = await clear(owner.cookie, await everything(owner.id));
    const day = (await json(one)).deleteOn as string;
    const second = await documentOf(owner.id);
    await share(second, reader.id);
    expect(await idsOf(owner.id)).toEqual([second]);
    const two = await clear(owner.cookie, await everything(owner.id));
    expect(two.status).toBe(200);
    expect((await row(first))?.clearingAt?.toISOString()).toBe(day);
    expect((await row(second))?.clearingAt?.toISOString()).not.toBe(day);
    // The first is in the first clearing alone.
    const clearings = await db().documentClearing.findMany({
      where: { userId: owner.id },
      orderBy: { requestedAt: 'asc' },
    });
    expect(clearings.map(({ documentIds }) => documentIds)).toEqual([[first], [second]]);
  });

  // Mutation C12: the clearing deletes the documents the account owns when the timer runs.
  it('never deletes a document the account comes to own after the confirmation', async () => {
    const owner = await person();
    const reader = await person('reader');
    const shared = await documentOf(owner.id);
    await share(shared, reader.id);
    await clear(owner.cookie, await everything(owner.id));
    const later1 = await documentOf(owner.id);
    await carryOutClearings(new Date(Date.now() + 8 * DAY_MS));
    expect(await exists(shared)).toBe(false);
    expect(await exists(later1)).toBe(true);
    expect((await row(later1))?.clearingAt).toBeNull();
  });

  // Mutation G01: the lists of a clearing may be null (the migration does not make them NOT NULL).
  it('has lists that are never null: the database refuses a clearing with one', async () => {
    const owner = await person();
    for (const column of ['documentIds', 'sharedDocumentIds', 'cancelledDocumentIds']) {
      const lists: Record<string, string> = {
        documentIds: 'ARRAY[gen_random_uuid()]',
        sharedDocumentIds: 'ARRAY[]::uuid[]',
        cancelledDocumentIds: 'ARRAY[]::uuid[]',
        [column]: 'NULL',
      };
      await expect(
        db().$executeRawUnsafe(
          `INSERT INTO "ekdotico"."DocumentClearing" ("id", "userId", "scope", "documentIds", "sharedDocumentIds", "cancelledDocumentIds", "requestedAt")
           VALUES ('null-list-${column}', '${owner.id}', 'ALL', ${lists.documentIds}, ${lists.sharedDocumentIds}, ${lists.cancelledDocumentIds}, now())`,
        ),
        column,
      ).rejects.toThrow();
    }
  });

  // A regression test of the shape of the record; the lists it holds are held together by the migration's checks.
  it('records the clearing with the identifiers it counted, and nothing else', async () => {
    const owner = await person();
    const a = await documentOf(owner.id);
    const b = await documentOf(owner.id);
    await clear(owner.cookie, await everything(owner.id));
    const [clearing] = await db().documentClearing.findMany({ where: { userId: owner.id } });
    expect(clearing?.documentIds.sort()).toEqual([a, b].sort());
    expect(clearing?.sharedDocumentIds).toEqual([]);
    expect(clearing?.scope).toBe('ALL');
    // No personal field: an identifier of the account, identifiers of documents, times.
    expect(Object.keys(clearing!).sort()).toEqual(
      [
        'cancelledDocumentIds',
        'completedAt',
        'deleteSharedAt',
        'documentIds',
        'emailsClaimedAt',
        'id',
        'requestedAt',
        'scope',
        'sharedDocumentIds',
        'userId',
      ].sort(),
    );
  });
});

describe('the notices (FR-ED-42, FR-AU-91)', () => {
  // Mutation C14: a notification is written for the Owner, or one for a document and not for each person.
  it('writes one notification for each person who holds a role on each shared document, and none for the Owner', async () => {
    const owner = await person();
    const editor = await person('editor');
    const viewer = await person('viewer');
    const a = await documentOf(owner.id, 'First document');
    const b = await documentOf(owner.id, 'Second document');
    await share(a, editor.id, 'EDITOR');
    await share(a, viewer.id, 'VIEWER');
    await share(b, viewer.id, 'VIEWER');
    await clear(owner.cookie, await everything(owner.id));
    const day = (await row(a))!.clearingAt!;

    const seen = async (userId: string) =>
      (await listNotifications(userId)).notifications.flatMap((each) =>
        each.kind === 'clearing_notice' ? [{ title: each.title, deleteOn: each.deleteOn.toISOString() }] : [],
      );
    expect((await seen(editor.id)).map(({ title }) => title)).toEqual(['First document']);
    expect((await seen(viewer.id)).map(({ title }) => title).sort()).toEqual([
      'First document',
      'Second document',
    ]);
    expect((await seen(viewer.id)).every(({ deleteOn }) => deleteOn === day.toISOString())).toBe(true);
    expect(await seen(owner.id)).toEqual([]);
    expect(await db().notification.count({ where: { recipientId: owner.id } })).toBe(0);
  });

  // Mutation C15: the email names the documents, or goes to the Owner, or goes once for each document.
  it('hands over one email to each person, naming no document, once whatever runs', async () => {
    const owner = await person();
    const viewer = await person('viewer');
    const lonely = await person('lonely');
    const a = await documentOf(owner.id);
    const b = await documentOf(owner.id);
    await share(a, viewer.id);
    await share(b, viewer.id);
    await share(b, lonely.id);
    const { deliverClearingEmails, deliverUnsentClearingEmails } =
      await import('../../src/lib/clearing/email.ts');
    const response = await clear(owner.cookie, await everything(owner.id));
    const { deleteOn } = await json(response);
    // Not before the response has gone.
    const mailBefore = (await sunk(MAIL)).length;
    await afterResponses();
    const clearingId = (await db().documentClearing.findFirstOrThrow({ where: { userId: owner.id } })).id;
    // Two more attempts, one beside the other: the claim keeps it to one.
    await Promise.all([deliverClearingEmails(clearingId), deliverUnsentClearingEmails()]);
    const mails = (await sunk(MAIL)).slice(mailBefore);
    const addressed = (address: string) => mails.filter((mail) => mail.to === address);
    expect(addressed(viewer.email)).toHaveLength(1);
    expect(addressed(lonely.email)).toHaveLength(1);
    expect(addressed(owner.email)).toHaveLength(0);
    for (const mail of mails) {
      expect(mail.text).not.toContain(TITLE);
      expect(mail.text).not.toContain(a);
      expect(mail.text).not.toContain(b);
    }
    const toViewer = mails.find((mail) => mail.to === viewer.email)!;
    const toLonely = mails.find((mail) => mail.to === lonely.email)!;
    expect(toViewer.subject).toBe('Documents you have access to in Ekdotico will be deleted');
    expect(toViewer.text).toContain(
      'The Owner of 2 documents that you have access to in Ekdotico will delete them on ',
    );
    expect(toLonely.text).toContain(
      'The Owner of 1 document that you have access to in Ekdotico will delete it on ',
    );
    expect(toViewer.text).toContain(
      'Until then you can open each one and take a draft export of it. Your notifications in Ekdotico name them: https://app.example.test/notifications.',
    );
    // The day: the one form of a date, in UTC.
    const when = new Date(deleteOn as string);
    expect(toViewer.text).toMatch(
      new RegExp(`${when.getUTCDate()} \\w{3} ${when.getUTCFullYear()}, \\d\\d:\\d\\d UTC`),
    );
  });

  // Mutation C16: the list shows the notice of a document to a person who no longer holds a role on it.
  it('stops showing the notice to a person who is removed during the period, and keeps the day for the others', async () => {
    const owner = await person();
    const kept = await person('kept');
    const removed = await person('removed');
    const documentId = await documentOf(owner.id, 'Still waiting');
    await share(documentId, kept.id);
    const row2 = await share(documentId, removed.id);
    await clear(owner.cookie, await everything(owner.id));
    const day = (await row(documentId))!.clearingAt!;
    const noticesOf = async (userId: string) =>
      (await listNotifications(userId)).notifications.filter(({ kind }) => kind === 'clearing_notice');
    expect(await noticesOf(removed.id)).toHaveLength(1);
    await db().documentCollaborator.delete({ where: { id: row2.id } });
    expect(await noticesOf(removed.id)).toEqual([]);
    expect(await noticesOf(kept.id)).toHaveLength(1);
    // "Removing a collaborator during the period does not bring the deletion forward: the day stays the day".
    expect((await row(documentId))?.clearingAt?.getTime()).toBe(day.getTime());
  });

  it('hands over no email for a clearing with no shared document, and none to an account in deletion', async () => {
    const owner = await person();
    const mine = await documentOf(owner.id);
    const mailBefore = (await sunk(MAIL)).length;
    await clear(owner.cookie, { scope: 'all', documentIds: [mine], password: PASSWORD });
    await afterResponses();
    expect((await sunk(MAIL)).length).toBe(mailBefore);
  });
});

describe('the period: read-only for everyone, and what it leaves open (FR-AU-91, FR-ED-36, FR-ED-44 (d))', () => {
  async function inPeriod() {
    const owner = await person();
    const editor = await person('editor');
    const viewer = await person('viewer');
    const documentId = await documentOf(owner.id, 'In its period');
    await share(documentId, editor.id, 'EDITOR');
    await share(documentId, viewer.id, 'VIEWER');
    await clear(owner.cookie, await everything(owner.id));
    return { owner, editor, viewer, documentId };
  }
  const routes = async () => ({
    one: await import('../../src/app/api/documents/[id]/route.ts'),
    restoring: await import('../../src/app/api/documents/[id]/restore/route.ts'),
    invitations: await import('../../src/app/api/documents/[id]/invitations/route.ts'),
    collaborators: await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts'),
    leave: await import('../../src/app/api/documents/[id]/leave/route.ts'),
    permissions: await import('../../src/app/api/documents/[id]/permissions/route.ts'),
    offer: await import('../../src/app/api/documents/[id]/ownership-offer/route.ts'),
    images: await import('../../src/app/api/documents/[id]/images/route.ts'),
  });
  const context = (id: string, extra: Record<string, string> = {}) => ({
    params: Promise.resolve({ id, ...extra }),
  });

  // Mutation P01: documentRoute no longer refuses a handler that changes state for a document in a clearing.
  it('refuses with a 409 every request that would change the content, the title or the images, or open the document to anyone', async () => {
    const { owner, editor, documentId } = await inPeriod();
    const r = await routes();
    const refused = [
      await r.one.PATCH(
        w.request('PATCH', `/api/documents/${documentId}`, owner.cookie, { title: 'Another' }),
        context(documentId),
      ),
      await r.one.DELETE(
        w.request('DELETE', `/api/documents/${documentId}`, owner.cookie),
        context(documentId),
      ),
      await r.invitations.POST(
        w.request('POST', `/api/documents/${documentId}/invitations`, owner.cookie, {
          emails: ['someone@example.com'],
          role: 'viewer',
        }),
        context(documentId),
      ),
      await r.images.POST(
        new Request(`https://app.example.test/api/documents/${documentId}/images`, {
          method: 'POST',
          headers: { origin: 'https://app.example.test', cookie: owner.cookie, 'content-type': 'image/png' },
          body: new Uint8Array([137, 80, 78, 71]),
        }),
        context(documentId),
      ),
      // An Editor is refused too: the document is read-only for everyone, and the Editor may edit it otherwise.
      await r.images.POST(
        new Request(`https://app.example.test/api/documents/${documentId}/images`, {
          method: 'POST',
          headers: { origin: 'https://app.example.test', cookie: editor.cookie, 'content-type': 'image/png' },
          body: new Uint8Array([137, 80, 78, 71]),
        }),
        context(documentId),
      ),
    ];
    for (const response of refused) {
      expect(response.status).toBe(409);
      expect(await codeOf(response)).toBe('clearing');
    }
    const after = await row(documentId);
    expect(after?.title).toBe('In its period');
    expect(after?.deletedAt).toBeNull();
    expect(await db().documentInvitation.count({ where: { documentId } })).toBe(0);
    expect(await db().documentImage.count({ where: { documentId } })).toBe(0);
  });

  // Mutation P02: a caller who may not act is told the document is in a clearing (409) before being told no (403).
  it('tells a caller who may not act that they may not (403) before it says the document is in a clearing', async () => {
    const { viewer, documentId } = await inPeriod();
    const r = await routes();
    const refused = await r.one.PATCH(
      w.request('PATCH', `/api/documents/${documentId}`, viewer.cookie, { title: 'x' }),
      context(documentId),
    );
    expect(refused.status).toBe(403);
  });

  // Mutation P03: documentRoute refuses a handler it should leave open (removal, role, leave, set, offer).
  it('leaves open what does not change the document and does not move the day', async () => {
    const { owner, editor, viewer, documentId } = await inPeriod();
    const r = await routes();
    const day = (await row(documentId))!.clearingAt!.toISOString();
    const viewerRow = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: viewer.id },
    });
    const editorRow = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: editor.id },
    });
    // A role raised to Editor.
    const raised = await r.collaborators.PATCH(
      w.request('PATCH', `/api/documents/${documentId}/collaborators/${viewerRow.id}`, owner.cookie, {
        role: 'editor',
      }),
      context(documentId, { collaboratorId: viewerRow.id }),
    );
    expect(raised.status).toBe(200);
    // The permission set changed.
    const changed = await r.permissions.PUT(
      w.request('PUT', `/api/documents/${documentId}/permissions`, owner.cookie, {
        changes: { 'document.export.draft': { viewer: true } },
      }),
      context(documentId),
    );
    expect(changed.status).toBe(200);
    // An offer of ownership "may still be made".
    const offered = await r.offer.POST(
      w.request('POST', `/api/documents/${documentId}/ownership-offer`, owner.cookie, {
        collaboratorId: editorRow.id,
      }),
      context(documentId),
    );
    expect(offered.status).toBe(201);
    const withdrawn = await r.offer.DELETE(
      w.request('DELETE', `/api/documents/${documentId}/ownership-offer`, owner.cookie),
      context(documentId),
    );
    expect(withdrawn.status).toBe(200);
    // A collaborator removed, and one that leaves: "does not bring the deletion forward".
    const removed = await r.collaborators.DELETE(
      w.request('DELETE', `/api/documents/${documentId}/collaborators/${viewerRow.id}`, owner.cookie),
      context(documentId, { collaboratorId: viewerRow.id }),
    );
    expect(removed.status).toBe(200);
    const left = await r.leave.POST(
      w.request('POST', `/api/documents/${documentId}/leave`, editor.cookie),
      context(documentId),
    );
    expect(left.status).toBe(204);
    expect((await row(documentId))?.clearingAt?.toISOString()).toBe(day);
    expect(
      (
        await db().documentClearing.findFirstOrThrow({ where: { userId: owner.id } })
      ).deleteSharedAt?.toISOString(),
    ).toBe(day);
  });

  // Mutation P04: `authorise` stops holding the draft export for every role in the period, or holds it after.
  it('holds the draft export for every collaborator, whatever the permission set says, in the period alone (FR-ED-44 (d))', async () => {
    const { owner, editor, viewer, documentId } = await inPeriod();
    // The default set gives a Viewer no draft export; nor does it give a stranger anything.
    const before = await authorise(
      viewer.id,
      documentId,
      'document.export.draft',
      new Date(Date.now() - 60_000),
    );
    expect(before.outcome).toBe('allowed');
    for (const user of [owner, editor, viewer]) {
      expect((await authorise(user.id, documentId, 'document.export.draft')).outcome).toBe('allowed');
    }
    const stranger = await person('stranger');
    expect((await authorise(stranger.id, documentId, 'document.export.draft')).outcome).toBe('not_found');
    // Only that permission: nothing else is given.
    expect((await authorise(viewer.id, documentId, 'document.rename')).outcome).toBe('forbidden');
    expect((await authorise(viewer.id, documentId, 'document.content.edit')).outcome).toBe('forbidden');
    // After the day, or without a clearing, the set decides again.
    const day = (await row(documentId))!.clearingAt!;
    expect(
      (await authorise(viewer.id, documentId, 'document.export.draft', new Date(day.getTime() + 1))).outcome,
    ).toBe('forbidden');
    const plain = await documentOf(owner.id);
    await share(plain, viewer.id, 'VIEWER');
    expect((await authorise(viewer.id, plain, 'document.export.draft')).outcome).toBe('forbidden');
  });

  // Mutation P07: `documentRoute` closes a route for the draft export, a POST, during a clearing. The route of
  // the export is slice 21's and is not on this branch: a route made as it will be is tried here.
  it('answers a route for the draft export, made by documentRoute, to every collaborator in the period, a Viewer included', async () => {
    const { owner, editor, viewer, documentId } = await inPeriod();
    const { documentRoute } = await import('../../src/lib/documents/route.ts');
    const exporting = documentRoute('document.export.draft', () => new Response('a file'));
    for (const who of [owner, editor, viewer]) {
      const response = await exporting(
        w.request('POST', `/api/documents/${documentId}/export/draft`, who.cookie),
        context(documentId),
      );
      expect(response.status, who.email).toBe(200);
    }
    const stranger = await person('stranger');
    const refused = await exporting(
      w.request('POST', `/api/documents/${documentId}/export/draft`, stranger.cookie),
      context(documentId),
    );
    expect(refused.status).toBe(404);
  });

  // Mutation P08: the export loads a document that is deleted only while it is not deleted (`deletedAt: null`).
  // Mutation P09: the export loads a deleted document that is in a clearing whatever its day.
  it('exports a document deleted before the clearing to its collaborators through the route while the period runs, and not after the day', async () => {
    const owner = await person();
    const viewer = await person('viewer');
    const documentId = await documentOf(owner.id, 'Exported in the period');
    await share(documentId, viewer.id, 'VIEWER');
    await deletedAgo(documentId, owner.id, DAY_MS);
    await clear(owner.cookie, await everything(owner.id));
    const exporting = await import('../../src/app/api/documents/[id]/export/draft/route.ts');
    const ask = (cookie: string) =>
      exporting.POST(
        w.request('POST', `/api/documents/${documentId}/export/draft`, cookie),
        context(documentId),
      );
    // A Viewer, whose set gives it no export: the period does, for a document that is deleted.
    for (const who of [viewer, owner]) {
      const response = await ask(who.cookie);
      expect(response.status, who.email).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/zip');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.subarray(0, 2).toString()).toBe('PK');
      expect(bytes.includes(Buffer.from('Exported in the period'))).toBe(true);
    }
    // After the day: `authorise` finds none, and the handler, called with the row it was authorised on, finds none either.
    const authorised = (await row(documentId))!;
    await db().document.update({
      where: { id: documentId },
      data: { clearingAt: new Date(Date.now() - 1000) },
    });
    expect((await ask(viewer.cookie)).status).toBe(404);
    const { draftExport } = await import('../../src/lib/export/draft.ts');
    const late = await draftExport({
      request: w.request('POST', `/api/documents/${documentId}/export/draft`, viewer.cookie),
      session: { userId: viewer.id } as never,
      document: authorised,
      role: 'viewer',
      params: { id: documentId },
    });
    expect(late.status).toBe(404);
  });

  // Mutation P05: the exception for the export reaches a deleted document that is not in a clearing. Reading it
  // (S23-1, answered "view" on 26 October 2026) is tests/integration/clearing-view.test.ts's.
  it('gives a document deleted before the clearing its draft export for its collaborators and the Owner', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    await deletedAgo(documentId, owner.id, DAY_MS);
    // Deleted, not in a clearing: nothing.
    expect((await authorise(reader.id, documentId, 'document.export.draft')).outcome).toBe('not_found');
    await clear(owner.cookie, await everything(owner.id));
    expect((await authorise(reader.id, documentId, 'document.export.draft')).outcome).toBe('allowed');
    expect((await authorise(owner.id, documentId, 'document.export.draft')).outcome).toBe('allowed');
  });

  // Mutation P06: the restore is not refused for a document in a clearing.
  it('refuses to restore a document deleted before the clearing and treated as shared, until the clearing is cancelled for it', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    await deletedAgo(documentId, owner.id, DAY_MS);
    await clear(owner.cookie, await everything(owner.id));
    const r = await routes();
    const refused = await r.restoring.POST(
      w.request('POST', `/api/documents/${documentId}/restore`, owner.cookie),
      context(documentId),
    );
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe('clearing');
    expect((await row(documentId))?.deletedAt).not.toBeNull();
    // "the Owner who wants the document back cancels the clearing for it first".
    expect((await cancelOne(owner.cookie, documentId)).status).toBe(200);
    const restored = await r.restoring.POST(
      w.request('POST', `/api/documents/${documentId}/restore`, owner.cookie),
      context(documentId),
    );
    expect(restored.status).toBe(200);
    expect((await row(documentId))?.deletedAt).toBeNull();
  });

  it('lists the document with no rename and no deletion for its Owner, and the day', async () => {
    const { owner, documentId } = await inPeriod();
    const { listDocuments } = await import('../../src/lib/documents/documents.ts');
    const listed = (await listDocuments(owner.id)).find(({ id }) => id === documentId)!;
    expect(listed.canRename).toBe(false);
    expect(listed.canDelete).toBe(false);
    expect(listed.clearingAt).not.toBeNull();
  });
});

describe('cancelling (FR-AU-91, FR-ED-42)', () => {
  async function waiting() {
    const owner = await person();
    const reader = await person('reader');
    const a = await documentOf(owner.id, 'Kept one');
    const b = await documentOf(owner.id, 'Kept two');
    await share(a, reader.id);
    await share(b, reader.id);
    await clear(owner.cookie, await everything(owner.id));
    return { owner, reader, a, b };
  }

  // Mutation X01: the cancellation leaves the column set.
  it('takes one document out: editable again, its notice replaced, and it is not deleted on the day', async () => {
    const { owner, reader, a, b } = await waiting();
    const cancelled = await cancelOne(owner.cookie, a);
    expect(cancelled.status).toBe(200);
    expect((await row(a))?.clearingAt).toBeNull();
    expect((await row(b))?.clearingAt).not.toBeNull();
    const kinds = (await listNotifications(reader.id)).notifications.map((each) =>
      each.kind === 'clearing_notice' || each.kind === 'clearing_cancelled'
        ? `${each.kind}:${each.title}`
        : each.kind,
    );
    expect(kinds.sort()).toEqual(['clearing_cancelled:Kept one', 'clearing_notice:Kept two']);
    // On the day: only the other is deleted.
    await carryOutClearings(new Date(Date.now() + 8 * DAY_MS));
    expect(await exists(a)).toBe(true);
    expect(await exists(b)).toBe(false);
    // "the account then owns it as before": the clearing records it as taken out.
    const clearing = await db().documentClearing.findFirstOrThrow({ where: { userId: owner.id } });
    expect(clearing.cancelledDocumentIds).toEqual([a]);
    expect(clearing.completedAt).not.toBeNull();
  });

  it('takes every document out at once, for all of them', async () => {
    const { owner, a, b } = await waiting();
    const cancelled = await cancelAll(owner.cookie);
    expect(cancelled.status).toBe(200);
    expect(await json(cancelled)).toEqual({ cancelled: 2 });
    expect((await row(a))?.clearingAt).toBeNull();
    expect((await row(b))?.clearingAt).toBeNull();
    // Nothing is left to cancel.
    const none = await cancelAll(owner.cookie);
    expect(none.status).toBe(409);
    expect(await codeOf(none)).toBe('nothing_waiting');
    expect((await cancelOne(owner.cookie, a)).status).toBe(404);
  });

  // Mutation X02: the route asks for the password (S23-5), or for no session row.
  it('asks for no password, and for a session', async () => {
    const { owner, a } = await waiting();
    const anonymous = await oneRoute.DELETE(
      new Request(`https://app.example.test/api/account/documents/clear/${a}`, {
        method: 'DELETE',
        headers: { origin: 'https://app.example.test' },
      }),
      { params: Promise.resolve({ documentId: a }) },
    );
    expect(anonymous.status).toBe(401);
    expect((await cancelOne(owner.cookie, a)).status).toBe(200);
  });

  // Mutation X03: the Owner condition is dropped from the lock of the cancellation.
  it('cancels nothing of another account, and says of its document what it says of one that is not waiting', async () => {
    const { a } = await waiting();
    const stranger = await person('stranger');
    const refused = await cancelOne(stranger.cookie, a);
    expect(refused.status).toBe(404);
    expect(await cancelAll(stranger.cookie)).toHaveProperty('status', 409);
    expect((await row(a))?.clearingAt).not.toBeNull();
    expect((await cancelOne(stranger.cookie, 'not-an-identifier')).status).toBe(404);
  });

  // Mutation X04: the day is not checked, or a claimed document is cancelled.
  it('refuses to cancel once the day has come or a timer holds the document', async () => {
    const { owner, a, b } = await waiting();
    await db().document.update({ where: { id: a }, data: { clearingAt: new Date(Date.now() - 1000) } });
    const late = await cancelOne(owner.cookie, a);
    expect(late.status).toBe(409);
    expect(await codeOf(late)).toBe('too_late');
    await db().document.update({ where: { id: b }, data: { deletionClaimedAt: new Date() } });
    expect((await cancelOne(owner.cookie, b)).status).toBe(409);
    expect((await row(a))?.clearingAt).not.toBeNull();
    // For all of them, too: what is left is past its day, which is "too late" and not "nothing is waiting".
    const all = await cancelAll(owner.cookie);
    expect(all.status).toBe(409);
    expect(await codeOf(all)).toBe('too_late');
  });
});

describe('the deletion screen and the account (FR-AU-58)', () => {
  // Mutation A01: a document in a notice period is not counted as owned.
  it('keeps the account from being deleted while a document waits for its day', async () => {
    const owner = await person();
    const reader = await person('reader');
    const mine = await documentOf(owner.id);
    await share(mine, reader.id);
    await clear(owner.cookie, await everything(owner.id));
    expect((await ownedDocuments(owner.id)).owned).toBe(1);
    const route = await import('../../src/app/api/account/route.ts');
    const refused = await route.DELETE(
      w.request('DELETE', '/api/account', owner.cookie, { password: PASSWORD }),
    );
    expect(refused.status).toBe(409);
    expect(await codeOf(refused)).toBe('owns_documents');
    await carryOutClearings(new Date(Date.now() + 8 * DAY_MS));
    expect((await ownedDocuments(owner.id)).owned).toBe(0);
  });

  it('refuses a clearing to an account whose deletion is confirmed', async () => {
    const owner = await person();
    const { confirmDeletion } = await import('../../src/lib/account/deletion.ts');
    expect((await confirmDeletion(owner.id, async () => 'held')).outcome).toBe('confirmed');
    const refused = await confirmClearing(owner.id, { scope: 'all', documentIds: [] }, async () => 'held');
    expect(refused.outcome).toBe('not_found');
    // And `post` of the identity library is not involved: a sign-in is refused for it already.
    expect(post).toBeTypeOf('function');
  });
});
