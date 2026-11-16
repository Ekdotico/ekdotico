// The upload of an image and the link to it (FR-ED-08, NFR-SE-18, NFR-SE-07,
// NFR-SE-02, NFR-SE-17 (c)): the two routes as the router calls them, against a
// provisioned database and the real Valkey, with the store of the tests in place
// of Spaces (the store itself is tested in ./image-store.test.ts). Each test of a
// rule names the weakening that makes it fail.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GPS_MARK,
  SECRET,
  exifSegment,
  exifTiff,
  gif,
  jpeg,
  png,
  pngChunk,
  webp,
  webpChunk,
  WEBP_PICTURE,
} from '../unit/image-fixtures.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';
import { MemoryStorage } from './image-storage.ts';

const MB = 1024 * 1024;
// An account of the founding team without two-factor authentication: the gate of FR-AU-83 stops it.
const FOUNDER = 'image-founder@example.com';
// Room for one image of 20 MB and a little more, and 6 uploads in 10 minutes, so that the limit is reached with few.
const database = prepare('imageroutes', {
  IMAGE_DOCUMENT_MEGABYTES: '25',
  RATE_LIMIT_IMAGE_UPLOADS_PER_USER: '6/600',
  FOUNDING_TEAM_EMAILS: FOUNDER,
});
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { documentOfKey } = await import('../../src/lib/images/storage.ts');
const upload = await import('../../src/app/api/documents/[id]/images/route.ts');
const link = await import('../../src/app/api/documents/[id]/images/[imageId]/route.ts');
const one = await import('../../src/app/api/documents/[id]/route.ts');

afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  useImageStorage(storage);
});
afterEach(() => vi.restoreAllMocks());

let people = 0;
async function person() {
  const email = `image-person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, cookie: cookiesOf(await signIn(auth, email)) };
}
const documentOf = async (userId: string) => (await createDocument(userId)).id;
const ROLES = { editor: 'EDITOR', reviewer: 'REVIEWER', viewer: 'VIEWER' } as const;
async function share(documentId: string, userId: string, role: keyof typeof ROLES) {
  await db().documentCollaborator.create({ data: { documentId, userId, role: ROLES[role] } });
}

const at = (params: Record<string, string>) => ({
  params: Promise.resolve(params) as Promise<{ id: string }>,
});
const send = (
  documentId: string,
  cookie: string | undefined,
  body: string | Buffer | null,
  headers: Record<string, string> = {},
) =>
  upload.POST(
    new Request(`${ORIGIN}/api/documents/${documentId}/images`, {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'image/png', ...(cookie ? { cookie } : {}), ...headers },
      body: typeof body === 'string' || body === null ? body : new Uint8Array(body),
    }),
    at({ id: documentId }),
  );
const linkTo = (documentId: string, imageId: string, cookie: string | undefined) =>
  link.GET(
    new Request(`${ORIGIN}/api/documents/${documentId}/images/${imageId}`, {
      method: 'GET',
      headers: cookie ? { cookie } : {},
    }),
    at({ id: documentId, imageId }),
  );
/** What the two routes answer with, as a test reads it. */
interface Answer {
  id: string;
  contentType: string;
  byteSize: number;
  url: string;
  expiresAt: string;
  error: { code: string; message: string };
}
const bodyOf = async (response: Response) => (await response.json()) as Answer;

/** A PNG with every kind of metadata that matters, padded with filler after its end to the size wanted. */
function pngOf(size = 0) {
  const base = png({
    before: [pngChunk('tEXt', Buffer.from(`Comment\0${SECRET}`)), pngChunk('eXIf', exifTiff(null))],
  });
  return size > base.length ? Buffer.concat([base, Buffer.alloc(size - base.length)]) : base;
}

/** A PNG whose picture, which the removal keeps, is `size` bytes in all: what it costs a document. */
function bigPng(size: number) {
  const base = png().length;
  return png({ before: [pngChunk('IDAT', Buffer.alloc(size - base - 12))] });
}

describe('the upload of an image', () => {
  it('stores the image under a key that names its document, with the type established and no metadata, and answers with its identifier alone', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const response = await send(document, owner.cookie, pngOf());
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await bodyOf(response);
    expect(Object.keys(body).sort()).toEqual(['byteSize', 'contentType', 'id']);
    expect(body.contentType).toBe('image/png');

    const row = await db().documentImage.findUniqueOrThrow({ where: { id: body.id } });
    expect(row).toMatchObject({ documentId: document, uploadedById: owner.id, contentType: 'image/png' });
    expect(row.byteSize).toBe(body.byteSize);
    // Out of the document until its block is stored (NFR-SE-18).
    expect(row.unreferencedAt).not.toBeNull();
    // The key names its document, is 128 random bits, and holds nothing the user typed.
    expect(row.objectKey).toMatch(/^images\/[0-9a-f-]{36}\/[0-9a-f]{32}$/);
    expect(documentOfKey(row.objectKey)).toBe(document);
    // The response holds neither the key nor an address.
    expect(JSON.stringify(body)).not.toContain(row.objectKey);
    expect(JSON.stringify(body)).not.toContain('images/');

    const stored = storage.objects.get(row.objectKey)!;
    expect(stored.contentType).toBe('image/png');
    expect(stored.bytes.length).toBe(row.byteSize);
    // Every kind of metadata of the upload is gone from what is stored, and the bytes are the clean file's.
    expect(Buffer.from(stored.bytes).includes(SECRET)).toBe(false);
    expect(Buffer.from(stored.bytes).includes(GPS_MARK)).toBe(false);
    expect(Buffer.from(stored.bytes).length).toBeLessThan(pngOf().length);
  });

  it.each([
    ['JPEG', () => jpeg({ first: [exifSegment(exifTiff(null))] }), 'image/jpeg'],
    ['WebP', () => webp(), 'image/webp'],
  ])('takes a %s, stored as what it is', async (_name, make, contentType) => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const response = await send(document, owner.cookie, make(), {
      'content-type': 'application/octet-stream',
    });
    expect(response.status).toBe(201);
    const { id } = await bodyOf(response);
    const row = await db().documentImage.findUniqueOrThrow({ where: { id } });
    expect(row.contentType).toBe(contentType);
    expect(storage.objects.get(row.objectKey)!.contentType).toBe(contentType);
  });

  it('takes the type from the content, and a file name and a declared type are no evidence', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    // A PNG that says it is an SVG, under the name of one, is a PNG.
    const png1 = await send(document, owner.cookie, pngOf(), {
      'content-type': 'image/svg+xml',
      'content-disposition': 'attachment; filename="../../evil.svg"',
      'x-file-name': 'evil.svg',
    });
    expect(png1.status).toBe(201);
    const { id } = await bodyOf(png1);
    const row = await db().documentImage.findUniqueOrThrow({ where: { id } });
    expect(row.contentType).toBe('image/png');
    expect(row.objectKey).not.toMatch(/evil|svg|\.\./);
    // An SVG that says it is a PNG, under the name of one, is refused.
    const svg = await send(
      document,
      owner.cookie,
      '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>',
      { 'content-type': 'image/png', 'content-disposition': 'attachment; filename="a.png"' },
    );
    expect(svg.status).toBe(415);
    expect((await bodyOf(svg)).error.code).toBe('image_type_not_accepted');
  });

  it.each([
    ['an SVG file', '<svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an SVG file with its declaration', '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an HTML file', '<!doctype html><script>alert(1)</script>'],
    ['a PDF', '%PDF-1.7 ...'],
    ['nothing', ''],
    ['a PNG that is cut', pngOf().subarray(0, 30)],
  ])('refuses %s with a 415, and stores nothing', async (_name, content) => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const response = await send(document, owner.cookie, content === '' ? null : content);
    expect(response.status).toBe(415);
    const { error } = await bodyOf(response);
    expect(error.code).toBe('image_type_not_accepted');
    expect(error.message).toContain('PNG, JPEG, or WebP');
    expect(storage.objects.size).toBe(0);
    expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
  });

  // D309, D310: every GIF, by its first bytes whatever the name or the declared type, and an animated PNG or WebP.
  // Weakening: a still GIF is taken, the declared type is believed, or the animation is looked for in the pixels.
  it.each([
    ['a still GIF declared as a GIF', () => gif(), 'image/gif', 'image_gif_refused'],
    ['a still GIF declared as a PNG', () => gif(), 'image/png', 'image_gif_refused'],
    [
      'a GIF signature over an SVG',
      () => Buffer.from('GIF89a<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/png',
      'image_gif_refused',
    ],
    [
      'an animated PNG declared as a PNG',
      () => png({ before: [pngChunk('acTL', Buffer.alloc(8))] }),
      'image/png',
      'image_animated_refused',
    ],
    [
      'an animated WebP declared as a WebP',
      () => webp([webpChunk('VP8X', Buffer.from([0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0])), WEBP_PICTURE]),
      'image/webp',
      'image_animated_refused',
    ],
  ])('refuses %s with a 415, and stores nothing', async (_name, make, declared, refusal) => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const response = await send(document, owner.cookie, make(), { 'content-type': declared });
    expect(response.status).toBe(415);
    expect((await bodyOf(response)).error.code).toBe(refusal);
    expect(storage.objects.size).toBe(0);
    expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
  });

  describe('its size (NFR-SE-18, FR-ED-08)', () => {
    it('takes an image of exactly 20 MB, and refuses one of a byte more with a 413', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      expect((await send(document, owner.cookie, pngOf(20 * MB))).status).toBe(201);
      const over = await send(document, owner.cookie, pngOf(20 * MB + 1));
      expect(over.status).toBe(413);
      expect((await bodyOf(over)).error.code).toBe('image_too_large');
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(1);
    });

    // NFR-SE-18, D301, Q80: a small file cannot be a very large picture. Weakening: no check, or the check after the
    // removal of metadata (these files parse to their end).
    it('refuses a small file that declares over 12,000 pixels on a side or 50 megapixels in all, with a 413 that states it, and stores nothing', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const header = (width: number, height: number) => {
        const data = Buffer.alloc(13);
        data.writeUInt32BE(width, 0);
        data.writeUInt32BE(height, 4);
        data[8] = 8;
        data[9] = 2;
        return pngChunk('IHDR', data);
      };
      for (const [width, height] of [
        [12_001, 1],
        [1, 12_001],
        [10_000, 5_001],
      ] as const) {
        const response = await send(document, owner.cookie, png({ ihdr: header(width, height) }));
        expect(response.status, `${width} by ${height}`).toBe(413);
        const { error } = await bodyOf(response);
        expect(error.code).toBe('image_dimensions_too_large');
        // Text for the owner's approval, pinned whole.
        expect(error.message).toBe(
          'That image is more than 12,000 pixels wide or high, or more than 50 megapixels in all, so it was not added. Choose a smaller image, or reduce its size first.',
        );
      }
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
      // At the bound it is taken.
      expect((await send(document, owner.cookie, png({ ihdr: header(10_000, 5_000) }))).status).toBe(201);
    });

    // A length that is declared over the limit is refused as it is: the body is never read.
    it('refuses a declared length over 20 MB before one byte of the body is read', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const body = new ReadableStream<Uint8Array>({
        pull() {
          throw new Error('the body was read');
        },
      });
      const asked = new Request(`${ORIGIN}/api/documents/${document}/images`, {
        method: 'POST',
        headers: { origin: ORIGIN, cookie: owner.cookie, 'content-length': String(20 * MB + 1) },
        body,
        duplex: 'half',
      } as RequestInit);
      const response = await upload.POST(asked, at({ id: document }));
      expect(response.status).toBe(413);
      // Never read: no reader was taken of it, and it was not cancelled.
      expect(body.locked).toBe(false);
      expect(asked.bodyUsed).toBe(false);
    });

    // A body with no length, or one that lies, is stopped at the limit: no more than that is read.
    it('stops a body of no declared length at the limit, having read no more than a chunk past it', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      let pulled = 0;
      const chunk = new Uint8Array(MB);
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > 200) controller.close();
          else controller.enqueue(chunk);
        },
      });
      const response = await upload.POST(
        new Request(`${ORIGIN}/api/documents/${document}/images`, {
          method: 'POST',
          headers: { origin: ORIGIN, cookie: owner.cookie },
          body,
          duplex: 'half',
        } as RequestInit),
        at({ id: document }),
      );
      expect(response.status).toBe(413);
      // 21 MB at the most is read of the 200 on offer (the stream is pulled ahead by its own queue).
      expect(pulled).toBeLessThan(30);
    });

    it('lies about its length and is stopped all the same', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const response = await send(document, owner.cookie, Buffer.alloc(20 * MB + 5), {
        'content-length': '100',
      });
      expect(response.status).toBe(413);
      expect(storage.objects.size).toBe(0);
    });

    // Next.js cuts a body its proxy sees at 320 KB and ends it as if whole (next.config.ts): an image that reached
    // this route so would be stored cut. A body that ends short of the length it declared is not received in full
    // (the second review of pull request 75, B3).
    it('refuses an image that ends short of its declared length as not received in full, and stores nothing', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const whole = pngOf();
      const response = await send(document, owner.cookie, whole, {
        'content-length': String(whole.length + 1000),
      });
      expect(response.status).toBe(400);
      expect((await bodyOf(response)).error.message).toBe(
        'The image did not arrive in full, so it was not added. Choose it again and try again.',
      );
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });
  });

  describe('the 100 MB of a document (here 25 MB, by the setting)', () => {
    it('refuses an image that would pass it with a 413 that states the limit, and stores nothing of it', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      expect((await send(document, owner.cookie, bigPng(20 * MB))).status).toBe(201);
      const refused = await send(document, owner.cookie, bigPng(6 * MB));
      expect(refused.status).toBe(413);
      const { error } = await bodyOf(refused);
      expect(error.code).toBe('image_document_full');
      expect(error.message).toContain('25 MB');
      expect(storage.objects.size).toBe(1);
      // An image that fits is still taken.
      expect((await send(document, owner.cookie, bigPng(4 * MB))).status).toBe(201);
    });

    it('counts what an upload that failed had taken as nothing', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('store down'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await send(document, owner.cookie, bigPng(20 * MB))).status).toBe(500);
      expect((await send(document, owner.cookie, bigPng(20 * MB))).status).toBe(201);
    });
  });

  describe('a fault of the store', () => {
    it('answers a 500 that says nothing of it, deletes the row the upload took, and gives the upload back', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(storage, 'put').mockRejectedValue(
        Object.assign(new Error('AccessDenied for key images/secret-bucket-detail'), {
          code: 'AccessDenied',
        }),
      );
      for (let each = 0; each < 7; each += 1) {
        const response = await send(document, owner.cookie, pngOf());
        expect(response.status).toBe(500);
        const text = JSON.stringify(await bodyOf(response));
        expect(text).not.toMatch(/AccessDenied|secret-bucket|images\//);
      }
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
      // Seven failures, a limit of six: each was given back, so the next one is not refused.
      vi.restoreAllMocks();
      expect((await send(document, owner.cookie, pngOf())).status).toBe(201);
      expect(printed.mock.calls.every((call) => !String(call[0]).includes('secret-bucket'))).toBe(true);
    });

    it('answers a 503 where there is no store, counts nothing, and writes nothing', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      useImageStorage(null);
      const response = await send(document, owner.cookie, pngOf());
      expect(response.status).toBe(503);
      expect((await bodyOf(response)).error.code).toBe('images_unavailable');
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
      // Not counted against the limit of the user: six uploads follow when there is a store.
      useImageStorage(storage);
      for (let each = 0; each < 6; each += 1) {
        expect((await send(document, owner.cookie, pngOf())).status).toBe(201);
      }
    });
  });

  // The review of pull request 52 (S2): a put that throws may have kept the bytes (the answer was lost, or
  // the last attempt timed out). The object is removed, and the row with it; where the object cannot be
  // removed the row stays, with the time that lets the timer find the object through it.
  describe('a put that threw after the store kept the bytes', () => {
    /** The store takes the object and then fails, as a store does whose answer is lost. */
    const keepsThenFails = () =>
      vi.spyOn(storage, 'put').mockImplementation(async (key, bytes, contentType) => {
        storage.objects.set(key, { bytes, contentType });
        throw Object.assign(new Error('the answer was lost'), { code: 'RequestTimeout' });
      });

    it('removes the object and the row, and leaves nothing that the timer would have to find', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      keepsThenFails();
      expect((await send(document, owner.cookie, pngOf())).status).toBe(500);
      expect(storage.objects.size).toBe(0);
      expect(storage.removals).toHaveLength(1);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });

    it('keeps the row where the object cannot be removed, so that the timer removes both within 30 days', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
      keepsThenFails();
      vi.spyOn(storage, 'remove').mockRejectedValue(
        Object.assign(new Error('AccessDenied images/secret-detail'), { code: 'AccessDenied' }),
      );
      const response = await send(document, owner.cookie, pngOf());
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('AccessDenied');
      // The object is there, and a row names it: unreferenced from now, which is the clock of the timer.
      expect(storage.objects.size).toBe(1);
      const [row] = await db().documentImage.findMany({ where: { documentId: document } });
      expect(row).toMatchObject({ documentId: document, unreferencedAt: expect.any(Date) });
      expect(storage.objects.has(row!.objectKey)).toBe(true);
      // The line says which image and the class of the fault, and nothing of the message or the key.
      const lines = printed.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes(row!.id) && line.includes('AccessDenied'))).toBe(true);
      expect(lines.every((line) => !line.includes('secret-detail') && !line.includes(row!.objectKey))).toBe(
        true,
      );
      // It counts toward the 100 MB until it is deleted, as every stored object does (Q14).
      // And the timer, 30 days on, removes the object and the row.
      vi.restoreAllMocks();
      const { deleteExpiredImages } = await import('../../src/lib/images/deletion.ts');
      expect(
        await deleteExpiredImages(storage, new Date(Date.now() + 31 * 24 * 60 * 60 * 1000)),
      ).toBeGreaterThanOrEqual(1);
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });
  });

  // The review of pull request 52 (S3): a client that resets its connection while it sends is not a fault of ours,
  // and is not given its count back, or it could send nearly 20 MB again and again and never be counted.
  describe('a body that does not arrive whole', () => {
    /** A body that sends `sent` bytes and then fails, as a connection that is reset does. */
    const aborted = (sent: number) =>
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            controller.enqueue(new Uint8Array(sent));
            controller.error(new Error('connection reset'));
          },
        },
        { highWaterMark: 0 },
      );
    const sendStream = (documentId: string, cookie: string, body: ReadableStream<Uint8Array>) =>
      upload.POST(
        new Request(`${ORIGIN}/api/documents/${documentId}/images`, {
          method: 'POST',
          headers: { origin: ORIGIN, cookie, 'content-type': 'image/png' },
          body,
          duplex: 'half',
        } as RequestInit),
        at({ id: documentId }),
      );

    it('is a 400 that says so, stores nothing, and keeps its count: the seventh of six is refused', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      for (let each = 0; each < 6; each += 1) {
        const response = await sendStream(document, owner.cookie, aborted(10_000));
        expect(response.status).toBe(400);
        const { error } = await bodyOf(response);
        expect(error.message).toBe(
          'The image did not arrive in full, so it was not added. Choose it again and try again.',
        );
      }
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
      const refused = await send(document, owner.cookie, pngOf());
      expect(refused.status).toBe(429);
    });
  });

  // The review of pull request 52 (S1): the request is authorised before its body is read, which can take
  // minutes for 20 MB. What was decided then is decided again under the lock of the document's row.
  describe('a document that changes while the body is read', () => {
    /** A body that, when it is first read, does `change` and then sends the image: the moment the handler is past `authorise`. */
    const changing = (change: () => Promise<unknown>) =>
      new ReadableStream<Uint8Array>(
        {
          async pull(controller) {
            await change();
            controller.enqueue(new Uint8Array(pngOf()));
            controller.close();
          },
        },
        { highWaterMark: 0 },
      );
    const sendChanging = (documentId: string, cookie: string, change: () => Promise<unknown>) =>
      upload.POST(
        new Request(`${ORIGIN}/api/documents/${documentId}/images`, {
          method: 'POST',
          headers: { origin: ORIGIN, cookie, 'content-type': 'image/png' },
          body: changing(change),
          duplex: 'half',
        } as RequestInit),
        at({ id: documentId }),
      );

    it('takes no image from an Editor who was removed while it was sent: a 404, no row, no object', async () => {
      const owner = await person();
      const editor = await person();
      const document = await documentOf(owner.id);
      await share(document, editor.id, 'editor');
      const response = await sendChanging(document, editor.cookie, () =>
        db().documentCollaborator.deleteMany({ where: { documentId: document, userId: editor.id } }),
      );
      expect(response.status).toBe(404);
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });

    it('takes none from one whose role was lowered to Viewer: a 403 that is logged', async () => {
      const owner = await person();
      const editor = await person();
      const document = await documentOf(owner.id);
      await share(document, editor.id, 'editor');
      const response = await sendChanging(document, editor.cookie, () =>
        db().documentCollaborator.updateMany({
          where: { documentId: document, userId: editor.id },
          data: { role: 'VIEWER' },
        }),
      );
      expect(response.status).toBe(403);
      expect(
        await db().securityLogEntry.count({
          where: { kind: 'forbidden', userId: editor.id, documentId: document },
        }),
      ).toBe(1);
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });

    it('takes none for a document that was put in the trash while it was sent, from its Owner too', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      const response = await sendChanging(document, owner.cookie, () =>
        db().document.update({
          where: { id: document },
          data: { deletedAt: new Date(), deletedById: owner.id },
        }),
      );
      expect(response.status).toBe(404);
      expect(storage.objects.size).toBe(0);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });

    it('takes none from an Owner who passed the document on while it was sent', async () => {
      const owner = await person();
      const next = await person();
      const document = await documentOf(owner.id);
      const response = await sendChanging(document, owner.cookie, () =>
        db().document.update({ where: { id: document }, data: { ownerId: next.id } }),
      );
      // The former Owner holds no role now: a 404.
      expect(response.status).toBe(404);
      expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    });

    it('still takes the image of someone who holds the permission throughout', async () => {
      const owner = await person();
      const editor = await person();
      const document = await documentOf(owner.id);
      await share(document, editor.id, 'editor');
      const response = await sendChanging(document, editor.cookie, async () => undefined);
      expect(response.status).toBe(201);
      expect(storage.objects.size).toBe(1);
    });
  });

  // S-01 of the audit of November 2026: the proxy does not see this path (src/proxy.ts, `config`), so the route takes
  // the limit of every API request itself, where the proxy would: straight after the session, before any refusal that
  // writes to the security log, so that those entries are bounded as the requests are (NFR-SE-07, NFR-SE-19). The
  // weakening that fails these: the limit taken in the handler, after the gate and the permission.
  describe('the limit of API requests for each user, which the proxy takes on every other route', () => {
    /** Spends what is left of the user's limit, `spent` requests having been counted already. */
    const fill = async (userId: string, spent = 0) => {
      const { takeLimit } = await import('../../src/lib/rate-limit.ts');
      const { settings } = await import('../../src/lib/settings.ts');
      expect((await takeLimit('API_PER_USER', userId, settings().limits.API_PER_USER.max - spent)).ok).toBe(
        true,
      );
    };
    const entries = (userId: string, kind: string) =>
      db().securityLogEntry.count({ where: { userId, kind } });

    it('is taken from an Owner: past it the upload is a 429 and nothing is stored', async () => {
      const owner = await person();
      const document = await documentOf(owner.id);
      await fill(owner.id);
      const limited = await send(document, owner.cookie, pngOf());
      expect(limited.status).toBe(429);
      expect((await bodyOf(limited)).error.code).toBe('rate_limited');
      expect(storage.objects.size).toBe(0);
    });

    it('is taken before the permission: a Viewer past it is a 429, and its 403s stop writing to the log', async () => {
      const owner = await person();
      const viewer = await person();
      const document = await documentOf(owner.id);
      await share(document, viewer.id, 'viewer');
      expect((await send(document, viewer.cookie, pngOf())).status).toBe(403);
      expect(await entries(viewer.id, 'forbidden')).toBe(1);
      await fill(viewer.id, 1);
      for (let each = 0; each < 3; each += 1)
        expect((await send(document, viewer.cookie, pngOf())).status).toBe(429);
      expect(await entries(viewer.id, 'forbidden')).toBe(1);
      expect(await entries(viewer.id, 'rate_limit_reached')).toBe(1);
    });

    it('is taken before the founding-team gate: an account it stops is a 429 past it, and writes no more entries', async () => {
      const id = await createAccount(auth, FOUNDER);
      const cookie = cookiesOf(await signIn(auth, FOUNDER));
      const document = await documentOf(id);
      expect((await send(document, cookie, pngOf())).status).toBe(403);
      expect(await entries(id, 'forbidden')).toBe(1);
      await fill(id, 1);
      for (let each = 0; each < 3; each += 1)
        expect((await send(document, cookie, pngOf())).status).toBe(429);
      expect(await entries(id, 'forbidden')).toBe(1);
      expect(await entries(id, 'rate_limit_reached')).toBe(1);
    });
  });

  describe('the limit of 30 in any 10 minutes for each user (here 6), NFR-SE-07', () => {
    it('refuses the seventh with a 429 that says when to try again, counts a file that is refused, and logs it once', async () => {
      const owner = await person();
      const other = await person();
      const document = await documentOf(owner.id);
      for (let each = 0; each < 6; each += 1) {
        // Files that are refused are counted, which is what the limit is for.
        expect((await send(document, owner.cookie, 'not an image')).status).toBe(415);
      }
      const logged = () =>
        db().securityLogEntry.count({ where: { kind: 'rate_limit_reached', userId: owner.id } });
      for (let each = 0; each < 3; each += 1) {
        const limited = await send(document, owner.cookie, pngOf());
        expect(limited.status).toBe(429);
        expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
        const { error } = await bodyOf(limited);
        expect(error.code).toBe('rate_limited');
        expect(error.message).toMatch(
          /^Too many images were uploaded in a short time\. Try again in \d+ minutes?\.$/,
        );
      }
      // Not processed: nothing was stored, and one entry was written for the period and not for each refusal.
      expect(storage.objects.size).toBe(0);
      expect(await logged()).toBe(1);
      // The limit is for the user: another user uploads.
      const mine = await documentOf(other.id);
      expect((await send(mine, other.cookie, pngOf())).status).toBe(201);
    });
  });
});

describe('who may upload (NFR-SE-18, FR-ED-44, NFR-SE-04, NFR-SE-02)', () => {
  it('lets the Owner and an Editor, and refuses a Reviewer and a Viewer with a 403 that is logged', async () => {
    const owner = await person();
    const [editor, reviewer, viewer] = [await person(), await person(), await person()];
    const document = await documentOf(owner.id);
    await share(document, editor.id, 'editor');
    await share(document, reviewer.id, 'reviewer');
    await share(document, viewer.id, 'viewer');
    expect((await send(document, owner.cookie, pngOf())).status).toBe(201);
    expect((await send(document, editor.cookie, pngOf())).status).toBe(201);
    for (const refused of [reviewer, viewer]) {
      const response = await send(document, refused.cookie, pngOf());
      expect(response.status).toBe(403);
      const { error } = await bodyOf(response);
      expect(error.code).toBe('forbidden');
      expect(error.message).toBe('You can read this document but not change it, so the image was not added.');
      expect(
        await db().securityLogEntry.count({
          where: { kind: 'forbidden', userId: refused.id, documentId: document },
        }),
      ).toBe(1);
    }
    expect(await db().documentImage.count({ where: { documentId: document } })).toBe(2);
    // Decided before the limit: a refused person is not counted.
    expect(storage.objects.size).toBe(2);
  });

  it('answers a person with no role, and a document that is not there, with the same 404', async () => {
    const owner = await person();
    const stranger = await person();
    const document = await documentOf(owner.id);
    const refused = await send(document, stranger.cookie, pngOf());
    expect(refused.status).toBe(404);
    const gone = await send('4a1f7a56-4f27-4c0b-8b08-0f6d3b7e9a10', stranger.cookie, pngOf());
    expect(gone.status).toBe(404);
    expect(await refused.text()).toBe(await gone.text());
    expect(storage.objects.size).toBe(0);
  });

  it('refuses a document that is deleted with a 404, and a request with no session with a 401', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    expect((await send(document, undefined, pngOf())).status).toBe(401);
    await db().document.update({
      where: { id: document },
      data: { deletedAt: new Date(), deletedById: owner.id },
    });
    expect((await send(document, owner.cookie, pngOf())).status).toBe(404);
    expect(storage.objects.size).toBe(0);
  });

  it('reads the session’s row: a session that has ended is refused at once, whatever the cookie holds', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    expect((await send(document, owner.cookie, pngOf())).status).toBe(201);
    await db().session.deleteMany({ where: { userId: owner.id } });
    expect((await send(document, owner.cookie, pngOf())).status).toBe(401);
    expect(storage.objects.size).toBe(1);
  });

  it('checks the origin before anything is read or counted', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    for (const origin of [undefined, 'https://evil.example', 'null', `${ORIGIN}.evil.example`]) {
      const response = await upload.POST(
        new Request(`${ORIGIN}/api/documents/${document}/images`, {
          method: 'POST',
          headers: { ...(origin ? { origin } : {}), cookie: owner.cookie, 'content-type': 'image/png' },
          body: new Uint8Array(pngOf()),
        }),
        at({ id: document }),
      );
      expect(response.status, String(origin)).toBe(403);
    }
    expect(storage.objects.size).toBe(0);
    expect(await db().documentImage.count({ where: { documentId: document } })).toBe(0);
    // Nothing was counted against the user: six uploads follow.
    for (let each = 0; each < 6; each += 1) {
      expect((await send(document, owner.cookie, pngOf())).status).toBe(201);
    }
  });
});

describe('the link to an image (NFR-SE-18)', () => {
  async function uploaded(cookie: string, document: string) {
    const response = await send(document, cookie, pngOf());
    expect(response.status).toBe(201);
    const { id } = await bodyOf(response);
    return db().documentImage.findUniqueOrThrow({ where: { id } });
  }

  it('is issued to everyone who may see the document: the Owner, an Editor, a Reviewer, a Viewer', async () => {
    const owner = await person();
    const [editor, reviewer, viewer] = [await person(), await person(), await person()];
    const document = await documentOf(owner.id);
    await share(document, editor.id, 'editor');
    await share(document, reviewer.id, 'reviewer');
    await share(document, viewer.id, 'viewer');
    const image = await uploaded(owner.cookie, document);
    for (const who of [owner, editor, reviewer, viewer]) {
      const before = Date.now();
      const response = await linkTo(document, image.id, who.cookie);
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const body = await bodyOf(response);
      expect(Object.keys(body).sort()).toEqual(['expiresAt', 'url']);
      // Valid for 5 minutes, for the object of this image alone, with its type.
      expect(body.url).toBe(`memory://${image.objectKey}?expires=300`);
      const expires = new Date(body.expiresAt).getTime();
      expect(expires).toBeGreaterThanOrEqual(before + 300_000);
      expect(expires).toBeLessThan(Date.now() + 300_000 + 1000);
    }
  });

  it('asks the store for the lifetime of the setting, the key of the row, and the type the server established', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const image = await uploaded(owner.cookie, document);
    const linking = vi.spyOn(storage, 'link');
    await linkTo(document, image.id, owner.cookie);
    expect(linking).toHaveBeenCalledWith(image.objectKey, 300, 'image/png');
  });

  it('is a 404 for a person who may not see the document, and the 404 of a document that is not there', async () => {
    const owner = await person();
    const stranger = await person();
    const document = await documentOf(owner.id);
    const image = await uploaded(owner.cookie, document);
    const refused = await linkTo(document, image.id, stranger.cookie);
    expect(refused.status).toBe(404);
    const gone = await linkTo('4a1f7a56-4f27-4c0b-8b08-0f6d3b7e9a10', image.id, stranger.cookie);
    expect(await refused.text()).toBe(await gone.text());
    expect((await linkTo(document, image.id, undefined)).status).toBe(401);
  });

  // The identifier of an image of one document asked for under another: the document is matched on the row.
  it('is a 404 for an image of another document, byte for byte the 404 of an identifier that names nothing', async () => {
    const owner = await person();
    const other = await person();
    const [mine, theirs] = [await documentOf(owner.id), await documentOf(other.id)];
    const foreign = await uploaded(other.cookie, theirs);
    const own = await uploaded(owner.cookie, mine);
    // Under a document the person owns.
    const across = await linkTo(mine, foreign.id, owner.cookie);
    expect(across.status).toBe(404);
    const nothing = await linkTo(mine, 'c' + 'x'.repeat(24), owner.cookie);
    expect(nothing.status).toBe(404);
    expect(await across.text()).toBe(await nothing.text());
    // And it is the 404 of a document that is not there, which says nothing of what exists.
    const nowhere = await linkTo('4a1f7a56-4f27-4c0b-8b08-0f6d3b7e9a10', foreign.id, owner.cookie);
    expect(await nowhere.text()).toBe(await (await linkTo(mine, 'c' + 'x'.repeat(24), owner.cookie)).text());
    // Under the document it belongs to, by a person who has no role there.
    expect((await linkTo(theirs, foreign.id, owner.cookie)).status).toBe(404);
    // And what is theirs is theirs: the same call by its own Owner works, and mine under mine.
    expect((await linkTo(theirs, foreign.id, other.cookie)).status).toBe(200);
    expect((await linkTo(mine, own.id, owner.cookie)).status).toBe(200);
  });

  it('is a 404 for an image whose deletion has been claimed, and for a document that is deleted', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const image = await uploaded(owner.cookie, document);
    await db().documentImage.update({ where: { id: image.id }, data: { deletionClaimedAt: new Date() } });
    expect((await linkTo(document, image.id, owner.cookie)).status).toBe(404);
    await db().documentImage.update({ where: { id: image.id }, data: { deletionClaimedAt: null } });
    expect((await linkTo(document, image.id, owner.cookie)).status).toBe(200);
    await db().document.update({
      where: { id: document },
      data: { deletedAt: new Date(), deletedById: owner.id },
    });
    expect((await linkTo(document, image.id, owner.cookie)).status).toBe(404);
  });

  // NFR-SE-02, NFR-SE-17 (c): the issue of a link is one of the requests that read the session's row. A read
  // that does not is answered for the minute that the signed copy lives, as the read of the document is below.
  it('reads the session’s row and not the cookie’s signed copy: a session that has ended gets no link', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const image = await uploaded(owner.cookie, document);
    expect((await linkTo(document, image.id, owner.cookie)).status).toBe(200);
    await db().session.deleteMany({ where: { userId: owner.id } });
    // The copy in the cookie is still valid for a minute, and a read that uses it is still answered ...
    const read = await one.GET(
      new Request(`${ORIGIN}/api/documents/${document}`, { headers: { cookie: owner.cookie } }),
      at({ id: document }),
    );
    expect(read.status).toBe(200);
    // ... and the link is not.
    const refused = await linkTo(document, image.id, owner.cookie);
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain('memory://');
  });

  it('is a 503 where there is no store, and a 500 that says nothing of a store that fails', async () => {
    const owner = await person();
    const document = await documentOf(owner.id);
    const image = await uploaded(owner.cookie, document);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(storage, 'link').mockRejectedValueOnce(new Error(`signing failed for ${image.objectKey}`));
    const failed = await linkTo(document, image.id, owner.cookie);
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain(image.objectKey);
    useImageStorage(null);
    expect((await linkTo(document, image.id, owner.cookie)).status).toBe(503);
  });
});
