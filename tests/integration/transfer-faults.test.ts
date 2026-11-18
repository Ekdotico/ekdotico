// A fault in the middle of the transfer of all documents (FR-AU-92, NFR-SE-07; docs/plan/slice-24.md, section 10, item 7 of the
// review of pull request 64): the count of the offers is taken inside the transaction, so that it is given back where the
// transaction then fails, and the same action can be made again at once. In a file of its own, since it replaces
// `createOffer` of src/lib/documents/ownership.ts by one that fails on the call it is told to.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DAY_MS, json, MAIL, world } from './clearing.ts';
import { MemoryStorage } from './image-storage.ts';
import { load, PASSWORD, prepare } from './identity.ts';

const flags = vi.hoisted(() => ({ failAfter: -1, made: 0 }));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: () => undefined,
}));
vi.mock('../../src/lib/documents/ownership.ts', async (original) => {
  const real = await original<typeof import('../../src/lib/documents/ownership.ts')>();
  return {
    ...real,
    createOffer: async (...args: Parameters<typeof real.createOffer>) => {
      if (flags.failAfter >= 0 && flags.made++ >= flags.failAfter) throw new Error('injected');
      return real.createOffer(...args);
    },
  };
});

const database = prepare('transferfaults', { EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { transferScreen } = await import('../../src/lib/account/transfer.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');
const transferRoute = await import('../../src/app/api/account/documents/transfer/route.ts');
beforeAll(() => useImageStorage(new MemoryStorage()));
const { person, documentOf, request } = world(loaded, {
  createDocument,
  clearRoute,
  oneRoute,
  useImageStorage,
});

afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a fault after the offers are counted', () => {
  // Mutation I7: the count is not given back where the transaction fails.
  it('gives the count back, makes no offer, and lets the same action be made again within the hour', async () => {
    const owner = await person();
    const ed = await person('ed');
    for (let n = 0; n < 20; n++) {
      const id = await documentOf(owner.id);
      await db().documentCollaborator.create({
        data: { documentId: id, userId: ed.id, role: 'EDITOR', roleSince: new Date(Date.now() - DAY_MS) },
      });
    }
    const body = { mode: 'longest', documentIds: (await transferScreen(owner.id)).longest.documentIds };
    const post = () =>
      transferRoute.POST(
        request('POST', '/api/account/documents/transfer', owner.cookie, { ...body, password: PASSWORD }),
      );
    // The fifth offer fails: the twenty were counted, and the five written are undone with the transaction.
    flags.failAfter = 5;
    const failed = await post();
    flags.failAfter = -1;
    expect(failed.status).toBe(500);
    expect(await db().ownershipOffer.count({ where: { fromUserId: owner.id } })).toBe(0);
    expect(await db().notification.count({ where: { recipientId: ed.id, kind: 'ownership_offer' } })).toBe(0);
    // The twenty are free again: the same request makes all of them.
    const again = await post();
    expect(again.status).toBe(201);
    expect(await json(again)).toEqual({ offered: 20, kept: 0, cannot: 0 });
  }, 60_000);
});
