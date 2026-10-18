// The places of a document's connections (NFR-PE-05): how many there are, and
// which slot of the collaborator colour set (FR-ED-17) each holds. One module,
// with no input or output, so that the release that runs a second instance of
// the collaboration server (register Q42; NFR-SC-04, withdrawn from α by D168)
// replaces the count with one in Valkey and changes nothing that calls it.
//
// THE COUNT IS KEPT IN THE MEMORY OF THE ONE INSTANCE (register D174, which
// corrects D165): with two instances each would admit ten.
//
// Nothing here is of Next.js.
import { COLLABORATOR_COLOURS, CONNECTIONS_PER_DOCUMENT } from './presence.ts';

/** One connection's place on one document, and the name its cursor carries. */
export interface Place {
  readonly documentId: string;
  /** FR-ED-17: a slot of the colour set, `1` to `COLLABORATOR_COLOURS`. */
  readonly slot: number;
  /** FR-ED-17: set by the server from the account, never by the client. */
  name: string;
}

/**
 * How long a place that has no connection yet counts. A place is taken when
 * the handshake of a document is authorised and is made a connection once the
 * document is loaded, and each of those reads is bounded at 5 seconds by the
 * database client (src/lib/db.ts), so a place older than this belongs to a
 * handshake that ended without a connection and without a word (a socket that
 * closed in the middle, a load that failed where nothing could release it). It
 * does not count then, which is a ceiling and not a rule: the place is free
 * again at most this long after it was lost.
 */
export const PENDING_MS = 15_000;

interface Entry {
  place: Place;
  /** The time a pending place stops counting, or null once its connection exists. */
  until: number | null;
}

export class Places {
  private readonly byDocument = new Map<string, Map<number, Entry>>();

  private readonly limit: number;
  private readonly now: () => number;

  constructor(limit = CONNECTIONS_PER_DOCUMENT, now: () => number = Date.now) {
    // FR-ED-17: a place is a colour, and two connections must not share one.
    if (!Number.isInteger(limit) || limit < 1 || limit > COLLABORATOR_COLOURS) {
      throw new Error('places: the limit must be a whole number from 1 to the number of colours (FR-ED-17).');
    }
    this.limit = limit;
    this.now = now;
  }

  /** The places of a document that count now: those with a connection, and those still waiting for one. */
  private live(documentId: string): Map<number, Entry> {
    let slots = this.byDocument.get(documentId);
    if (!slots) this.byDocument.set(documentId, (slots = new Map()));
    const now = this.now();
    for (const [slot, entry] of slots) if (entry.until !== null && entry.until <= now) slots.delete(slot);
    return slots;
  }

  /**
   * Takes a place on the document, or answers null where it holds the limit.
   * ONE SYNCHRONOUS STEP, from the count to the taking: the handshakes of one
   * document run side by side, each after its own awaits, and none of them can
   * count between another's count and that one's taking. The slot is the
   * lowest that is free (FR-ED-17; the design package: "assign from the
   * front, and hand a freed slot to the next person to arrive").
   */
  reserve(documentId: string): Place | null {
    const slots = this.live(documentId);
    if (slots.size >= this.limit) return null;
    let slot = 1;
    while (slots.has(slot)) slot += 1;
    const place: Place = { documentId, slot, name: '' };
    slots.set(slot, { place, until: this.now() + PENDING_MS });
    return place;
  }

  /**
   * Its connection exists: the place stays until `release`. False where the
   * place had expired, and its slot was taken meanwhile: the connection has
   * no place, and the caller closes it.
   */
  hold(place: Place): boolean {
    const slots = this.live(place.documentId);
    const entry = slots.get(place.slot);
    if (entry?.place === place) {
      entry.until = null;
      return true;
    }
    if (entry || slots.size >= this.limit) return false;
    slots.set(place.slot, { place, until: null });
    return true;
  }

  /**
   * Gives the place back. Where it was given back already, nothing: the slot
   * may be someone else's by now, and the call from the library that comes
   * late (`onDisconnect`) must not take it away.
   */
  release(place: Place): void {
    const slots = this.byDocument.get(place.documentId);
    if (slots?.get(place.slot)?.place === place) slots.delete(place.slot);
    if (slots?.size === 0) this.byDocument.delete(place.documentId);
  }

  /**
   * Drops every place of the document that has no connection yet. A load that
   * failed fails every handshake that waited for it, and the library tells of
   * it once; a handshake that is still to come back is given a place again
   * by `hold` where there is room, or is closed as a connection with none.
   */
  dropPending(documentId: string): void {
    const slots = this.byDocument.get(documentId);
    if (!slots) return;
    for (const [slot, entry] of slots) if (entry.until !== null) slots.delete(slot);
    if (slots.size === 0) this.byDocument.delete(documentId);
  }

  /** How many places the document holds now, for the tests and the statement of a refusal. */
  count(documentId: string): number {
    if (!this.byDocument.has(documentId)) return 0;
    const { size } = this.live(documentId);
    if (size === 0) this.byDocument.delete(documentId);
    return size;
  }
}
