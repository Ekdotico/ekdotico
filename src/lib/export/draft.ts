// The Markdown draft export (FR-EX-01 (a), FR-EX-02, FR-EX-36), called by POST /api/documents/[id]/export/draft
// once `documentRoute` has decided: the origin, the session's row (the cookie's copy is never used for this
// request), the document, and `document.export.draft` from the role and the permission set as they are now.
// docs/plan/slice-21.md, section 2, has the order; in short:
//
//   1. the lock of the user, one export at a time (a 429);
//   2. the limit of NFR-SE-07, 10 in any hour (a 429), counted from here and given back where the request ends
//      before it has begun to be answered;
//   3. everything that can fail without a byte having been sent: the state is read, the rows of this document's
//      images are read, and the Markdown is written whole. Whatever fails here is a statement, and no file;
//   4. the response: a stream (./stream.ts) of the archive (./zip.ts), the Markdown first and then each image as the
//      store gives it, which ends, in whatever way, by releasing the lock.
//
// The images are the document's own: a row is looked for by its identifier AND this document, and the object that
// is read is the key that row holds, never one a block names. An identifier that names no row of this document is
// the same as none.
import { fault } from '../auth/route-answers.ts';
import { db } from '../db.ts';
import { refusal } from '../documents/access.ts';
import type { DocumentCall } from '../documents/route.ts';
import { faultOf } from '../fault.ts';
import { IMAGE_TYPES } from '../images/node.ts';
import { imageStorage } from '../images/store.ts';
import type { ImageStorage } from '../images/storage.ts';
import { logLimitReached, takeLimitReturnable } from '../rate-limit.ts';
import { settings } from '../settings.ts';
import { busyAnswer, limitedAnswer, unavailableAnswer } from './answers.ts';
import { takeExportLock } from './lock.ts';
import { renderMarkdown } from './markdown.ts';
import { contentDisposition, exportName } from './name.ts';
import { imageIdsOf, readDocument } from './read.ts';
import { guardedStream } from './stream.ts';
import { checkEntryName, zip, type ZipEntry } from './zip.ts';

/** The extension a stored image has in the archive, by its stored type. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  [IMAGE_TYPES.png]: 'png',
  [IMAGE_TYPES.jpeg]: 'jpg',
  [IMAGE_TYPES.gif]: 'gif',
  [IMAGE_TYPES.webp]: 'webp',
};

/** An image of the document that the archive holds: where it is in the archive, and where the store has it. */
interface Stored {
  id: string;
  path: string;
  objectKey: string;
  byteSize: number;
}

/** The images of this document that the blocks name and that can be put in the archive, in the order of the document. */
async function storedImages(documentId: string, ids: readonly string[]): Promise<Stored[]> {
  if (ids.length === 0) return [];
  const rows = await db().documentImage.findMany({
    where: { documentId, id: { in: [...ids] }, deletionClaimedAt: null },
    select: { id: true, objectKey: true, contentType: true, byteSize: true },
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const found = ids.flatMap((id) => {
    const row = byId.get(id);
    return row && EXTENSIONS[row.contentType] ? [{ id, row, extension: EXTENSIONS[row.contentType]! }] : [];
  });
  // Three digits at least, and as many as the number of the last needs.
  const width = Math.max(3, String(found.length).length);
  return found.map(({ id, row, extension }, at) => ({
    id,
    path: `images/${String(at + 1).padStart(width, '0')}.${extension}`,
    objectKey: row.objectKey,
    byteSize: row.byteSize,
  }));
}

/**
 * An image that could not be read from the store. What the server logs of the fault that ends a response is this
 * (the framework prints the error and its cause), and not what the store said: its answer names the bucket, the key
 * and the request (NFR-SE-19). `code` is the class of the store's fault, which `faultOf` prints beside the name of
 * this one, and nothing else.
 */
export class ImageNotRead extends Error {
  override name = 'ImageNotRead';
  readonly code: string;
  constructor(error: unknown) {
    super('an image could not be read from the store');
    const named = error instanceof Error ? error.name : '';
    this.code = /^[A-Za-z0-9]{1,16}$/.test(named) ? named : 'unknown';
  }
}

/** The bytes of one object as the store gives them, ended by the signal. */
async function* objectBytes(
  storage: ImageStorage,
  key: string,
  signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = (await storage.read(key, signal)).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } catch (error) {
    throw new ImageNotRead(error);
  } finally {
    // Stops the read where the archive stops, whatever stopped it; a stream that has failed has nothing to cancel.
    await reader?.cancel().catch(() => undefined);
  }
}

export async function draftExport({ document, session }: DocumentCall): Promise<Response> {
  const { exportIdleSeconds } = settings();
  const idleMs = exportIdleSeconds * 1000;
  // The lock lives as long as twice the idle period without a renewal, so that one whose holder has died is gone
  // within a minute, and one whose holder is working is never taken from it.
  const lockMs = 2 * idleMs;
  const lock = await takeExportLock(session.userId, lockMs);
  if (!lock) return busyAnswer();

  let counted: Awaited<ReturnType<typeof takeLimitReturnable>> | undefined;
  let streaming = false;
  try {
    counted = await takeLimitReturnable('EXPORTS_PER_USER', session.userId);
    if (!counted.ok) {
      await logLimitReached('EXPORTS_PER_USER', session.userId, counted.retryAfterSeconds, session.userId);
      return limitedAnswer(counted.retryAfterSeconds);
    }

    // The state and the title as they are now, of a document that is not deleted (or that waits for its day): a deletion since the request was
    // authorised ends the export as it ends every other access.
    const clock = new Date();
    const current = await db().document.findFirst({
      where: {
        id: document.id,
        // FR-AU-91, FR-ED-44 (d): and a document deleted before a clearing, while the notice period of that clearing
        // runs: "each of them may take a draft export of it until the day of the deletion". Not a moment after it.
        OR: [{ deletedAt: null }, { clearingAt: { gt: clock }, deletionClaimedAt: null }],
      },
      select: { title: true, yjsState: true },
    });
    if (!current) {
      await counted.giveBack();
      return await refusal({ outcome: 'not_found' }, session.userId, document.id);
    }
    const read = readDocument(current.yjsState);
    const images = await storedImages(document.id, imageIdsOf(read.body));
    const storage = imageStorage();
    if (images.length > 0 && !storage) {
      await counted.giveBack();
      return unavailableAnswer();
    }

    const now = new Date();
    const stem = exportName(current.title);
    // The names the archive will hold, asked of its own rule before the response begins: a name it refuses is a
    // statement now, and not a connection that is reset after a 200 (the review of pull request 59).
    checkEntryName(`${stem}.md`);
    for (const image of images) checkEntryName(image.path);
    let markdown: Buffer | null = Buffer.from(
      renderMarkdown({
        title: current.title,
        id: document.id,
        now,
        document: read,
        images: new Map(images.map((image) => [image.id, image.path])),
      }),
      'utf8',
    );
    /**
     * The entry of the Markdown, taken once: this function's own reference is dropped as it is handed on, so that the
     * buffer (up to 32 MiB) is held by the archive writer while its entry is written and by nothing once the images
     * begin, which may take as long as the client takes to read 100 MB (the review of pull request 59, S6).
     */
    const takeMarkdown = (): ZipEntry => {
      const body = markdown!;
      markdown = null;
      return { name: `${stem}.md`, body, size: body.byteLength };
    };

    const abort = new AbortController();
    async function* entries(): AsyncGenerator<ZipEntry> {
      yield takeMarkdown();
      for (const image of images) {
        // The size the row holds is the size the object must have: a store that sends more or less ends the export.
        yield {
          name: image.path,
          body: objectBytes(storage!, image.objectKey, abort.signal),
          size: image.byteSize,
        };
      }
    }

    // The lock is renewed as the response moves, at most four times in a period of it.
    let renewedAt = Date.now();
    const body = guardedStream(zip(entries(), now), {
      idleMs,
      abort,
      onEnd: async () => {
        await lock.release();
      },
      onProgress: () => {
        if (Date.now() - renewedAt < lockMs / 4) return;
        renewedAt = Date.now();
        lock.renew().catch((error: unknown) => {
          console.error(`export: the lock was not renewed (${faultOf(error)})`);
        });
      },
    });
    const response = new Response(body, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': contentDisposition(`${stem}.zip`),
        'Cache-Control': 'no-store',
        // A proxy that keeps a response to give it on would keep the whole archive, and would read it from the process
        // at the speed of the process and not of the client: the watchdog of ./stream.ts measures the proxy then.
        // nginx reads this header; docs/operations/deployment.md asks the same of any other proxy.
        'X-Accel-Buffering': 'no',
      },
    });
    // From here the stream owns the lock, and the export is counted.
    streaming = true;
    return response;
  } catch (error) {
    // A fault of ours before the first byte: the export the user was counted for did not begin.
    if (counted?.ok) await counted.giveBack().catch(() => undefined);
    return fault('export', error);
  } finally {
    // The stream releases the lock when it has ended; where there is none, it is released here.
    if (!streaming) await lock.release().catch(() => undefined);
  }
}
