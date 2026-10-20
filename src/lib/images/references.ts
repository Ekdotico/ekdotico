// Which images a document holds, read when the collaboration server stores it,
// and the clock that follows (NFR-SE-18: "an image that no longer appears in
// its document is deleted from storage within 30 days"; the owner's answer to
// Q14: "an image that reappears before its deletion is kept").
//
// The row of an image has `unreferencedAt`: set when the image is in no block
// of its document, and null while it is in one. The deletion (./deletion.ts)
// reads it and nothing else. It is kept here, from the document the server
// already holds, and not by reading every document's state in a timer, which
// would decode up to 5 MB for each document every hour.
import * as Y from 'yjs';
import { db } from '../db.ts';
import { faultOf } from '../fault.ts';
import { FRAGMENT_NAME } from '../collab/protocol.ts';
import { IMAGE_ID } from './node.ts';

/**
 * The identifiers the image blocks of a document hold, wherever the blocks
 * stand (in a list, a quote, a cell of a table). Only a value of the form the
 * application issues is an identifier: whatever else an attribute holds, it
 * names no image. Counted with a list of what is still to be looked at, and
 * never by a function that calls itself.
 */
export function imageIdsIn(document: Y.Doc): Set<string> {
  const found = new Set<string>();
  const left: (Y.XmlFragment | Y.XmlElement | Y.XmlText | Y.XmlHook)[] = [
    document.getXmlFragment(FRAGMENT_NAME),
  ];
  for (let node = left.pop(); node !== undefined; node = left.pop()) {
    if (node instanceof Y.XmlElement && node.nodeName === 'image') {
      const id: unknown = node.getAttribute('id');
      if (typeof id === 'string' && IMAGE_ID.test(id)) found.add(id);
    }
    if (node instanceof Y.XmlFragment) for (const child of node.toArray()) left.push(child);
  }
  return found;
}

/**
 * Writes what the document now holds to the rows of its images: the image that
 * is in a block and has a time is cleared of it, and the image that is in no
 * block and has none is given one. A row whose deletion has been claimed is
 * left alone: from the claim on it is deleted, and an image that comes back
 * after that is not there to show (the owner's answer to Q14).
 *
 * Only the rows that change are written, so a store that changed no image
 * writes nothing. Returns how many rows it changed.
 */
export async function recordReferences(
  documentId: string,
  referenced: ReadonlySet<string>,
  now: Date = new Date(),
): Promise<number> {
  const ids = [...referenced];
  const placed = await db().documentImage.updateMany({
    where: { documentId, id: { in: ids }, unreferencedAt: { not: null }, deletionClaimedAt: null },
    data: { unreferencedAt: null },
  });
  const left = await db().documentImage.updateMany({
    where: { documentId, id: { notIn: ids }, unreferencedAt: null, deletionClaimedAt: null },
    data: { unreferencedAt: now },
  });
  return placed.count + left.count;
}

// What each document held at its last store in this process: the sorted
// identifiers, joined. A process that has stored nothing yet has no entry, so
// its first store writes whatever differs, and the set a restart lost is found
// again. An entry is made only once the write has succeeded.
const LAST = new Map<string, string>();
// The most documents it remembers: the oldest entry is forgotten past it, and a document without one is only written
// once more (the review of pull request 52). One instance of the collaboration server only
// (docs/operations/deployment.md): a second would hold entries the first has made stale.
const LAST_MOST = 1000;

/**
 * Called by the store of a document (src/lib/collab/state.ts) after the state is
 * written, with the identifiers `imageIdsIn` read from the state that was
 * written, and not from the document as it is by then. It rejects with
 * nothing: a fault is one line, with the document's identifier and the class of
 * the fault and nothing else (NFR-SE-19), and the next store tries again, since
 * no entry was made. A reference that is not written is not lost: an image is
 * only ever deleted after 30 days with no store that found it in a block.
 */
export async function trackReferences(documentId: string, referenced: ReadonlySet<string>): Promise<void> {
  try {
    const key = [...referenced].sort().join(',');
    if (LAST.get(documentId) === key) return;
    await recordReferences(documentId, referenced);
    LAST.delete(documentId);
    LAST.set(documentId, key);
    if (LAST.size > LAST_MOST) LAST.delete(LAST.keys().next().value!);
  } catch (error) {
    console.error(`image references: document ${documentId} not recorded (${faultOf(error)})`);
  }
}

/** Forgets what the process knows of each document; for the tests, which restart it. */
export function forgetReferences(): void {
  LAST.clear();
}
