// The races of the transfer of all documents (FR-AU-92, FR-ED-47, FR-AU-58, FR-AU-91, FR-ED-36, FR-ED-38; NFR-SE-04;
// docs/plan/slice-24.md, section 3): the action against a single offer, itself, the confirmation of the recipient's
// deletion, a clearing, the removal of an Editor, a change of role, a deletion and a restore of a document; and the
// lock order, which must not deadlock with the deletion of an account, a clearing or an acceptance. Each is made
// to happen in one order by holding the row of the document (or of the account) in a transaction of the test while the
// requests queue behind it, in the order the test starts them; the database lets them through one after another, and
// the test reads what the first left. A weakening that removes the lock, the re-read or the order fails the test of
// its race (the mutations of the pull request, section 9 of the plan).
import { HELD } from './guard.ts';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, json, MAIL, world } from './clearing.ts';
import { MemoryStorage } from './image-storage.ts';
import { load, PASSWORD, prepare } from './identity.ts';

const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const database = prepare('transferraces', { EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { transferScreen } = await import('../../src/lib/account/transfer.ts');
const { confirmDeletion } = await import('../../src/lib/account/deletion.ts');
const { carryOutDeletions } = await import('../../src/lib/account/deletion-steps.ts');
const { confirmClearing, countScope } = await import('../../src/lib/clearing/clearing.ts');
const { answerOffer, makeOffer, expireOffers } = await import('../../src/lib/documents/ownership.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');
const transferRoute = await import('../../src/app/api/account/documents/transfer/route.ts');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, deletedAgo, request, row } = w;

afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(async () => {
  later.length = 0;
  useImageStorage(new MemoryStorage());
  await db().documentClearing.updateMany({
    where: { completedAt: null },
    data: { completedAt: new Date(Date.now() + 365 * DAY_MS) },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  later.length = 0;
});

type Person = Awaited<ReturnType<typeof person>>;
type Tx = Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0];

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/**
 * Holds a row of the document (or of the account) in a transaction of the test, and runs `during`, which starts the
 * requests that wait behind it with `queued`, each started after the one before has had time to reach the lock.
 * Then `inside`, if there is one, is done in the transaction that holds the row (what a request that was in the
 * middle of its own transaction would have done), and the transaction commits: the requests are let through, in
 * the order the database grants them.
 */
async function behind<T>(
  lock: 'document' | 'account',
  id: string,
  during: (queued: (work: () => Promise<unknown>) => Promise<void>) => Promise<T>,
  inside?: (tx: Tx) => Promise<unknown>,
): Promise<T> {
  const locked = gate();
  const queuedAll = gate();
  const transaction = db().$transaction(
    async (tx) => {
      if (lock === 'document') {
        await tx.$queryRaw`SELECT "id" FROM "ekdotico"."Document" WHERE "id" = ${id}::uuid FOR UPDATE`;
      } else {
        await tx.$queryRaw`SELECT "id" FROM "ekdotico"."User" WHERE "id" = ${id} FOR UPDATE`;
      }
      locked.open();
      await queuedAll.opened;
      await inside?.(tx);
    },
    { timeout: 30_000 },
  );
  await locked.opened;
  const queue: Promise<unknown>[] = [];
  try {
    return await during(async (work) => {
      queue.push(work());
      // Long enough for the request to have reached the lock.
      await sleep(400);
    });
  } finally {
    queuedAll.open();
    await transaction;
    await Promise.allSettled(queue);
  }
}

const post = (cookie: string, body: unknown) =>
  transferRoute.POST(
    request('POST', '/api/account/documents/transfer', cookie, { ...(body as object), password: PASSWORD }),
  );
const editorOf = (documentId: string, user: Person, since = 1) =>
  db().documentCollaborator.create({
    data: {
      documentId,
      userId: user.id,
      role: 'EDITOR',
      roleSince: new Date(Date.now() - since * DAY_MS),
      addedAt: new Date(Date.now() - since * DAY_MS),
    },
  });
const offersOf = (documentId: string) =>
  db().ownershipOffer.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
const everything = async (owner: Person) => ({
  mode: 'longest',
  documentIds: (await transferScreen(owner.id)).longest.documentIds,
});
const standing = async () => 'held' as const;

describe('the action against other offers', () => {
  // Mutation R01: the documents are not locked `FOR UPDATE` by the action.
  it('makes one offer for a document when two actions arrive together, and the second keeps the first', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    const body = await everything(owner);
    const results: Response[] = [];
    await behind('document', documentId, async (queued) => {
      await queued(async () => void results.push(await post(owner.cookie, body)));
      await queued(async () => void results.push(await post(owner.cookie, body)));
    });
    expect(results.map(({ status }) => status).sort()).toEqual([200, 201]);
    expect(await offersOf(documentId)).toHaveLength(1);
    expect(await db().notification.count({ where: { recipientId: ed.id, kind: 'ownership_offer' } })).toBe(1);
    const kept = await Promise.all(results.map((response) => json(response)));
    expect(kept.map(({ offered }) => offered).sort()).toEqual([0, 1]);
  });

  // Mutation R02: the offers of the document are not settled and read under its row.
  it('keeps a single offer made just before it, with its Editor, and one made just after is refused as pending', async () => {
    const owner = await person();
    const chosen = await person('chosen');
    const longer = await person('longer');
    const first = await documentOf(owner.id);
    const chosenRow = await editorOf(first, chosen, 1);
    await editorOf(first, longer, 100);
    const body = await everything(owner);
    // The single offer is in the middle of its transaction (it holds the row) when the action arrives.
    let response!: Response;
    await behind(
      'document',
      first,
      async (queued) => {
        await queued(async () => void (response = await post(owner.cookie, body)));
      },
      (tx) =>
        tx.ownershipOffer.create({
          data: {
            documentId: first,
            fromUserId: owner.id,
            toUserId: chosen.id,
            expiresAt: new Date(Date.now() + DAY_MS),
          },
        }),
    );
    // The action had planned an offer to `longer`; under the row it found the pending one: it stays, with its Editor,
    // is counted as offered, and nothing else is made (the set of documents is the same).
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({ offered: 0, kept: 1, cannot: 0 });
    expect((await offersOf(first)).map(({ toUserId }) => toUserId)).toEqual([chosen.id]);

    const second = await documentOf(owner.id);
    const secondRow = await editorOf(second, chosen);
    const single: unknown[] = [];
    await behind('document', second, async (queued) => {
      await queued(async () => void (response = await post(owner.cookie, await everything(owner))));
      await queued(
        async () => void single.push(await makeOffer(second, owner.id, secondRow.id, undefined, HELD)),
      );
    });
    expect(response.status).toBe(201);
    expect(single).toMatchObject([{ outcome: 'pending' }]);
    expect(await offersOf(second)).toHaveLength(1);
    expect(chosenRow.id).not.toBe(secondRow.id);
  });
});

describe('the action against a change of who may be offered a document', () => {
  // Mutation R03: the accounts of the Editors are not held `FOR SHARE` before they are asked for their deletion.
  it('never offers a document to an account whose deletion is confirmed while the action waits', async () => {
    const owner = await person();
    const going = await person('going');
    const staying = await person('staying');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, going, 100);
    await editorOf(documentId, staying, 5);
    const body = await everything(owner);
    let response!: Response;
    // The confirmation of the deletion holds the account's row (`FOR UPDATE`) and records it: the action waits for it
    // at the account's row, and reads the record when it gets there.
    await behind(
      'account',
      going.id,
      async (queued) => {
        await queued(async () => void (response = await post(owner.cookie, body)));
      },
      (tx) => tx.accountDeletion.create({ data: { userId: going.id, requestedAt: new Date() } }),
    );
    // The set differs (the longest-standing Editor is no longer `going`): the action offers nothing, and no offer
    // reaches an account in deletion.
    expect(response.status).toBe(201);
    expect((await offersOf(documentId)).map(({ toUserId }) => toUserId)).toEqual([staying.id]);
  });

  // Mutation R04: the offer is made first, and the step of the deletion does not end it.
  it('has the step of a deletion that follows an offer end it, and tell the Owner', async () => {
    const owner = await person();
    const going = await person('going');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, going);
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    expect((await confirmDeletion(going.id, standing)).outcome).toBe('confirmed');
    await carryOutDeletions();
    const [offer] = await offersOf(documentId);
    expect(offer?.state).toBe('DECLINED');
    expect((await row(documentId))?.ownerId).toBe(owner.id);
    expect(await db().notification.count({ where: { recipientId: going.id, kind: 'ownership_offer' } })).toBe(
      0,
    );
  });

  // Mutation R05: the Editors are read before the lock, from the screen.
  it('refuses the action when an Editor was removed, a role lowered, or the document deleted just before it', async () => {
    const owner = await person();
    const ed = await person('ed');
    const removed = await documentOf(owner.id);
    const lowered = await documentOf(owner.id);
    const trashed = await documentOf(owner.id);
    const removedRow = await editorOf(removed, ed);
    const loweredRow = await editorOf(lowered, ed);
    await editorOf(trashed, ed);
    const cases: [string, (tx: Tx) => Promise<unknown>][] = [
      [removed, (tx) => tx.documentCollaborator.delete({ where: { id: removedRow.id } })],
      [
        lowered,
        (tx) => tx.documentCollaborator.update({ where: { id: loweredRow.id }, data: { role: 'VIEWER' } }),
      ],
      [trashed, (tx) => tx.document.update({ where: { id: trashed }, data: { deletedAt: new Date() } })],
    ];
    for (const [documentId, change] of cases) {
      const body = { mode: 'longest', documentIds: [documentId] };
      let response!: Response;
      await behind(
        'document',
        documentId,
        async (queued) => {
          await queued(async () => void (response = await post(owner.cookie, body)));
        },
        change,
      );
      expect(response.status, documentId).toBe(409);
      expect(await offersOf(documentId), documentId).toHaveLength(0);
    }
  });

  // Mutation R06: a deleted document is not locked, so a restore in flight is not waited for.
  it('refuses the action when a document was restored just before it, and offers nothing', async () => {
    const owner = await person();
    const ed = await person('ed');
    const live = await documentOf(owner.id);
    const trashed = await documentOf(owner.id);
    await editorOf(live, ed);
    await editorOf(trashed, ed);
    await deletedAgo(trashed, owner.id, 1000);
    const body = await everything(owner);
    expect(body.documentIds).toEqual([live]);
    let response!: Response;
    await behind(
      'document',
      trashed,
      async (queued) => {
        await queued(async () => void (response = await post(owner.cookie, body)));
      },
      (tx) => tx.document.update({ where: { id: trashed }, data: { deletedAt: null, deletedById: null } }),
    );
    expect(response.status).toBe(409);
    expect(await offersOf(live)).toHaveLength(0);
    expect(await offersOf(trashed)).toHaveLength(0);
  });
});

describe('the action against a clearing', () => {
  // Mutation R07: the documents are locked by one statement that skips the deleted, or not in the order of the identifiers.
  it('leaves a document both in its notice period and offered, whichever comes first, and an acceptance takes it out', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    const confirm = async () =>
      confirmClearing(
        owner.id,
        { scope: 'all', documentIds: (await countScope(owner.id, 'all')).documentIds },
        standing,
      );

    // The clearing first.
    const cleared = await confirm();
    expect(cleared.outcome).toBe('confirmed');
    expect((await post(owner.cookie, await everything(owner))).status).toBe(201);
    const [offer] = await offersOf(documentId);
    expect((await row(documentId))?.clearingAt?.getTime()).toBeGreaterThan(Date.now() + DAY_MS);
    expect((await answerOffer(ed.id, offer!.id, 'accept')).outcome).toBe('accepted');
    expect((await row(documentId))?.clearingAt).toBeNull();
    expect((await row(documentId))?.ownerId).toBe(ed.id);
  });

  it('waits for a clearing in flight and offers the document as the clearing left it', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    const body = await everything(owner);
    let response!: Response;
    await behind(
      'document',
      documentId,
      async (queued) => {
        await queued(async () => void (response = await post(owner.cookie, body)));
      },
      (tx) =>
        tx.document.update({ where: { id: documentId }, data: { clearingAt: new Date(Date.now() - 1000) } }),
    );
    // The day has come under the lock: the document is the timer's and is not offered; the set differs.
    expect(response.status).toBe(409);
    expect(await offersOf(documentId)).toHaveLength(0);
  });

  // Mutation I1 (review of pull request 64, item 1): the time is read when the request begins, before the waits for the locks.
  it('judges the day of a clearing by the time after it has waited for the locks, not by the time it began', async () => {
    const owner = await person();
    const ed = await person('ed');
    const documentId = await documentOf(owner.id);
    await editorOf(documentId, ed);
    // The day is a second and a half away when the request is made, and has passed when it gets the row.
    await db().document.update({
      where: { id: documentId },
      data: { clearingAt: new Date(Date.now() + 1500) },
    });
    const body = await everything(owner);
    expect(body.documentIds).toEqual([documentId]);
    let response!: Response;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (response = await post(owner.cookie, body)));
      await sleep(2200);
    });
    expect(response.status).toBe(409);
    expect(await offersOf(documentId)).toHaveLength(0);
  }, 30_000);

  // Mutation R07b (M30): the documents are locked in the order the database finds them, not in the order of their identifiers.
  it('locks the documents in the order of their identifiers, so that one who takes them in that order does not deadlock with it', async () => {
    const owner = await person();
    const ed = await person('ed');
    const made: string[] = [];
    for (let n = 0; n < 8; n++) {
      const id = await documentOf(owner.id);
      await editorOf(id, ed);
      made.push(id);
    }
    // Two documents whose order of creation (the order the database finds them in) is the reverse of their identifiers'.
    let later_ = '';
    let earlier = '';
    for (let i = 0; i < made.length && !earlier; i++) {
      for (let j = i + 1; j < made.length; j++) {
        if (made[i]! > made[j]!) [earlier, later_] = [made[i]!, made[j]!];
      }
    }
    expect(earlier).not.toBe('');
    const body = await everything(owner);
    // The other transaction holds the document that sorts first, and then asks for the one that sorts after it, as
    // a clearing does: a transfer that took `earlier` first would hold what this asks for while it waits for what this holds.
    const other = db().$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "ekdotico"."Document" WHERE "id" = ${later_}::uuid FOR UPDATE`;
        await sleep(1500);
        await tx.$queryRaw`SELECT "id" FROM "ekdotico"."Document" WHERE "id" = ${earlier}::uuid FOR UPDATE`;
      },
      { timeout: 30_000 },
    );
    await sleep(300);
    const [response, finished] = await Promise.allSettled([post(owner.cookie, body), other]);
    expect(finished.status).toBe('fulfilled');
    expect(response.status === 'fulfilled' && response.value.status).toBe(201);
  }, 40_000);

  // Mutation F, deterministically: the accounts are held before the documents. A step of a deletion holds the documents
  // of the account that goes (`stepRows`), and then writes the account's own row, which waits for any hold on it: a
  // transfer that held the account first and waited for the documents would be waiting for the step that waits for it.
  it('takes the documents before the accounts, so that a step that holds documents and then needs an account row does not deadlock with it', async () => {
    const owner = await person();
    const going = await person('going');
    for (let n = 0; n < 2; n++) await editorOf(await documentOf(owner.id), going, 3 + n);
    const body = await everything(owner);
    const step = db().$transaction(
      async (tx) => {
        await tx.$queryRaw`
          SELECT "id" FROM "ekdotico"."Document" WHERE "ownerId" = ${owner.id} ORDER BY "id" FOR UPDATE`;
        await sleep(1500);
        await tx.$executeRaw`UPDATE "ekdotico"."User" SET "name" = "name" WHERE "id" = ${going.id}`;
      },
      { timeout: 30_000 },
    );
    await sleep(300);
    const [response, finished] = await Promise.allSettled([post(owner.cookie, body), step]);
    expect(finished.status).toBe('fulfilled');
    expect(response.status === 'fulfilled' && response.value.status).toBe(201);
  }, 40_000);

  // Mutation F (review of pull request 64, item 6): the accounts of the recipients are held before the documents.
  // Each round runs two Owners' transfers (the second Owner's document is edited by the first, so each holds an
  // account the other's transaction asks for), a clearing, the deletion of a recipient with its steps, an acceptance
  // and the expiry of offers, begun together. A deadlock is not a hang: the database ends one of the transactions
  // after a second, and that one is a rejection or a 500, which this counts.
  it('does not deadlock with a clearing, the deletion of a recipient and its steps, an acceptance and an expiry begun together', async () => {
    const errors: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args.join(' ')));
    const failures: string[] = [];
    for (let round = 0; round < 12; round++) {
      const owner = await person();
      const going = await person('going');
      const staying = await person('staying');
      const ids: string[] = [];
      for (let n = 0; n < 6; n++) {
        const id = await documentOf(owner.id);
        await editorOf(id, n % 2 === 0 ? going : staying, 5 + n);
        ids.push(id);
      }
      // A second Owner whose document `owner` edits: its transfer holds `owner`'s account row `FOR SHARE`.
      const other = await person('other');
      await editorOf(await documentOf(other.id), owner, 2);
      const accepted = await documentOf(owner.id);
      const acceptedRow = await editorOf(accepted, staying, 3);
      expect((await makeOffer(accepted, owner.id, acceptedRow.id, undefined, HELD)).outcome).toBe('offered');
      const pending = (await offersOf(accepted))[0]!;
      const results = await Promise.race([
        Promise.allSettled([
          post(owner.cookie, await everything(owner)),
          post(other.cookie, await everything(other)),
          confirmClearing(
            owner.id,
            { scope: 'all', documentIds: (await countScope(owner.id, 'all')).documentIds },
            standing,
          ),
          confirmDeletion(going.id, standing).then(() => carryOutDeletions()),
          answerOffer(staying.id, pending.id, 'accept'),
          expireOffers(),
        ]),
        sleep(25_000).then(() => 'hang' as const),
      ]);
      if (results === 'hang') {
        failures.push(`round ${round}: hang`);
        continue;
      }
      results.forEach((result, index) => {
        if (result.status === 'rejected') failures.push(`round ${round}: ${index} rejected`);
        else if (result.value instanceof Response && result.value.status >= 500) {
          failures.push(`round ${round}: ${index} answered ${result.value.status}`);
        }
      });
      // Whatever order they took, no document is left with no Owner or two, and no offer is pending to the account
      // whose deletion has been carried out.
      for (const id of [...ids, accepted]) {
        const document = await db().document.findUniqueOrThrow({
          where: { id },
          include: { collaborators: true },
        });
        expect(document.collaborators.map(({ userId }) => userId)).not.toContain(document.ownerId);
        expect([owner.id, staying.id]).toContain(document.ownerId);
        expect(
          await db().ownershipOffer.count({ where: { documentId: id, state: 'PENDING' } }),
        ).toBeLessThanOrEqual(1);
      }
      await carryOutDeletions();
      expect(await db().ownershipOffer.count({ where: { toUserId: going.id, state: 'PENDING' } })).toBe(0);
    }
    expect(failures).toEqual([]);
    expect(errors.filter((line) => /deadlock|40P01/i.test(line))).toEqual([]);
  }, 400_000);
});
