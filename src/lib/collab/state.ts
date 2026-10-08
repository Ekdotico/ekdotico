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

/** A state that would be stored and could not be loaded again. No message: the class says it all (NFR-SE-19). */
export class UnloadableState extends Error {
  name = 'UnloadableState';
}

/**
 * Throws where an update a client sent is not one this server applies: bytes
 * that are no Yjs update, or an update that counts past the integers
 * JavaScript holds exactly.
 *
 * The second is not pedantry. Yjs 13.6.33 applies an update whose lengths add
 * up past 2^56 (three structs of 2^55 are 32 bytes), encodes the state
 * with a number it then refuses to read ("Integer out of Range"), and the
 * document could never be loaded again by anyone. And the library hands an
 * update straight to y-protocols, which applies as much of it as it can read,
 * prints whatever Yjs threw, and lets the server acknowledge it.
 *
 * ponytail: every update is decoded twice, here and when it is applied. One
 * decode, by applying to the document inside a transaction that can be undone,
 * if this ever shows in a profile.
 */
export function assertUpdate(update: Uint8Array): void {
  const { structs, ds } = Y.decodeUpdate(update);
  const exact = (client: number, clock: number, length: number) =>
    client <= Number.MAX_SAFE_INTEGER && clock + length <= Number.MAX_SAFE_INTEGER;
  for (const { id, length } of structs) {
    if (!exact(id.client, id.clock, length)) throw new RangeError();
  }
  for (const [client, ranges] of ds.clients) {
    for (const { clock, len } of ranges) if (!exact(client, clock, len)) throw new RangeError();
  }
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
 *
 * It rejects with `UnloadableState`, and writes nothing, where what it would
 * store cannot be loaded: the state stored before stays, which can. This is
 * the rule itself and not a list of the ways to break it; `assertUpdate` keeps
 * the one way that is known out of the document in the first place.
 *
 * ponytail: the whole state is decoded once for each store. A check of the
 * updates since the last store, if a large document ever shows in a profile.
 */
export async function storeState(documentId: string, document: Y.Doc): Promise<boolean> {
  const state = encodeState(document);
  try {
    applyState(new Y.Doc(), state);
  } catch {
    throw new UnloadableState();
  }
  const { count } = await db().document.updateMany({
    where: { id: documentId, deletedAt: null },
    data: { yjsState: state },
  });
  return count === 1;
}
