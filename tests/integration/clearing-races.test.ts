// The races of a clearing (FR-AU-91, FR-AU-58, FR-ED-36, FR-ED-37, FR-ED-47; NFR-SE-04; docs/plan/slice-23.md,
// section 3): the confirmation against an invitation, an acceptance, a restore, a deletion by hand, an offer of
// ownership, the confirmation of the deletion of the account, and itself; and a timer's claim against a
// cancellation and an offer. Each is made to happen in one order by holding the row of the document (or of the
// account) in a transaction of the test while the requests queue behind it, in the order the test starts them; the
// database lets them through one after another, and the test reads what the first left. A weakening that removes
// the lock, the condition or the re-read fails the test of its race.
import { randomUUID } from 'node:crypto';
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

const database = prepare('clearingraces', { EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { carryOutClearings } = await import('../../src/lib/clearing/deletion.ts');
const { confirmClearing, cancelClearing, countScope } = await import('../../src/lib/clearing/clearing.ts');
const { createInvitations, answerInvitation } = await import('../../src/lib/documents/sharing.ts');
const { deleteDocument, deleteExpiredDocuments, restoreDocument } =
  await import('../../src/lib/documents/deletion.ts');
const { answerOffer, makeOffer } = await import('../../src/lib/documents/ownership.ts');
const { istorico } = await import('../../src/lib/istorico/index.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, share, invite, deletedAgo, row } = w;

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

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

type Tx = Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0];

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

const standing = async () => 'held' as const;
const confirmFor = async (userId: string) =>
  confirmClearing(
    userId,
    { scope: 'all', documentIds: (await countScope(userId, 'all')).documentIds },
    standing,
  );

describe('the confirmation, and who changes who holds a role', () => {
  // Mutation L01: the documents are not locked `FOR UPDATE` by the confirmation (they are read, not held).
  it('sees a collaborator added just before it: the document is shared, and its new collaborator is told', async () => {
    const owner = await person();
    const newcomer = await person('newcomer');
    const documentId = await documentOf(owner.id);
    let result: Awaited<ReturnType<typeof confirmFor>> | undefined;
    await behind(
      'document',
      documentId,
      async (queued) => {
        await queued(async () => {
          result = await confirmFor(owner.id);
        });
      },
      // An acceptance in the middle of its transaction, which holds the row: the confirmation waits behind it.
      (tx) => tx.documentCollaborator.create({ data: { documentId, userId: newcomer.id, role: 'VIEWER' } }),
    );
    expect(result?.outcome).toBe('confirmed');
    expect(result?.outcome === 'confirmed' && result.sharedIds).toEqual([documentId]);
    expect(
      await db().notification.count({ where: { recipientId: newcomer.id, kind: 'clearing_notice' } }),
    ).toBe(1);
    expect((await row(documentId))?.clearingAt?.getTime()).toBeGreaterThan(Date.now() + DAY_MS);
  });

  // Mutation L02: the acceptance of an invitation does not take the document's row, or reads the invitation before the revocation.
  it('revokes an invitation that is accepted just after it, so that no one joins a document about to be deleted', async () => {
    const owner = await person();
    const invitee = await person('invitee');
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    const pending = await invite(documentId, owner.id, invitee.email);
    let accepted: Awaited<ReturnType<typeof answerInvitation>> | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        accepted = await answerInvitation(invitee.id, { id: pending.id }, 'accept');
      });
    });
    expect(accepted?.outcome).toBe('no_longer_open');
    expect(await db().documentCollaborator.count({ where: { documentId, userId: invitee.id } })).toBe(0);
    expect((await db().documentInvitation.findUniqueOrThrow({ where: { id: pending.id } })).state).toBe(
      'REVOKED',
    );
  });

  // Mutation L03: `creating` does not read the column under the lock.
  it('refuses an invitation created just after the confirmation', async () => {
    const owner = await person();
    const reader = await person('reader');
    const invitee = await person('invitee');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    let created: Awaited<ReturnType<typeof createInvitations>> | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        created = await createInvitations(
          { id: documentId, ownerId: owner.id },
          owner.id,
          [invitee.email],
          'editor',
        );
      });
    });
    expect(created?.outcome).toBe('clearing');
    expect(await db().documentInvitation.count({ where: { documentId, state: 'PENDING' } })).toBe(0);
  });
});

describe('the confirmation against the other things the Owner can do to the document', () => {
  // Mutation L04: `restoreDocument` loses its `clearingAt: null` condition.
  it('does not let a restore that waits behind it succeed', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    await deletedAgo(documentId, owner.id, DAY_MS);
    let restored: Awaited<ReturnType<typeof restoreDocument>> | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        restored = await restoreDocument({ id: documentId });
      });
    });
    expect(restored).toBeNull();
    expect((await row(documentId))?.deletedAt).not.toBeNull();
    expect((await row(documentId))?.clearingAt).not.toBeNull();
  });

  // Mutation L05: `deleteDocument` loses its `clearingAt: null` condition.
  it('does not let a deletion by hand that waits behind it succeed, so the collaborators keep their access until the day', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    let deleted: boolean | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        deleted = await deleteDocument({ id: documentId }, owner.id);
      });
    });
    expect(deleted).toBe(false);
    expect((await row(documentId))?.deletedAt).toBeNull();
  });

  // Mutation L06: `renameDocument` loses its `clearingAt: null` condition.
  it('does not let a rename that waits behind it succeed', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id, 'Before');
    await share(documentId, reader.id);
    const { renameDocument } = await import('../../src/lib/documents/documents.ts');
    let renamed: Awaited<ReturnType<typeof renameDocument>> | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        renamed = await renameDocument(documentId, 'After');
      });
    });
    expect(renamed).toBeNull();
    expect((await row(documentId))?.title).toBe('Before');
  });

  // Mutation L07: the reservation of an image does not read the column under the lock.
  it('does not let an image upload that waits behind it be reserved', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    const { reserveImage } = await import('../../src/lib/images/quota.ts');
    let reservation: Awaited<ReturnType<typeof reserveImage>> | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        reservation = await reserveImage({
          documentId,
          uploadedById: owner.id,
          objectKey: `documents/${documentId}/${randomUUID()}`,
          contentType: 'image/png',
          byteSize: 3,
        });
      });
    });
    expect(reservation).toEqual({ ok: false, reason: 'clearing' });
    expect(await db().documentImage.count({ where: { documentId } })).toBe(0);
  });

  // Mutation L08: the confirmation does not hold the account's row against the confirmation of its deletion.
  it('is refused where the deletion of the account is confirmed first, and clears nothing', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    let result: Awaited<ReturnType<typeof confirmFor>> | undefined;
    await behind(
      'account',
      owner.id,
      async (queued) => {
        await queued(async () => {
          result = await confirmFor(owner.id);
        });
      },
      // The record of the deletion, made by a transaction that holds the account's row, as the confirmation does.
      (tx) => tx.accountDeletion.create({ data: { userId: owner.id } }),
    );
    expect(result?.outcome).toBe('not_found');
    expect((await row(documentId))?.clearingAt).toBeNull();
    expect(await db().documentClearing.count({ where: { userId: owner.id } })).toBe(0);
  });

  // A regression test: the lock itself is proved by the test of a collaborator added just before the confirmation.
  it('lets two confirmations of the same documents at once make one clearing, and refuses the other', async () => {
    const owner = await person();
    const reader = await person('reader');
    const ids: string[] = [];
    for (let at = 0; at < 5; at++) {
      const id = await documentOf(owner.id);
      await share(id, reader.id);
      ids.push(id);
    }
    const results: Awaited<ReturnType<typeof confirmFor>>[] = [];
    const request = (await countScope(owner.id, 'all')).documentIds;
    await behind('document', ids[0]!, async (queued) => {
      for (let each = 0; each < 2; each++) {
        await queued(async () => {
          results.push(await confirmClearing(owner.id, { scope: 'all', documentIds: request }, standing));
        });
      }
    });
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(['changed', 'confirmed']);
    expect(await db().documentClearing.count({ where: { userId: owner.id } })).toBe(1);
    expect(
      await db().notification.count({ where: { recipientId: reader.id, kind: 'clearing_notice' } }),
    ).toBe(5);
  });

  // Mutation L10: `answerOffer` does not take the document out of the clearing.
  it('lets an acceptance that waits behind it take the document out of the clearing', async () => {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await share(documentId, editor.id, 'EDITOR');
    const collaborator = await db().documentCollaborator.findFirstOrThrow({ where: { documentId } });
    expect((await makeOffer(documentId, owner.id, collaborator.id)).outcome).toBe('offered');
    const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId } });
    let answer: Awaited<ReturnType<typeof answerOffer>> | undefined;
    await behind('document', documentId, async (queued) => {
      await queued(async () => void (await confirmFor(owner.id)));
      await queued(async () => {
        answer = await answerOffer(editor.id, offer.id, 'accept');
      });
    });
    expect(answer).toEqual({ outcome: 'accepted', documentId });
    const after = await row(documentId);
    expect(after?.ownerId).toBe(editor.id);
    expect(after?.clearingAt).toBeNull();
    expect(await carryOutClearings(new Date(Date.now() + 8 * DAY_MS))).toEqual({ deleted: 0, kept: 0 });
    expect(await row(documentId)).not.toBeNull();
  });
});

describe('a timer’s claim against a cancellation and an acceptance (NFR-RE-15)', () => {
  /** A shared recorded document whose erasure waits on a gate the test opens. */
  async function claimed() {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await share(documentId, editor.id, 'EDITOR');
    const collaborator = await db().documentCollaborator.findFirstOrThrow({ where: { documentId } });
    expect((await makeOffer(documentId, owner.id, collaborator.id)).outcome).toBe('offered');
    const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId } });
    // Recorded only now: a recorded document cannot be offered (FR-ED-47), and this one is asked of Istorico.
    await db().document.update({ where: { id: documentId }, data: { recording: 'RECORDED' } });
    const response = await w.clear(owner.cookie, {
      scope: 'all',
      documentIds: (await countScope(owner.id, 'all')).documentIds,
      password: PASSWORD,
    });
    const day = new Date((await json(response)).deleteOn as string);
    const port = istorico();
    vi.spyOn(port, 'capabilities').mockReturnValue({ ...port.capabilities(), erasure: true });
    const erasing = gate();
    const started = gate();
    vi.spyOn(port, 'erase').mockImplementation(async () => {
      started.open();
      await erasing.opened;
      return { ok: true, value: [{ documentId, outcome: 'erased' }] } as never;
    });
    return { owner, editor, documentId, offer, day, erasing, started };
  }

  // Mutation M01: the claim does not end the access (no deletedAt in the same statement), so an offer is accepted after it.
  it('refuses the acceptance of an offer, and a cancellation, once a timer holds the document', async () => {
    const { owner, editor, documentId, offer, day, erasing, started } = await claimed();
    const run = carryOutClearings(day);
    await started.opened;
    // The claim is the document's; its access has ended in the statement that made it.
    expect((await row(documentId))?.deletionClaimedAt).not.toBeNull();
    expect((await row(documentId))?.deletedAt).not.toBeNull();
    expect(await answerOffer(editor.id, offer.id, 'accept')).toEqual({ outcome: 'no_longer_open' });
    // The day is ahead of the clock of this process, so the cancellation would be allowed but for the claim.
    expect(await cancelClearing(owner.id, documentId)).toEqual({ outcome: 'too_late' });
    expect((await row(documentId))?.ownerId).toBe(owner.id);
    erasing.open();
    expect(await run).toEqual({ deleted: 1, kept: 0 });
    expect(await row(documentId)).toBeNull();
  });
});

// The window between what a timer reads as due and the claim it makes (review item 3): something commits there, and
// the claim, which names its conditions in the write, finds them no longer true and leaves the document alone.
describe('something that commits between the timer’s read of what is due and its claim', () => {
  /** Runs `change` once, right after the first read of the due documents (the one that selects `recording`). */
  async function inTheWindow<T>(change: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
    const delegate = db().document;
    const original = delegate.findMany.bind(delegate);
    let fired = false;
    const spy = vi.spyOn(delegate, 'findMany').mockImplementation((async (args: unknown) => {
      const read = await original(args as never);
      if (!fired && JSON.stringify(args).includes('recording')) {
        fired = true;
        await change();
      }
      return read;
    }) as never);
    try {
      const result = await run();
      expect(fired).toBe(true);
      return result;
    } finally {
      spy.mockRestore();
    }
  }
  async function waiting() {
    const owner = await person();
    const editor = await person('editor');
    const documentId = await documentOf(owner.id);
    await share(documentId, editor.id, 'EDITOR');
    const response = await w.clear(owner.cookie, {
      scope: 'all',
      documentIds: (await countScope(owner.id, 'all')).documentIds,
      password: PASSWORD,
    });
    const day = new Date((await json(response)).deleteOn as string);
    return { owner, editor, documentId, day };
  }

  // Mutation W01: the claim of a clearing does not name the day (`clearingAt`) in its write.
  it('does not delete a document whose clearing was cancelled in the window', async () => {
    const { owner, documentId, day } = await waiting();
    const run = await inTheWindow(
      async () =>
        expect(await cancelClearing(owner.id, documentId, new Date(day.getTime() - 1))).toMatchObject({
          outcome: 'cancelled',
        }),
      () => carryOutClearings(day),
    );
    expect(run).toEqual({ deleted: 0, kept: 0 });
    expect(await row(documentId)).not.toBeNull();
    expect((await row(documentId))?.deletedAt).toBeNull();
  });

  // Mutation W02: the claim of a clearing does not name its Owner in its write.
  it('does not delete a document that another Owner holds by the time of the claim, the clearing’s day unmoved', async () => {
    const { editor, documentId, day } = await waiting();
    const run = await inTheWindow(
      () => db().document.update({ where: { id: documentId }, data: { ownerId: editor.id } }),
      () => carryOutClearings(day),
    );
    expect(run).toEqual({ deleted: 0, kept: 0 });
    expect((await row(documentId))?.ownerId).toBe(editor.id);
    expect((await row(documentId))?.deletedAt).toBeNull();
  });

  // Mutation W03: the same, by the acceptance of an offer, which moves the Owner and takes the document out together.
  it('does not delete a document whose ownership was accepted in the window', async () => {
    const { owner, editor, documentId, day } = await waiting();
    const collaborator = await db().documentCollaborator.findFirstOrThrow({
      where: { documentId, userId: editor.id },
    });
    expect(
      (await makeOffer(documentId, owner.id, collaborator.id, new Date(day.getTime() - 60_000))).outcome,
    ).toBe('offered');
    const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId, state: 'PENDING' } });
    const run = await inTheWindow(
      async () =>
        expect(await answerOffer(editor.id, offer.id, 'accept', new Date(day.getTime() - 1))).toMatchObject({
          outcome: 'accepted',
        }),
      () => carryOutClearings(day),
    );
    expect(run).toEqual({ deleted: 0, kept: 0 });
    expect((await row(documentId))?.ownerId).toBe(editor.id);
  });

  // Mutation W04: the retention's claim does not name `clearingAt: null`.
  it('leaves to its clearing a deleted document that a clearing took after the retention read it', async () => {
    const owner = await person();
    const reader = await person('reader');
    const documentId = await documentOf(owner.id);
    await share(documentId, reader.id);
    // Within its retention for the clearing (a clearing takes no other, FR-AU-91), and due for a timer whose clock
    // is two days ahead: the window is the time between the timer's read and its claim, and the two instances' clocks.
    await deletedAgo(documentId, owner.id, 29 * DAY_MS);
    const run = await inTheWindow(
      async () => expect((await confirmFor(owner.id)).outcome).toBe('confirmed'),
      () => deleteExpiredDocuments(new Date(Date.now() + 2 * DAY_MS)),
    );
    expect(run).toEqual({ deleted: 0, kept: 0 });
    expect(await row(documentId)).not.toBeNull();
    expect((await row(documentId))?.clearingAt).not.toBeNull();
  });
});
