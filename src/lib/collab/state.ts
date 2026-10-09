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

// The two limits of a document (the owner's decision of 9 October 2026 on the
// second review of pull request 20; its register row is pending). They are
// named here and nowhere else.
/** The most bytes the state of a document may be, encoded as it is stored (`encodeState`). */
export const MAX_STATE_BYTES = 5 * 1024 * 1024;
/**
 * The most elements one inside another, counted from an element that stands
 * directly in the document to the innermost, both included: a paragraph is 1,
 * and a paragraph in a quote is 2. The text of an element is no level.
 */
export const MAX_ELEMENT_DEPTH = 50;
/**
 * The longest message the socket takes: an update that is the whole of the
 * largest document, and the frame around it. Without it the socket library
 * takes 100 MiB (`ws` 8, as crossws 0.4.15 carries it: `maxPayload: 104857600`).
 */
export const MAX_MESSAGE_BYTES = MAX_STATE_BYTES + 64 * 1024;

/**
 * How deep the elements of a document are nested: 0 for an empty one. Counted
 * with a list of what is still to be looked at, and never by a function that
 * calls itself: the document that is measured is the one that may be ten
 * thousand deep. Every shared type that is not text is a level, whatever it
 * is and wherever in the document it hangs, the value of an attribute included.
 */
export function elementDepth(document: Y.Doc): number {
  let deepest = 0;
  type Shared = Y.Doc['share'] extends Map<string, infer Type> ? Type : never;
  const waiting: [Shared, number][] = [];
  for (const root of document.share.values()) waiting.push([root, 0]);
  for (let next = waiting.pop(); next; next = waiting.pop()) {
    const [type, depth] = next;
    if (depth > deepest) deepest = depth;
    const inner = (item: Y.Item | null) => {
      if (!item || item.deleted || !(item.content instanceof Y.ContentType)) return;
      const held = item.content.type as Shared;
      waiting.push([held, held instanceof Y.Text ? depth : depth + 1]);
    };
    for (let item = type._start; item; item = item.right) inner(item);
    for (const item of type._map.values()) inner(item);
  }
  return deepest;
}

/**
 * Whether an update a client sent would take the document past one of its two
 * limits: its state longer than `MAX_STATE_BYTES`, or an element deeper than
 * `MAX_ELEMENT_DEPTH`. Asked before the update is applied, of a copy that it
 * is applied to, because Yjs takes nothing back.
 *
 * A document that is past a limit already, stored before there was one, is
 * not closed to every change: an update is refused for the limit it takes the
 * document FURTHER past, so what is too deep can still be deleted.
 *
 * ponytail: the whole state is copied and encoded for every update, which is
 * the time of a store for each change received. A count of what the updates
 * since the last measure can have added, and the copy only near a limit, if a
 * large document ever shows in a profile.
 */
export function pastLimits(document: Y.Doc, update: Uint8Array): boolean {
  const after = new Y.Doc();
  try {
    const before = encodeState(document);
    applyState(after, before);
    applyState(after, update);
    const bytes = encodeState(after).byteLength;
    if (bytes > MAX_STATE_BYTES && bytes > before.byteLength) return true;
    const depth = elementDepth(after);
    return depth > MAX_ELEMENT_DEPTH && depth > elementDepth(document);
  } finally {
    after.destroy();
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
export function storeState(documentId: string, document: Y.Doc): Promise<boolean> {
  return store({ id: documentId, deletedAt: null }, document);
}

/**
 * Stores the state of a document that has just been deleted: the one store
 * whose condition is that the row exists, and not that it is live. FR-ED-41:
 * "Changes already merged into the document before the close remain", and a
 * change is merged when the server received it, up to 2 seconds before it is
 * stored (NFR-RE-07); FR-ED-36: a restore returns the document "as it was at
 * deletion". Called once, by the collaboration server, as it ends the document
 * for the notice of its deletion (`endDocument`), and by nothing else: at
 * every other time nothing is written to a deleted document.
 */
export function storeFinalState(documentId: string, document: Y.Doc): Promise<boolean> {
  return store({ id: documentId }, document);
}

// The state is encoded before anything is awaited: what is stored is the
// document as it was when the store was called.
async function store(where: { id: string; deletedAt?: null }, document: Y.Doc): Promise<boolean> {
  const state = encodeState(document);
  try {
    applyState(new Y.Doc(), state);
  } catch {
    throw new UnloadableState();
  }
  const { count } = await db().document.updateMany({
    where,
    // An edit: the one write beside the rename and the creation that moves
    // `updatedAt`, which the model no longer moves by itself (prisma/schema.prisma).
    data: { yjsState: state, updatedAt: new Date() },
  });
  return count === 1;
}
