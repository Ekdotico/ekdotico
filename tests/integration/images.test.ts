// What an image costs a document, and what becomes of it (FR-ED-08, NFR-SE-18,
// NFR-RE-15): the 100 MB under a lock, the clock of an image that is no longer in
// its document, and the timer that deletes it, against a provisioned database,
// with the store of the tests (./image-storage.ts) in place of Spaces until the
// adapter exists (register row S19-1). The clock is a parameter of each function,
// so that "exactly 30 days" is tested to the millisecond. Each test of a rule
// names the weakening that makes it fail.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { createAccount, load, prepare } from './identity.ts';
import { MemoryStorage } from './image-storage.ts';

const MB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
// One megabyte for a document, so that the limit is reached with small numbers.
const database = prepare('images', { IMAGE_DOCUMENT_MEGABYTES: '1' });
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { IMAGE_ID } = await import('../../src/lib/images/node.ts');
const { documentOfKey, newObjectKey } = await import('../../src/lib/images/storage.ts');
const { discardReservation, reserveImage } = await import('../../src/lib/images/quota.ts');
const { forgetReferences, imageIdsIn, recordReferences } = await import('../../src/lib/images/references.ts');
const { IMAGE_CLAIM_STALE_MS, deleteExpiredImages, deleteImagesOfDocument } =
  await import('../../src/lib/images/deletion.ts');
const { storeState } = await import('../../src/lib/collab/state.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

let people = 0;
const owner = async () => createAccount(auth, `images-owner${++people}@example.com`);
const documentOf = async (userId: string) => (await createDocument(userId)).id;

/** A row of an image of a document, as the upload leaves it, with its object in the store where one is given. */
async function imageOf(
  documentId: string,
  userId: string,
  options: {
    byteSize?: number;
    unreferencedAt?: Date | null;
    deletionClaimedAt?: Date | null;
    storage?: MemoryStorage;
  } = {},
) {
  const objectKey = newObjectKey(documentId);
  const image = await db().documentImage.create({
    data: {
      documentId,
      uploadedById: userId,
      objectKey,
      contentType: 'image/png',
      byteSize: options.byteSize ?? 1000,
      unreferencedAt: options.unreferencedAt === undefined ? new Date() : options.unreferencedAt,
      deletionClaimedAt: options.deletionClaimedAt ?? null,
    },
  });
  await options.storage?.put(objectKey, new Uint8Array(image.byteSize), 'image/png');
  return image;
}
const rowOf = (id: string) => db().documentImage.findUnique({ where: { id } });

describe('the table of images', () => {
  it('holds an identifier of the form the block of a document accepts (src/lib/images/node.ts)', async () => {
    const user = await owner();
    const document = await documentOf(user);
    for (let each = 0; each < 5; each += 1) expect((await imageOf(document, user)).id).toMatch(IMAGE_ID);
  });

  // NFR-SE-18 and FR-ED-08, under the route that establishes both: the database refuses what the route let through.
  it.each([
    ['a type that is none of the four', { contentType: 'image/svg+xml' }],
    ['an HTML type', { contentType: 'text/html' }],
    ['a size of 0', { byteSize: 0 }],
    ['a size over 20 MB', { byteSize: 20 * MB + 1 }],
  ])('refuses %s', async (_name, changes) => {
    const user = await owner();
    const document = await documentOf(user);
    await expect(
      db().documentImage.create({
        data: {
          documentId: document,
          uploadedById: user,
          objectKey: newObjectKey(document),
          contentType: 'image/png',
          byteSize: 10,
          ...changes,
        },
      }),
    ).rejects.toThrow();
    // 20 MB itself is allowed.
    await expect(imageOf(document, user, { byteSize: 20 * MB })).resolves.toBeDefined();
  });

  it('holds an object key once', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const first = await imageOf(document, user);
    await expect(
      db().documentImage.create({
        data: {
          documentId: document,
          uploadedById: user,
          objectKey: first.objectKey,
          contentType: 'image/png',
          byteSize: 1,
        },
      }),
    ).rejects.toThrow();
  });

  it('restricts the deletion of a document that has an image: its images go first', async () => {
    const user = await owner();
    const document = await documentOf(user);
    await imageOf(document, user);
    await expect(db().document.delete({ where: { id: document } })).rejects.toThrow();
  });
});

describe('the 100 MB of a document (NFR-SE-18; Q14: every stored object counts)', () => {
  const reserve = (
    documentId: string,
    userId: string,
    byteSize: number,
    now?: Date,
    between?: () => Promise<void>,
  ) =>
    reserveImage(
      {
        documentId,
        uploadedById: userId,
        objectKey: newObjectKey(documentId),
        contentType: 'image/png',
        byteSize,
      },
      now,
      between,
    );

  it('admits an image up to the limit and refuses the byte past it, with what the document holds and the limit', async () => {
    const user = await owner();
    const document = await documentOf(user);
    expect((await reserve(document, user, 600_000)).ok).toBe(true);
    expect(await reserve(document, user, 600_000)).toEqual({ ok: false, heldBytes: 600_000, limitBytes: MB });
    // Exactly the limit is admitted, and not one byte more.
    expect((await reserve(document, user, MB - 600_000)).ok).toBe(true);
    expect(await reserve(document, user, 1)).toEqual({ ok: false, heldBytes: MB, limitBytes: MB });
  });

  it('counts every stored object: one that is out of the document counts until it is deleted', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const out = await imageOf(document, user, {
      byteSize: 700_000,
      unreferencedAt: new Date(Date.now() - 20 * DAY),
    });
    const claimed = await imageOf(document, user, { byteSize: 100_000, deletionClaimedAt: new Date() });
    expect((await reserve(document, user, 300_000)).ok).toBe(false);
    expect((await reserve(document, user, 248_576)).ok).toBe(true);
    // Deleted, it no longer counts.
    await db().documentImage.deleteMany({ where: { id: { in: [out.id, claimed.id] } } });
    expect((await reserve(document, user, 800_000)).ok).toBe(true);
  });

  it('counts the images of one document and no other', async () => {
    const user = await owner();
    const [one, two] = [await documentOf(user), await documentOf(user)];
    expect((await reserve(one, user, MB)).ok).toBe(true);
    expect((await reserve(two, user, MB)).ok).toBe(true);
    expect((await reserve(one, user, 1)).ok).toBe(false);
  });

  it('writes the row with the image out of the document, from the moment it is admitted', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const now = new Date('2026-10-20T10:00:00.000Z');
    const result = await reserve(document, user, 1234, now);
    expect(result.ok && result.image.unreferencedAt).toEqual(now);
    expect(result.ok && result.image.byteSize).toBe(1234);
    expect(result.ok && documentOfKey(result.image.objectKey)).toBe(document);
  });

  it('frees what an upload that could not be stored had taken', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const first = await reserve(document, user, MB);
    expect(first.ok).toBe(true);
    if (first.ok) await discardReservation(first.image.id);
    expect((await reserve(document, user, MB)).ok).toBe(true);
  });

  // Two uploads that each fit alone and not together: the lock is what makes exactly one of them pass.
  // Without the lock both read the same sum (the test makes them meet between the read and the write).
  it('admits exactly one of two uploads at once that do not fit together', async () => {
    for (let round = 0; round < 3; round += 1) {
      const user = await owner();
      const document = await documentOf(user);
      let arrived = 0;
      const meet = async () => {
        arrived += 1;
        const began = Date.now();
        // Each waits for the other where it can; with the lock the second cannot arrive until the first is done.
        while (arrived < 2 && Date.now() - began < 400)
          await new Promise((resolve) => setTimeout(resolve, 10));
      };
      const results = await Promise.all([
        reserve(document, user, 600_000, new Date(), meet),
        reserve(document, user, 600_000, new Date(), meet),
      ]);
      expect(results.filter((each) => each.ok)).toHaveLength(1);
      const { _sum } = await db().documentImage.aggregate({
        where: { documentId: document },
        _sum: { byteSize: true },
      });
      expect(_sum.byteSize).toBe(600_000);
    }
  });

  it('does not make two documents wait for one another’s sum: each is admitted at once', async () => {
    const user = await owner();
    const [one, two] = [await documentOf(user), await documentOf(user)];
    const results = await Promise.all([reserve(one, user, 600_000), reserve(two, user, 600_000)]);
    expect(results.every((each) => each.ok)).toBe(true);
  });
});

describe('what the stored document holds of images (NFR-SE-18; Q14: an image that reappears is kept)', () => {
  const A = 'c' + 'a'.repeat(24);
  const B = 'c' + 'b'.repeat(24);

  /** A shared document with the given elements directly in it. */
  const shared = (...children: Y.XmlElement[]) => {
    const document = new Y.Doc();
    document.getXmlFragment('default').insert(0, children);
    return document;
  };
  const image = (id: unknown) => {
    const made = new Y.XmlElement('image');
    if (id !== undefined) made.setAttribute('id', id as string);
    return made;
  };

  it('reads the identifiers of the image blocks wherever they stand, and nothing else', () => {
    const item = new Y.XmlElement('listItem');
    item.insert(0, [new Y.XmlElement('paragraph'), image(B)]);
    const list = new Y.XmlElement('bulletList');
    list.insert(0, [item]);
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [image(A)]);
    const stray = new Y.XmlElement('paragraph');
    stray.setAttribute('id', 'c' + 'c'.repeat(24));
    expect(
      imageIdsIn(
        shared(list, quote, stray, image('https://example.com/pixel.png'), image(undefined), image('c1')),
      ),
    ).toEqual(new Set([A, B]));
  });

  it('clears the clock of an image that is in a block, and starts it for one that is in none', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const long = new Date(Date.now() - 40 * DAY);
    const placed = await imageOf(document, user, { unreferencedAt: long });
    const taken = await imageOf(document, user, { unreferencedAt: null });
    const now = new Date();
    expect(await recordReferences(document, new Set([placed.id]), now)).toBe(2);
    expect((await rowOf(placed.id))!.unreferencedAt).toBeNull();
    expect((await rowOf(taken.id))!.unreferencedAt).toEqual(now);
  });

  it('does not start the clock again at each store: an image that has been out for days is out since then', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const since = new Date(Date.now() - 12 * DAY);
    const out = await imageOf(document, user, { unreferencedAt: since });
    expect(await recordReferences(document, new Set(), new Date())).toBe(0);
    expect((await rowOf(out.id))!.unreferencedAt).toEqual(since);
  });

  it('starts the clock afresh where an image is taken out a second time', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const out = await imageOf(document, user, { unreferencedAt: new Date(Date.now() - 29 * DAY) });
    await recordReferences(document, new Set([out.id]));
    expect((await rowOf(out.id))!.unreferencedAt).toBeNull();
    const second = new Date();
    await recordReferences(document, new Set(), second);
    expect((await rowOf(out.id))!.unreferencedAt).toEqual(second);
  });

  it('leaves alone an image whose deletion has been claimed: it is not brought back', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const claim = new Date(Date.now() - 60_000);
    const old = new Date(Date.now() - 31 * DAY);
    const claimed = await imageOf(document, user, { unreferencedAt: old, deletionClaimedAt: claim });
    await recordReferences(document, new Set([claimed.id]));
    expect(await rowOf(claimed.id)).toMatchObject({ unreferencedAt: old, deletionClaimedAt: claim });
    // Nor is the claim of one that is in no block given a new clock.
    await recordReferences(document, new Set());
    expect((await rowOf(claimed.id))!.unreferencedAt).toEqual(old);
    // A row that holds a claim and no clock (the claim of a run that found it so, which no run makes
    // but a person at a console might) is not given one either: nothing of a claimed row is touched.
    const odd = await imageOf(document, user, { unreferencedAt: null, deletionClaimedAt: claim });
    await recordReferences(document, new Set());
    expect((await rowOf(odd.id))!.unreferencedAt).toBeNull();
  });

  // A block of one document that names the identifier of an image of another keeps no one's image alive.
  it('reads only the rows of its own document: a block naming another document’s image clears nothing there', async () => {
    const user = await owner();
    const [mine, theirs] = [await documentOf(user), await documentOf(user)];
    const old = new Date(Date.now() - 31 * DAY);
    const foreign = await imageOf(theirs, user, { unreferencedAt: old });
    await recordReferences(mine, new Set([foreign.id]));
    expect((await rowOf(foreign.id))!.unreferencedAt).toEqual(old);
    // Nor does a document that holds none take another's out of its blocks.
    const live = await imageOf(theirs, user, { unreferencedAt: null });
    await recordReferences(mine, new Set());
    expect((await rowOf(live.id))!.unreferencedAt).toBeNull();
  });

  describe('when the collaboration server stores the document (src/lib/collab/state.ts)', () => {
    beforeEach(() => forgetReferences());

    it('reads the document it stores, and writes only what differs from the last store', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const old = new Date(Date.now() - 5 * DAY);
      const one = await imageOf(document, user, { unreferencedAt: old });
      const two = await imageOf(document, user, { unreferencedAt: null });
      const ydoc = shared(image(one.id));
      expect(await storeState(document, ydoc)).toBe(true);
      expect((await rowOf(one.id))!.unreferencedAt).toBeNull();
      expect((await rowOf(two.id))!.unreferencedAt).not.toBeNull();
      // The same blocks again: nothing is written (the row is marked by hand and stays so).
      const marker = new Date(Date.now() - 1000);
      await db().documentImage.update({ where: { id: one.id }, data: { unreferencedAt: marker } });
      expect(await storeState(document, ydoc)).toBe(true);
      expect((await rowOf(one.id))!.unreferencedAt).toEqual(marker);
      // A process that has stored nothing finds the set again: its first store writes what differs.
      forgetReferences();
      await storeState(document, ydoc);
      expect((await rowOf(one.id))!.unreferencedAt).toBeNull();
      // The image is taken out: the clock starts.
      ydoc.getXmlFragment('default').delete(0, 1);
      await storeState(document, ydoc);
      expect((await rowOf(one.id))!.unreferencedAt).not.toBeNull();
    });

    it('is never a reason for a store to fail: a fault is one line without a message, and the next store tries again', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const image1 = await imageOf(document, user, { unreferencedAt: new Date() });
      const ydoc = shared(image(image1.id));
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = vi
        .spyOn(db().documentImage, 'updateMany')
        .mockRejectedValueOnce(
          Object.assign(new Error(`could not connect to ${document} at 10.0.0.1`), { code: 'P1001' }),
        );
      try {
        expect(await storeState(document, ydoc)).toBe(true);
        expect(printed).toHaveBeenCalledTimes(1);
        const line = String(printed.mock.calls[0]![0]);
        expect(line).toContain(document);
        expect(line).toContain('P1001');
        expect(line).not.toContain('10.0.0.1');
        expect(line).not.toContain('could not connect');
        // Nothing was remembered, so the next store writes it.
        failing.mockRestore();
        await storeState(document, ydoc);
        expect((await rowOf(image1.id))!.unreferencedAt).toBeNull();
      } finally {
        failing.mockRestore();
        printed.mockRestore();
      }
    });

    it('writes nothing for a document that is gone', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const row = await imageOf(document, user, { unreferencedAt: new Date(Date.now() - DAY) });
      await db().document.update({
        where: { id: document },
        data: { deletedAt: new Date(), deletedById: user },
      });
      expect(await storeState(document, shared(image(row.id)))).toBe(false);
      expect((await rowOf(row.id))!.unreferencedAt).not.toBeNull();
    });
  });
});

describe('the deletion of images (NFR-SE-18; NFR-RE-15: scheduled, and idempotent)', () => {
  let storage: MemoryStorage;
  const now = new Date('2026-10-20T12:00:00.000Z');
  // The timer takes every image of every document that is due, so each test starts with none: what the
  // tests above left, rows that are long out of their documents among them, would be counted in its answer.
  beforeEach(async () => {
    storage = new MemoryStorage();
    await db().documentImage.deleteMany();
  });

  const out = async (document: string, user: string, since: Date) =>
    imageOf(document, user, { unreferencedAt: since, storage });

  it('deletes an image 30 days after it left its document, to the millisecond: the object and the row', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const almost = await out(document, user, new Date(now.getTime() - 30 * DAY + 1));
    const exactly = await out(document, user, new Date(now.getTime() - 30 * DAY));
    const long = await out(document, user, new Date(now.getTime() - 90 * DAY));
    const before = await db().documentImage.count();
    expect(await deleteExpiredImages(storage, now)).toBe(2);
    expect(await rowOf(almost.id)).not.toBeNull();
    expect(await rowOf(exactly.id)).toBeNull();
    expect(await rowOf(long.id)).toBeNull();
    expect(await db().documentImage.count()).toBe(before - 2);
    expect(storage.objects.has(almost.objectKey)).toBe(true);
    expect(storage.objects.has(exactly.objectKey)).toBe(false);
    expect(storage.objects.has(long.objectKey)).toBe(false);
  });

  it('keeps an image that is in its document, however old it is', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const placed = await imageOf(document, user, { unreferencedAt: null, storage });
    await db().documentImage.update({
      where: { id: placed.id },
      data: { createdAt: new Date(now.getTime() - 400 * DAY) },
    });
    expect(await deleteExpiredImages(storage, now)).toBe(0);
    expect(await rowOf(placed.id)).not.toBeNull();
    expect(storage.removals).toEqual([]);
  });

  it('deletes an upload that was never placed, 30 days after it was admitted', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const admitted = new Date(now.getTime() - 30 * DAY);
    const reserved = await reserveImage(
      {
        documentId: document,
        uploadedById: user,
        objectKey: newObjectKey(document),
        contentType: 'image/png',
        byteSize: 10,
      },
      admitted,
    );
    if (!reserved.ok) throw new Error('not admitted');
    await storage.put(reserved.image.objectKey, new Uint8Array(10), 'image/png');
    expect(await deleteExpiredImages(storage, new Date(admitted.getTime() + 30 * DAY - 1))).toBe(0);
    expect(await deleteExpiredImages(storage, now)).toBe(1);
    expect(storage.objects.has(reserved.image.objectKey)).toBe(false);
  });

  it('is idempotent: a run again, and two runs at once, delete each image once, and none fails', async () => {
    const user = await owner();
    const document = await documentOf(user);
    const images = [];
    for (let each = 0; each < 6; each += 1)
      images.push(await out(document, user, new Date(now.getTime() - 40 * DAY)));
    const [first, second] = await Promise.all([
      deleteExpiredImages(storage, now),
      deleteExpiredImages(storage, now),
    ]);
    expect(first + second).toBe(6);
    // The object of each was removed exactly once.
    expect([...storage.removals].sort()).toEqual(images.map((each) => each.objectKey).sort());
    expect(await deleteExpiredImages(storage, now)).toBe(0);
    expect(storage.removals).toHaveLength(6);
  });

  it('touches no image of anyone else’s that is not due', async () => {
    const user = await owner();
    const [one, two] = [await documentOf(user), await documentOf(user)];
    const due = await out(one, user, new Date(now.getTime() - 31 * DAY));
    const kept = await out(two, user, new Date(now.getTime() - 5 * DAY));
    await deleteExpiredImages(storage, now);
    expect(storage.removals).toEqual([due.objectKey]);
    expect(await rowOf(kept.id)).not.toBeNull();
  });

  describe('a run that does not finish', () => {
    it('leaves the claim, and no other run takes an image that is claimed for less than an hour', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const claim = new Date(now.getTime() - IMAGE_CLAIM_STALE_MS + 1000);
      const held = await imageOf(document, user, {
        unreferencedAt: new Date(now.getTime() - 40 * DAY),
        deletionClaimedAt: claim,
        storage,
      });
      expect(await deleteExpiredImages(storage, now)).toBe(0);
      expect(storage.removals).toEqual([]);
      expect(await rowOf(held.id)).not.toBeNull();
    });

    it('is finished by the run that finds the claim an hour old', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const held = await imageOf(document, user, {
        unreferencedAt: new Date(now.getTime() - 40 * DAY),
        deletionClaimedAt: new Date(now.getTime() - IMAGE_CLAIM_STALE_MS - 1),
        storage,
      });
      expect(await deleteExpiredImages(storage, now)).toBe(1);
      expect(await rowOf(held.id)).toBeNull();
      expect(storage.objects.has(held.objectKey)).toBe(false);
    });

    it('is finished although the object is already gone: a missing object is no fault (a run that died after it)', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const gone = await imageOf(document, user, {
        unreferencedAt: new Date(now.getTime() - 40 * DAY),
        deletionClaimedAt: new Date(now.getTime() - 2 * IMAGE_CLAIM_STALE_MS),
        // No object in the store.
      });
      expect(await deleteExpiredImages(storage, now)).toBe(1);
      expect(await rowOf(gone.id)).toBeNull();
    });

    it('goes on with the others where the store fails for one, says which by its identifier alone, and tries it again later', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const bad = await out(document, user, new Date(now.getTime() - 40 * DAY));
      const good = await out(document, user, new Date(now.getTime() - 40 * DAY));
      storage.failing.set(
        bad.objectKey,
        Object.assign(new Error(`AccessDenied ${bad.objectKey} secret-detail`), { code: 'AccessDenied' }),
      );
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await deleteExpiredImages(storage, now)).toBe(1);
        expect(await rowOf(good.id)).toBeNull();
        // Its row stays, with its claim, and its object.
        expect(await rowOf(bad.id)).toMatchObject({ deletionClaimedAt: expect.any(Date) });
        expect(storage.objects.has(bad.objectKey)).toBe(true);
        expect(printed).toHaveBeenCalledTimes(1);
        const line = String(printed.mock.calls[0]![0]);
        expect(line).toContain(bad.id);
        expect(line).not.toContain(bad.objectKey);
        expect(line).not.toContain(document);
        expect(line).not.toContain('secret-detail');
        // Not at once again: the claim is fresh. After an hour, and with the store well, it is deleted.
        expect(await deleteExpiredImages(storage, now)).toBe(0);
        storage.failing.clear();
        const later = new Date(now.getTime() + IMAGE_CLAIM_STALE_MS + 1000);
        expect(await deleteExpiredImages(storage, later)).toBe(1);
        expect(await rowOf(bad.id)).toBeNull();
      } finally {
        printed.mockRestore();
      }
    });

    it('does not delete what is brought back after the claim: the store of the document does not revive it', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const old = new Date(now.getTime() - 40 * DAY);
      const held = await imageOf(document, user, {
        unreferencedAt: old,
        deletionClaimedAt: new Date(now.getTime() - 1000),
        storage,
      });
      await recordReferences(document, new Set([held.id]));
      expect(await rowOf(held.id)).toMatchObject({ unreferencedAt: old });
    });

    it('does not delete what is brought back before it is claimed', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const back = await out(document, user, new Date(now.getTime() - 40 * DAY));
      await recordReferences(document, new Set([back.id]));
      expect(await deleteExpiredImages(storage, now)).toBe(0);
      expect(await rowOf(back.id)).not.toBeNull();
      expect(storage.objects.has(back.objectKey)).toBe(true);
    });

    it('does not remove the object of an image that was brought back between the finding and the claim', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const race = await out(document, user, new Date(now.getTime() - 40 * DAY));
      // The store of the document clears the clock as the run is about to claim: the claim is conditional.
      const original = db().documentImage.findMany.bind(db().documentImage);
      const finding = vi.spyOn(db().documentImage, 'findMany').mockImplementationOnce(((args: never) =>
        original(args).then(async (found) => {
          await recordReferences(document, new Set([race.id]));
          return found;
        })) as never);
      try {
        expect(await deleteExpiredImages(storage, now)).toBe(0);
      } finally {
        finding.mockRestore();
      }
      expect(storage.removals).toEqual([]);
      expect(await rowOf(race.id)).not.toBeNull();
    });
  });

  describe('the images of a document that is deleted for good (FR-ED-36)', () => {
    it('removes every object and row of that document and no other', async () => {
      const user = await owner();
      const [mine, other] = [await documentOf(user), await documentOf(user)];
      const mineImages = [
        await out(mine, user, now),
        await out(mine, user, now),
        await imageOf(mine, user, { unreferencedAt: null, storage }),
      ];
      const others = await out(other, user, now);
      expect(await deleteImagesOfDocument(storage, mine)).toBe(3);
      expect([...storage.removals].sort()).toEqual(mineImages.map((each) => each.objectKey).sort());
      expect(await db().documentImage.count({ where: { documentId: mine } })).toBe(0);
      expect(await rowOf(others.id)).not.toBeNull();
      // Now the document itself can be deleted, which the restriction refused before.
      await expect(db().document.delete({ where: { id: mine } })).resolves.toBeDefined();
    });

    it('is no fault where an object is already gone, and where there is nothing to delete', async () => {
      const user = await owner();
      const document = await documentOf(user);
      await imageOf(document, user, { unreferencedAt: null });
      expect(await deleteImagesOfDocument(storage, document)).toBe(1);
      expect(await deleteImagesOfDocument(storage, document)).toBe(0);
      expect(await deleteImagesOfDocument(storage, randomUUID())).toBe(0);
    });

    it('rejects where the store does, and keeps the row of every object it did not remove, for the next run', async () => {
      const user = await owner();
      const document = await documentOf(user);
      const first = await out(document, user, now);
      const second = await out(document, user, now);
      const failing = [first, second].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
      storage.failing.set(failing.objectKey, new Error('unavailable'));
      await expect(deleteImagesOfDocument(storage, document)).rejects.toThrow('unavailable');
      expect(await rowOf(failing.id)).not.toBeNull();
      storage.failing.clear();
      expect(await deleteImagesOfDocument(storage, document)).toBeGreaterThanOrEqual(1);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });
  });
});

describe('the wiring of the deletion (NFR-RE-15, FR-ED-36)', () => {
  let storage: MemoryStorage;
  const now = new Date();
  beforeEach(async () => {
    storage = new MemoryStorage();
    useImageStorage(storage);
    await db().documentImage.deleteMany();
  });
  afterAll(() => useImageStorage(undefined));

  /** A document that was deleted this long ago, with images that stand in it. */
  async function deletedDocument(user: string, images: number, daysAgo = 40) {
    const document = await documentOf(user);
    await db().document.update({
      where: { id: document },
      data: { deletedAt: new Date(Date.now() - daysAgo * DAY), deletedById: user },
    });
    const rows = [];
    for (let each = 0; each < images; each += 1) {
      rows.push(await imageOf(document, user, { unreferencedAt: null, storage }));
    }
    return { document, rows };
  }
  const exists = async (id: string) => (await db().document.findUnique({ where: { id } })) !== null;

  describe('the timer image-deletion', () => {
    it('is in TIMERS, and deletes the images that have been out of their documents for 30 days on the store of the process', async () => {
      const { TIMERS } = await import('../../src/lib/timers.ts');
      const user = await owner();
      const document = await documentOf(user);
      const due = await imageOf(document, user, {
        unreferencedAt: new Date(now.getTime() - 31 * DAY),
        storage,
      });
      const kept = await imageOf(document, user, {
        unreferencedAt: new Date(now.getTime() - 29 * DAY),
        storage,
      });
      expect(await TIMERS['image-deletion']!()).toBe(1);
      expect(await rowOf(due.id)).toBeNull();
      expect(storage.objects.has(due.objectKey)).toBe(false);
      expect(await rowOf(kept.id)).not.toBeNull();
      // Run again, and on a second instance at once, it finds nothing and fails nowhere.
      expect(await Promise.all([TIMERS['image-deletion']!(), TIMERS['image-deletion']!()])).toEqual([0, 0]);
    });

    it('does nothing where there is no store and no image, and is a fault, said again each hour, where there is an image and no store', async () => {
      const { deleteExpiredImagesNow } = await import('../../src/lib/images/deletion.ts');
      const user = await owner();
      const document = await documentOf(user);
      useImageStorage(null);
      expect(await deleteExpiredImagesNow()).toBe(0);
      await imageOf(document, user, { unreferencedAt: new Date(now.getTime() - 40 * DAY) });
      await expect(deleteExpiredImagesNow()).rejects.toThrow('no object store set');
      expect(await db().documentImage.count()).toBe(1);
    });
  });

  describe('the permanent deletion of a document', () => {
    it('removes the objects and the rows of its images, and then the document, and leaves another document’s images', async () => {
      const { deleteExpiredDocuments } = await import('../../src/lib/documents/deletion.ts');
      const user = await owner();
      const { document, rows } = await deletedDocument(user, 3);
      const other = await documentOf(user);
      const others = await imageOf(other, user, { unreferencedAt: null, storage });
      expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
      expect(await exists(document)).toBe(false);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
      for (const row of rows) expect(storage.objects.has(row.objectKey)).toBe(false);
      expect(storage.objects.has(others.objectKey)).toBe(true);
      expect(await rowOf(others.id)).not.toBeNull();
    });

    it('is kept where an object cannot be removed, with its rows, and deleted by a later run once it can', async () => {
      const { deleteExpiredDocuments } = await import('../../src/lib/documents/deletion.ts');
      const user = await owner();
      const { document, rows } = await deletedDocument(user, 2);
      storage.failing.set(rows[1]!.objectKey, new Error('store unavailable'));
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 1 });
        expect(await exists(document)).toBe(true);
        expect(await db().documentImage.count({ where: { documentId: document } })).toBeGreaterThanOrEqual(1);
        // The claim of the document is an hour old before another run takes it (src/lib/documents/deletion.ts).
        storage.failing.clear();
        await db().document.update({ where: { id: document }, data: { deletionClaimedAt: null } });
        expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
        expect(await exists(document)).toBe(false);
        for (const row of rows) expect(storage.objects.has(row.objectKey)).toBe(false);
      } finally {
        printed.mockRestore();
      }
    });

    it('is kept where there are images and no store, and deleted where there are none', async () => {
      const { deleteExpiredDocuments } = await import('../../src/lib/documents/deletion.ts');
      const user = await owner();
      const withImages = await deletedDocument(user, 1);
      const without = await deletedDocument(user, 0);
      useImageStorage(null);
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        const result = await deleteExpiredDocuments();
        expect(result).toEqual({ deleted: 1, kept: 1 });
        // Kept for the absence of a store, which is a plain error of ours, and not for the restriction of the
        // database that a row of an image puts on the deletion of its document (a Prisma fault with a code).
        expect(printed.mock.calls.map((call) => String(call[0]))).toEqual([
          `permanent deletion: document ${withImages.document} kept (Error)`,
        ]);
      } finally {
        vi.restoreAllMocks();
      }
      expect(await exists(withImages.document)).toBe(true);
      expect(await exists(without.document)).toBe(false);
    });

    it('deletes nothing from a document that is not past its retention', async () => {
      const { deleteExpiredDocuments } = await import('../../src/lib/documents/deletion.ts');
      const user = await owner();
      const { document, rows } = await deletedDocument(user, 1, 5);
      expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });
      expect(await exists(document)).toBe(true);
      expect(storage.objects.has(rows[0]!.objectKey)).toBe(true);
    });
  });
});
