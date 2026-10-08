// The stored state of a document, `Document.yjsState` (NFR-RE-07; Data
// models, "`yjsState` as `Bytes`"): its encoding, and the two queries that
// read and write it. Nothing else in the application names the column.
//
// PROVISIONAL: the Docs say only "the Yjs CRDT document binary". What is
// stored here is the Yjs update encoding of the whole document, version 1
// (`Y.encodeStateAsUpdate`), which is what register N37 recommends for the
// bytes Istorico hashes and has not decided. The choice is reported to the
// owner; when the Docs state an encoding, the two functions below change and
// nothing else does.
import * as Y from 'yjs';
import { db } from '../db.ts';

export function encodeState(document: Y.Doc): Uint8Array<ArrayBuffer> {
  return Y.encodeStateAsUpdate(document) as Uint8Array<ArrayBuffer>;
}

export function applyState(document: Y.Doc, state: Uint8Array): void {
  Y.applyUpdate(document, state);
}

/**
 * The stored state of a document, null where it has never been stored. It
 * rejects where there is no such document. The caller has authorised the
 * reading (src/lib/documents/access.ts).
 */
export async function loadState(documentId: string): Promise<Uint8Array | null> {
  const { yjsState } = await db().document.findUniqueOrThrow({
    where: { id: documentId },
    select: { yjsState: true },
  });
  return yjsState;
}

/**
 * Stores the state of a document; false where nothing was stored, because the
 * document is deleted or gone (FR-ED-36: nothing is written to a deleted
 * document).
 */
export async function storeState(documentId: string, document: Y.Doc): Promise<boolean> {
  const { count } = await db().document.updateMany({
    where: { id: documentId, deletedAt: null },
    data: { yjsState: encodeState(document) },
  });
  return count === 1;
}
