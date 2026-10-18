// Presence (FR-ED-17) and the limit of connections that it is coupled to
// (NFR-PE-05, FR-ED-18): the two numbers by name, and what a connection may say
// of itself in awareness.
//
// Nothing here reads a setting, the database, or anything of Next.js or of
// Node.js: it loads in a browser as it is, and the collaboration server and
// the editor both import it.

/**
 * NFR-PE-05: the most connections one document holds, counted for each
 * connection whatever the role. The limit of the α line.
 *
 * ONE NAMED SETTING, WITH THE ONE BELOW. The owner wants to revisit the two
 * together (register Q31): raising this is one edit here and one in the fixed
 * statement of FR-ED-18, which says "ten" (`AT_CAPACITY` of the editor), and
 * a test holds the statement and this number together. It is not read from the
 * environment for that reason: a limit that an operator could change would
 * make the statement false.
 */
export const CONNECTIONS_PER_DOCUMENT = 10;

/**
 * FR-ED-17: the number of colours in the collaborator colour set of
 * `@ekdotico/domico` (`collaboratorSlots`; 10 in 0.29.0). Written here and not
 * imported, so that the palettes of the package do not travel to the browser
 * for a number; `tests/unit/presence.test.ts` fails when the package's set is
 * not this long. The slots are `1` to this number, and a slot is the three
 * tokens `--collab-N`, `--collab-N-ink` and `--collab-N-soft`.
 */
export const COLLABORATOR_COLOURS = 10;

// FR-ED-17: "the connection limit is not raised above the number of colours in
// the set". Where it is, nothing loads: two connections would share a colour.
if (CONNECTIONS_PER_DOCUMENT > COLLABORATOR_COLOURS) {
  throw new Error('CONNECTIONS_PER_DOCUMENT must be no more than COLLABORATOR_COLOURS (FR-ED-17).');
}

/** Whether this is a slot of the colour set: a whole number from 1 to `COLLABORATOR_COLOURS`. */
export function isSlot(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= COLLABORATOR_COLOURS;
}

/**
 * The longest message of the awareness type that a connection may send. A
 * state that a client has cause to send is a cursor of two relative positions
 * and holds under 400 bytes; a longer one is not read, and closes the
 * connection (`beforeHandleMessage` of src/collab/server.ts), since the
 * library decodes it, and re-encodes it for every peer, before anything else
 * could look at it.
 */
export const AWARENESS_MAX_BYTES = 4096;

// The type of a message that carries awareness (@hocuspocus/server, `MessageType`).
const AWARENESS_MESSAGE = 1;

/** One number of the protocol (lib0's variable-length integer): its value and the offset after it, or null where the bytes end. */
function varUint(bytes: Uint8Array, at: number): [value: number, next: number] | null {
  let value = 0;
  for (let shift = 0; shift < 35; shift += 7) {
    const byte = bytes[at++];
    if (byte === undefined) return null;
    value += (byte & 127) * 2 ** shift;
    if (byte < 128) return [value, at];
  }
  return null;
}

/**
 * Whether this message, as a client sent it (the name of the document, the
 * type, the rest), is awareness longer than `AWARENESS_MAX_BYTES`. Read from
 * the first two numbers alone, so that the check costs the same for a message
 * of 5 MB as for one of 5 bytes.
 */
export function awarenessTooLong(message: Uint8Array): boolean {
  const name = varUint(message, 0);
  if (!name) return false;
  const type = varUint(message, name[1] + name[0]);
  return type !== null && type[0] === AWARENESS_MESSAGE && message.length - type[1] > AWARENESS_MAX_BYTES;
}

/** Whether this message, as a client sent it, is of the awareness type (and not whether it reads to its end). */
export function isAwareness(message: Uint8Array): boolean {
  const name = varUint(message, 0);
  const type = name && varUint(message, name[1] + name[0]);
  return !!type && type[0] === AWARENESS_MESSAGE;
}

/**
 * The client identifiers an awareness message speaks for, in the order it
 * writes them (y-protocols `encodeAwarenessUpdate`: a count, then for each a
 * client, a clock, and the state as text), or null where this is not
 * awareness or does not read to its end.
 *
 * WHY THE SERVER READS THEM ITSELF. The library decodes an update into a
 * scratch `Awareness` before it calls `beforeHandleAwareness`, and the
 * scratch holds a state of its own (y-protocols sets `{}` for its own random
 * identifier when it is made), which is the first entry of the map the hook is
 * given. Taking the first identifier of the map for the client's would take
 * that one. The identifiers the message itself names are the client's.
 */
export function awarenessClients(message: Uint8Array): number[] | null {
  const name = varUint(message, 0);
  if (!name) return null;
  const type = varUint(message, name[1] + name[0]);
  if (!type || type[0] !== AWARENESS_MESSAGE) return null;
  const length = varUint(message, type[1]);
  if (!length) return null;
  const end = length[1] + length[0];
  const count = varUint(message, length[1]);
  if (!count || end > message.length) return null;
  const clients: number[] = [];
  let at = count[1];
  for (let each = 0; each < count[0]; each++) {
    const client = varUint(message, at);
    const clock = client && varUint(message, client[1]);
    const text = clock && varUint(message, clock[1]);
    if (!client || !text || text[1] + text[0] > end) return null;
    clients.push(client[0]);
    at = text[1] + text[0];
  }
  return clients;
}

/**
 * FR-ED-17: "the name the user gave when the account was created, which the
 * user can change in the account settings (FR-AU-90), or the local part of the
 * account's email address where none is set".
 */
export function displayNameOf({ name, email }: { name: string | null; email: string | null }): string {
  const named = name?.trim();
  if (named) return named;
  if (!email) return '';
  const at = email.lastIndexOf('@');
  return at < 0 ? email : email.slice(0, at);
}

/** What every peer is told of a connection: who, and in which colour. Both are the server's. */
export interface Presence {
  name: string;
  slot: number;
}

/** One end of a cursor, as Yjs writes a relative position (`relativePositionToJSON`), and no more. */
export interface RelativePosition {
  type?: { client: number; clock: number };
  tname?: string;
  item?: { client: number; clock: number };
  assoc?: number;
}
export interface Cursor {
  anchor: RelativePosition;
  head: RelativePosition;
}

// The longest name of a type a relative position may carry: the field's own name.
const TNAME_MOST = 256;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** An identifier of Yjs, `{ client, clock }`, or null. */
function readId(value: unknown): { client: number; clock: number } | null {
  if (!isObject(value) || Object.keys(value).length !== 2) return null;
  const { client, clock } = value;
  return isCount(client) && isCount(clock) ? { client, clock } : null;
}

/**
 * One relative position, or null for anything Yjs would not write: an unknown
 * field, an identifier that is not two whole numbers, a name of a type that is
 * not text or is long, an association that is not -1, 0 or 1. Rebuilt field by
 * field, so nothing else a value carries goes further.
 */
function readPosition(value: unknown): RelativePosition | null {
  if (!isObject(value)) return null;
  const known = ['type', 'tname', 'item', 'assoc'];
  if (Object.keys(value).some((key) => !known.includes(key))) return null;
  const read: RelativePosition = {};
  for (const key of ['type', 'item'] as const) {
    if (value[key] === undefined || value[key] === null) continue;
    const id = readId(value[key]);
    if (!id) return null;
    read[key] = id;
  }
  const { tname, assoc } = value;
  if (tname !== undefined && tname !== null) {
    if (typeof tname !== 'string' || tname.length > TNAME_MOST) return null;
    read.tname = tname;
  }
  if (assoc !== undefined && assoc !== null) {
    if (assoc !== -1 && assoc !== 0 && assoc !== 1) return null;
    read.assoc = assoc;
  }
  return read;
}

/**
 * The cursor of an awareness state, or null. A cursor that is not exactly two
 * relative positions of the form Yjs writes would make
 * `createRelativePositionFromJSON` throw in the editor of every peer
 * (@tiptap/y-tiptap 3.0.9, `createDecorations`), so it never goes on.
 */
export function readCursor(value: unknown): Cursor | null {
  if (!isObject(value) || Object.keys(value).length !== 2) return null;
  const anchor = readPosition(value.anchor);
  const head = readPosition(value.head);
  return anchor && head ? { anchor, head } : null;
}

/**
 * What the server lets a connection say of itself in an awareness update
 * (`beforeHandleAwareness` of src/collab/server.ts), changed in place.
 *
 * - A connection speaks for one client identifier: one it has spoken with
 *   (`own`), or, where it has none yet, the first in the update that no other
 *   connection of the document holds (`others`). Every other identifier is
 *   dropped, so that a client cannot speak for another, nor claim another's
 *   before that one has spoken.
 * - The state that goes on is rebuilt: the name and the slot are the
 *   connection's own (`who`), whatever the client sent, and its cursor is kept
 *   only where `readCursor` reads it. Nothing else of what it sent goes on.
 */
export function pinAwareness(
  states: Map<number, Record<string, unknown>>,
  { own, others, who }: { own: ReadonlySet<number>; others: ReadonlySet<number>; who: Presence },
): void {
  let claimed: number | undefined;
  for (const [id, state] of [...states]) {
    const mine = own.has(id) || (own.size === 0 && claimed === undefined && !others.has(id));
    if (!mine) {
      states.delete(id);
      continue;
    }
    claimed = id;
    const cursor = readCursor(isObject(state) ? state.cursor : undefined);
    states.set(id, { user: { name: who.name, slot: who.slot }, ...(cursor ? { cursor } : {}) });
  }
}
