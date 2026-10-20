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
import { trackReferences } from '../images/references.ts';

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
 * The most parts a document may wait with: the structs and the deleted ranges
 * that name content it was never sent (`store.pendingStructs`,
 * `store.pendingDs`), which Yjs keeps for ever, in the stored state too (the
 * owner's decision of 12 October 2026, on the third review of pull request 24).
 * At `PART_BYTES` each, 2,000 owe 400 KB of the 5 MB, which leaves the room
 * for the cheap answer of `limitsOf`; without a limit one update of some 18
 * KB, with thousands of structs, fills the room, and every later update of
 * every member is a copy (443 to 599 ms), across restarts. An honest client
 * leaves a few parts waiting for the moment of an update that arrives out of
 * order. Counted as `waitingParts` counts.
 */
export const MAX_WAITING_PARTS = 2_000;
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
 * The whole state is copied and encoded, which is the time of a store: 65 ms
 * for 4.9 MB of prose and 250 ms for 4.9 MB of the smallest pieces (measured
 * 12 October 2026). The server asks `limitsOf` instead, which comes here only
 * when it must.
 */
export function pastLimits(document: Y.Doc, update: Uint8Array): boolean {
  return measured(document, update).past !== null;
}

/** Which of the limits: the bytes of the state, the depth of the elements, or the parts that wait. */
export type Limit = 'size' | 'depth' | 'waiting';

function measured(document: Y.Doc, update: Uint8Array) {
  const after = new Y.Doc();
  try {
    const before = encodeState(document);
    applyState(after, before);
    applyState(after, update);
    const bytes = encodeState(after).byteLength;
    const depth = elementDepth(after);
    // The copy waits, after the update, with what the document will wait with.
    const owed = owedBy(after);
    let past: Limit | null = null;
    if (bytes > MAX_STATE_BYTES && bytes > before.byteLength) past = 'size';
    else if (depth > MAX_ELEMENT_DEPTH && depth > elementDepth(document)) past = 'depth';
    // A document that waits with more already, from before the limit, is refused only what adds to it.
    else if (owed.parts > MAX_WAITING_PARTS && owed.parts > waitingParts(document)) past = 'waiting';
    return { past, before: before.byteLength, depth, owedLevels: owed.levels, waiting: owed.parts };
  } finally {
    after.destroy();
  }
}

// What one struct or one deleted range of an update can add to the encoded
// state beyond its own bytes (Yjs 13.6.33, update encoding 1; an identifier is
// a client and a clock, up to 8 bytes each, because `assertUpdate` lets
// through no number past 2^53):
// - a struct cuts at most two structs that are there in two, at its origin
//   and at its right origin (`Item.getMissing`), and a range at most two, at
//   its ends (`readAndApplyDeleteSet`). The second half of a cut is a struct
//   of its own: 1 byte, two identifiers, the length of its content (5), 2
//   where the cut fell inside a surrogate pair (`ContentString.splice`), and 1
//   where the count of structs gains a byte: 41, twice;
// - a struct of which the document holds the beginning is written with an
//   origin it did not carry (`Item.integrate`, `offset`): 16;
// - a struct that waits for another is kept as it came, behind a gap that is
//   written as a struct (`Skip`, in `mergeUpdates`): 9;
// - a struct deletes without a range of the update: itself, under a parent
//   that is deleted, or the entry of a map that it replaces. The range is
//   written into the state, with a client where it is the client's first: 27;
// - a struct is deleted later, without a range of any update: Yjs itself
//   deletes the marks of formatting that no longer change anything, in every
//   document that takes another client's change (`cleanupYTextAfterTransaction`),
//   and one small deletion can leave any number of them so. A struct is
//   deleted once, so it is counted when it arrives: 27 again (`DELETED_BYTES`).
// 161 for a struct and 108 for a range; a round number above both.
const PART_BYTES = 200;
const DELETED_BYTES = 27;
// And once for an update: the bytes the two counts of clients can gain.
const UPDATE_BYTES = 16;
const NO_STATE = new Uint8Array([0]);

/**
 * The most an update can add to a document that waits for nothing
 * (`store.pendingStructs`, `store.pendingDs`): `bytes` to its encoded state
 * and `levels` to the depth of its elements. In the bytes of each struct is
 * what its own deletion by Yjs can cost later; for the marks of formatting
 * that a document held before anything was counted, `limitsOf` holds back.
 *
 * The bytes are not the length of the update as it came. What Yjs stores is
 * what it read, written again, and that can be longer: `1e20` in an embed is
 * written back as 21 digits, and an integer past 31 bits as 8 bytes. So the
 * update is written again first (`diffUpdate` against no state reads every
 * struct and writes it with the encoder the state is written with), and to
 * its length is added what each of its parts can cost the structs that are
 * there. The levels are its shared types that are not text, which is what
 * `elementDepth` counts: nothing but a new type adds a level, and each adds
 * at most one. tests/unit/collab-limits.test.ts holds both to what Yjs does.
 */
export function growthBound(update: Uint8Array): { bytes: number; levels: number } {
  const { bytes, levels } = boundOf(update);
  return { bytes, levels };
}

/** `growthBound`, and the clients whose structs the update holds. */
function boundOf(update: Uint8Array) {
  const { parts, held, levels, clients } = partsOf(Y.decodeUpdate(update));
  const bytes = Y.diffUpdate(update, NO_STATE).byteLength + parts * PART_BYTES + UPDATE_BYTES;
  return { bytes, levels, clients, parts: held };
}

/**
 * The structs and deleted ranges of an update that was read (`parts`, with the
 * `Skip` that Yjs writes in the gap between two that wait, which cost bytes;
 * `held`, without it, which are what `MAX_WAITING_PARTS` counts), the shared
 * types among them that are not text, and whose the structs are.
 */
function partsOf({ structs, ds }: ReturnType<typeof Y.decodeUpdate>) {
  let parts = structs.length;
  let held = structs.filter((struct) => !(struct instanceof Y.Skip)).length;
  for (const ranges of ds.clients.values()) {
    parts += ranges.length;
    held += ranges.length;
  }
  let levels = 0;
  const clients = new Set<number>();
  for (const struct of structs) {
    clients.add(struct.id.client);
    if (!(struct instanceof Y.Item) || !(struct.content instanceof Y.ContentType)) continue;
    if (!(struct.content.type instanceof Y.Text)) levels += 1;
  }
  return { parts, held, levels, clients };
}

/**
 * What a document can still gain from what it waits with, the structs and the
 * deleted ranges it was sent before the structs they name
 * (`store.pendingStructs`, `store.pendingDs`, which Yjs keeps as updates of
 * encoding 2): nothing while they wait, and when they are taken in what each
 * part can cost beyond its own bytes (`PART_BYTES`) and a level for each
 * shared type that is not text. Their own bytes are in the state already: Yjs
 * writes what waits into the state it encodes.
 */
function owedBy(document: Y.Doc): { bytes: number; levels: number; parts: number } {
  let bytes = 0;
  let levels = 0;
  let parts = 0;
  for (const waiting of [document.store.pendingStructs?.update, document.store.pendingDs]) {
    if (!waiting) continue;
    const read = partsOf(Y.decodeUpdateV2(waiting));
    bytes += read.parts * PART_BYTES + UPDATE_BYTES;
    levels += read.levels;
    parts += read.held;
  }
  return { bytes, levels, parts };
}

/** How many parts a document waits with: the number `MAX_WAITING_PARTS` bounds. It reads what waits, and the document not at all. */
export function waitingParts(document: Y.Doc): number {
  return owedBy(document).parts;
}

/** How many marks of formatting a document holds that are not deleted: what Yjs may yet delete by itself. */
function liveFormats(document: Y.Doc): number {
  let found = 0;
  for (const structs of document.store.clients.values()) {
    for (const struct of structs) {
      if (struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentFormat)
        found += 1;
    }
  }
  return found;
}

/**
 * `pastLimits` for one document in memory, asked of every update before it is
 * applied, without the copy where the answer is known without it: the limit
 * the update would take the document past, or null. It keeps a
 * number of bytes and a depth that the document is not past, adds to them
 * what each update it lets through can add (`growthBound`), and measures
 * again, by `pastLimits`, only when the sum would pass a limit, or the first
 * time. At a measure the bytes are those of the document and 27 for each mark
 * of formatting in it, which Yjs may yet delete by itself (`PART_BYTES`).
 *
 * A DOCUMENT THAT WAITS, for a struct it was not sent, is not measured for
 * every update: one small update that names a struct no one ever sends
 * leaves a document waiting for good, in its stored state too, and each
 * member's every key would then cost the copy. What waits is counted
 * instead (`owedBy`). Its bytes are in the state already, and what its parts
 * can cost when they are taken in is added to the bytes at every measure, as
 * it was when the update that brought them was let through without one. Its
 * levels are kept apart, since a document 20 deep that waits with 40 levels
 * is inside the limit until they are taken in: they are added for an update
 * that holds a struct of a client the document waits for, the only kind after
 * which Yjs tries what waits again, and for no other; once added they stay
 * in the depth until the next measure. Both count too much and never too
 * little: a part that waits is counted in full again at each measure, and a
 * level that was added is counted whether or not what waited was taken in.
 *
 * WHAT THIS RESTS ON is a reading of Yjs 13.6.33 and not a promise of the
 * library's: that nothing but the cases counted in `PART_BYTES` makes the
 * state of a document grow. tests/unit/collab-limits.test.ts holds each case
 * to the library and a run of three members to the whole; an upgrade of Yjs
 * is read against them. Where the reading is wrong the limit of 5 MB is
 * passed by what it missed, until the next measure, and never the limit of
 * the socket. The depth rests on one reading more: when Yjs tries again what
 * a document waits with (`readUpdateV2`).
 *
 * It holds where every change to the document is asked of it first and is
 * applied, or not, before the next is asked: the collaboration server's
 * `beforeSync`, which awaits nothing between the answer and the library's
 * applying the update. A change it let through that was then not applied
 * leaves the numbers too high, which costs a measure and nothing else.
 *
 * What it does not bound: a member who fills a document to within a few bytes
 * of the limit makes every update a measure again, and so does one who leaves
 * it waiting with so many parts that 200 bytes for each fill the room (26,000
 * for an empty document), or with more levels than there is room for and
 * then sends structs of the client it waits for. The collaboration server
 * bounds that by its limit of messages for each user, which it takes before
 * it asks here (the owner's decision of 12 October 2026: 600 in a minute).
 */
export function limitsOf(document: Y.Doc): (update: Uint8Array) => Limit | null {
  let bytes = Infinity;
  let depth = Infinity;
  // The levels of what waited at the last measure (`owedBy`), which are not in
  // `depth` until an update can have them taken in.
  let owedLevels = 0;
  // The parts the document waits with, at most: those counted at the last
  // measure, and every part of each update let through since, whether it
  // waits or is taken in (`MAX_WAITING_PARTS`). Never less than the document
  // waits with; it comes down at the next measure, which is one for about
  // every 2,000 parts of updates, and is as small as a copy of a small document.
  let waiting = Infinity;
  return (update) => {
    // An update longer than the room that is left is measured without being read twice.
    const growth = update.byteLength <= MAX_STATE_BYTES - bytes ? boundOf(update) : null;
    if (growth) {
      // Yjs tries what waits again only where the update holds a struct of a
      // client it waits for (`readUpdateV2`, `pending.missing`): no other
      // update can add the levels of what waits.
      const missing = document.store.pendingStructs?.missing;
      const wakes = missing !== undefined && [...growth.clients].some((client) => missing.has(client));
      const levels = growth.levels + (wakes ? owedLevels : 0);
      if (
        bytes + growth.bytes <= MAX_STATE_BYTES &&
        depth + levels <= MAX_ELEMENT_DEPTH &&
        waiting + growth.parts <= MAX_WAITING_PARTS
      ) {
        bytes += growth.bytes;
        waiting += growth.parts;
        // The levels of the update are counted now, whether it is taken in or left waiting.
        depth += levels;
        if (wakes) owedLevels = 0;
        return null;
      }
    }
    const exact = measured(document, update);
    const owed = owedBy(document);
    // The bytes are those of this document and not of the copy, and with them
    // what the marks of formatting that are in it can still cost when Yjs
    // deletes them, and what it waits with can cost when that is taken in,
    // by this update or a later one: those arrived before this measure, and
    // were counted by none.
    const held = exact.before + liveFormats(document) * DELETED_BYTES + owed.bytes;
    if (exact.past) {
      // Refused, and so not applied: the document is as it was measured.
      bytes = held;
      owedLevels = owed.levels;
      waiting = owed.parts;
      return exact.past;
    }
    bytes = held + (growth ?? boundOf(update)).bytes;
    depth = exact.depth;
    owedLevels = exact.owedLevels;
    waiting = exact.waiting;
    return null;
  };
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
  // NFR-SE-18: the images the stored document holds, and the clock of those it no longer does
  // (src/lib/images/references.ts). After the state is written, and never a reason for the store to fail.
  if (count === 1) await trackReferences(where.id, document);
  return count === 1;
}
