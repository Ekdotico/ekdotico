// Presence, the limit of ten connections, and the 60-second re-check (FR-ED-17,
// FR-ED-18, FR-ED-41, FR-ED-40 (b); NFR-PE-05; NFR-SE-03 (a), (e); register
// D174), against the collaboration server in this process and the real
// provider of the editor over Node's own WebSocket, with the real database and
// Valkey. One server for each test, and none counts in Valkey (D174).
//
// Roles are real rows of `DocumentCollaborator`, as an accepted invitation
// writes them (slice 13). The re-check is run by hand (`recheck`) with the
// timer's period made long, so that a test decides when it runs; one test
// lets the timer run it.
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { cookiesOf, createAccount, DAY, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('presence');
const { auth, db, valkey, settings } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { COLLAB_PATH, peopleNotice, readPeopleNotice, REFUSAL, readRoleNotice } =
  await import('../../src/lib/collab/protocol.ts');
const { CONNECTIONS_PER_DOCUMENT } = await import('../../src/lib/collab/presence.ts');
const { createCollabServer } = await import('../../src/collab/server.ts');

// ── Frames ──────────────────────────────────────────────────────────────────

/** One frame of the connection: the document it is addressed to, its type, and the rest. */
function frame(bytes: Uint8Array) {
  let at = 0;
  const number = () => {
    for (let value = 0, shift = 0; ; shift += 7) {
      const byte = bytes[at++]!;
      value |= (byte & 127) << shift;
      if (byte < 128) return value;
    }
  };
  const length = number();
  const name = new TextDecoder().decode(bytes.subarray(at, at + length));
  at += length;
  return { name, type: number(), rest: Buffer.from(bytes.subarray(at)).toString('hex') };
}
// The types of a frame (@hocuspocus/server, types.ts).
const SYNC = 0;
const AWARENESS = 1;
const AUTH = 2;
const CLOSE = 7;
/** The rest of the frame that refuses a document: "permission denied", and the reason. */
const denied = (reason: string) => Buffer.from([1, reason.length, ...Buffer.from(reason)]).toString('hex');
/** The rest of the frame that closes a document's connection: the reason. */
const closedBecause = (reason: string) =>
  Buffer.from([reason.length, ...Buffer.from(reason)]).toString('hex');

function varint(value: number): number[] {
  const bytes = [];
  for (; value > 127; value = Math.floor(value / 128)) bytes.push(128 | (value % 128));
  return [...bytes, value];
}
/** A frame a client sends: the document it is addressed to, and numbers and byte strings after it. */
function sent(name: string, ...parts: (number | Uint8Array)[]): Uint8Array<ArrayBuffer> {
  const text = Buffer.from(name);
  return Uint8Array.from([
    ...varint(text.length),
    ...text,
    ...parts.flatMap((part) => (typeof part === 'number' ? varint(part) : [...varint(part.length), ...part])),
  ]);
}

// ── Clients ─────────────────────────────────────────────────────────────────

const sockets: HocuspocusProviderWebsocket[] = [];

/** One socket of a signed-in browser, which carries as many documents as are opened on it. */
function connect(port: number, cookie: string) {
  const frames: ReturnType<typeof frame>[] = [];
  class Socket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie, origin: ORIGIN } } as never);
      this.addEventListener('message', (event) => frames.push(frame(new Uint8Array(event.data))));
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}${COLLAB_PATH}`,
    WebSocketPolyfill: Socket,
  });
  sockets.push(socket);
  const open = (name: string) => {
    const provider = new HocuspocusProvider({ websocketProvider: socket, name });
    const outcome = new Promise<{ scope?: string; refused?: string }>((resolve) => {
      provider.on('authenticated', ({ scope }: { scope: string }) => resolve({ scope }));
      provider.on('authenticationFailed', ({ reason }: { reason: string }) => resolve({ refused: reason }));
    });
    const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
    // What the server says as a stateless message (FR-ED-40 (b)).
    // The list of the people present is its own message (FR-ED-17), kept apart.
    const notices: string[] = [];
    const lists: string[] = [];
    provider.on('stateless', ({ payload }: { payload: string }) =>
      (payload.startsWith('{"kind":"people"') ? lists : notices).push(payload),
    );
    provider.attach();
    return {
      provider,
      outcome,
      synced,
      notices,
      lists,
      changes: provider.document.getArray<string>('changes'),
    };
  };
  const framesFor = (name: string) => frames.filter((each) => each.name === name);
  /** Whether the server closed this document's connection for this reason. */
  const closedFor = (name: string, reason: string) =>
    framesFor(name).some((each) => each.type === CLOSE && each.rest === closedBecause(reason));
  return { socket, open, frames, framesFor, closedFor };
}
type Client = ReturnType<typeof connect>;
type Opened = ReturnType<Client['open']>;

async function until<T>(read: () => T | Promise<T>, within = 10_000, every = 20): Promise<NonNullable<T>> {
  const end = Date.now() + within;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${within} ms`);
    await sleep(every);
  }
}

// ── Accounts and documents ──────────────────────────────────────────────────

let people = 0;
async function person(name = 'A Person') {
  const email = `presence${++people}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;

const documentOf = async (userId: string) => (await createDocument(userId)).id;
const grant = (documentId: string, userId: string, role: 'EDITOR' | 'VIEWER' | 'REVIEWER') =>
  db().documentCollaborator.create({ data: { documentId, userId, role } });

/** The server in this process. The period of the re-check is long: a test calls `recheck` itself. */
async function inProcess(
  options: { connectionsPerDocument?: number; recheckMs?: number; pendingWaitMs?: number } = {},
) {
  const collab = createCollabServer(
    { ...settings(), limits: settings().limits },
    { recheckMs: 3_600_000, ...options },
  );
  await new Promise<void>((resolve) => collab.httpServer.listen(0, resolve));
  return { ...collab, port: (collab.httpServer.address() as AddressInfo).port };
}
type Local = Awaited<ReturnType<typeof inProcess>>;

const connectionsOf = (local: Local, id: string) =>
  local.hocuspocus.documents.get(id)?.getConnections() ?? [];
const connectionOf = (local: Local, id: string, userId: string) =>
  connectionsOf(local, id).find((each) => each.context.userId === userId);
const slotsOf = (local: Local, id: string) =>
  connectionsOf(local, id)
    .map((each) => each.context.place.slot)
    .sort((a, b) => a - b);

/** An update a client could send: it adds one change. */
function forgedUpdate(change: string): Uint8Array {
  const forged = new Y.Doc();
  forged.getArray('changes').push([change]);
  return Y.encodeStateAsUpdate(forged);
}

/** One valid cursor at the start of the document's text, as the editor writes one. */
function cursorAt(provider: HocuspocusProvider) {
  const position = Y.createRelativePositionFromTypeIndex(provider.document.getXmlFragment('default'), 0);
  const json = Y.relativePositionToJSON(position);
  return { anchor: json, head: json };
}
/** What this client holds of the awareness of the client with this identifier. */
const stateOf = (client: Opened, clientId: number) => client.provider.awareness!.getStates().get(clientId);
const clientIdOf = (client: Opened) => client.provider.awareness!.clientID;

beforeEach(async () => {
  await db().securityLogEntry.deleteMany();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

/** Opens a document on a new socket for each account, all at once, and resolves with each outcome once it has one. */
async function openAll(local: Local, id: string, accounts: Person[]) {
  const clients = accounts.map((each) => {
    const client = connect(local.port, each.cookie);
    return { client, opened: client.open(id) };
  });
  const outcomes = await Promise.all(clients.map(({ opened }) => opened.outcome));
  // The library says `authenticated` before the document is loaded and the connection made.
  const admitted = outcomes.filter((each) => each.scope).length;
  await until(() => connectionsOf(local, id).length === admitted);
  return { clients, outcomes };
}

/**
 * An Owner, an Editor and a Viewer on one document, each with one connection,
 * opened one after the other so that their slots are 1, 2 and 3.
 */
async function three(local: Local) {
  const owner = await person('Ada Owner');
  const editor = await person('Ben Editor');
  const viewer = await person('Cy Viewer');
  const id = await documentOf(owner.id);
  await grant(id, editor.id, 'EDITOR');
  await grant(id, viewer.id, 'VIEWER');
  const sockets = {
    owner: connect(local.port, owner.cookie),
    editor: connect(local.port, editor.cookie),
    viewer: connect(local.port, viewer.cookie),
  };
  const clients = {} as Record<keyof typeof sockets, Opened>;
  for (const key of ['owner', 'editor', 'viewer'] as const) {
    clients[key] = sockets[key].open(id);
    await clients[key].synced;
    // The server tells each connection its role as it is made (FR-ED-40 (b)).
    await until(() => clients[key].notices.length === 1);
  }
  return { id, owner, editor, viewer, sockets, clients };
}

// ── The limit of ten connections ────────────────────────────────────────────

describe('the limit of ten connections to a document (NFR-PE-05, FR-ED-18)', () => {
  it('admits ten, of any role, and refuses the eleventh with the reason capacity before any state is sent', async () => {
    const local = await inProcess();
    try {
      const owner = await person('Ada Owner');
      const editor = await person('Ben Editor');
      const viewer = await person('Cy Viewer');
      const id = await documentOf(owner.id);
      await grant(id, editor.id, 'EDITOR');
      await grant(id, viewer.id, 'VIEWER');

      // Four of the Owner's, three of the Editor's, three of the Viewer's: ten, whatever the role.
      const ten = [owner, owner, owner, owner, editor, editor, editor, viewer, viewer, viewer];
      const first = await openAll(local, id, ten);
      expect(first.outcomes.map((each) => each.refused)).toEqual(Array(10).fill(undefined));
      expect(first.outcomes.filter((each) => each.scope === 'readonly')).toHaveLength(3);
      expect(local.placesOf(id)).toBe(10);
      expect(connectionsOf(local, id)).toHaveLength(10);

      // The eleventh, from an account that holds a role: refused as `capacity`, with nothing sent but that.
      const eleventh = connect(local.port, editor.cookie);
      expect(await eleventh.open(id).outcome).toEqual({ refused: REFUSAL.CAPACITY });
      await sleep(100);
      expect(eleventh.frames.map(({ type, rest }) => ({ type, rest }))).toEqual([
        { type: AUTH, rest: denied('capacity') },
      ]);
      expect(eleventh.frames.some((each) => each.type === SYNC)).toBe(false);
      // A refusal takes no place.
      expect(local.placesOf(id)).toBe(10);
      expect(connectionsOf(local, id)).toHaveLength(10);
    } finally {
      await local.stop();
    }
  });

  it('counts each connection of one account: a user with the document open in eleven tabs holds ten', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      const { outcomes } = await openAll(local, id, Array(11).fill(owner));
      expect(outcomes.filter((each) => each.scope)).toHaveLength(10);
      expect(outcomes.filter((each) => each.refused === REFUSAL.CAPACITY)).toHaveLength(1);
      expect(local.placesOf(id)).toBe(10);
    } finally {
      await local.stop();
    }
  });

  it('admits exactly ten of attempts that arrive at the same moment, with ten different slots', async () => {
    const local = await inProcess();
    try {
      const accounts = [await person('One'), await person('Two'), await person('Three')];
      const id = await documentOf(accounts[0]!.id);
      await grant(id, accounts[1]!.id, 'EDITOR');
      await grant(id, accounts[2]!.id, 'VIEWER');
      // Nine sockets for each of three accounts, all opened in one tick: 27 handshakes at once.
      const attempts = accounts.flatMap((each) => Array<Person>(9).fill(each));
      const { outcomes } = await openAll(local, id, attempts);
      const admitted = outcomes.filter((each) => each.scope);
      const refused = outcomes.filter((each) => each.refused);
      expect(admitted).toHaveLength(10);
      expect(refused).toHaveLength(17);
      expect(refused.every((each) => each.refused === REFUSAL.CAPACITY)).toBe(true);
      expect(local.placesOf(id)).toBe(10);
      expect(connectionsOf(local, id)).toHaveLength(10);
      // FR-ED-17: no two connections to a document share a colour.
      expect(slotsOf(local, id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await local.stop();
    }
  });

  it('gives a place back when its connection closes, and the next arrival takes the lowest free slot', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      await openAll(local, id, Array(10).fill(owner));
      // The connection that holds 4 is closed.
      connectionsOf(local, id)
        .find((each) => each.context.place.slot === 4)!
        .close({ code: 1000, reason: 'test' });
      expect(local.placesOf(id)).toBe(9);

      // The next attempt gets in, and its slot is 4: the freed one, and not the next number.
      const next = connect(local.port, owner.cookie);
      expect(await next.open(id).outcome).toEqual({ scope: 'read-write' });
      expect(local.placesOf(id)).toBe(10);
      expect(slotsOf(local, id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    } finally {
      await local.stop();
    }
  });

  it('frees the place of a client that goes away: the socket closes, and the next attempt is admitted', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      const { clients } = await openAll(local, id, Array(10).fill(owner));
      expect(await connect(local.port, owner.cookie).open(id).outcome).toEqual({ refused: REFUSAL.CAPACITY });
      clients[0]!.client.socket.destroy();
      await until(() => local.placesOf(id) === 9);
      expect(await connect(local.port, owner.cookie).open(id).outcome).toEqual({ scope: 'read-write' });
      expect(local.placesOf(id)).toBe(10);
    } finally {
      await local.stop();
    }
  });

  it('tells an account that holds no role nothing of how full a document is', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const stranger = await person();
      const id = await documentOf(owner.id);
      await openAll(local, id, Array(10).fill(owner));
      // The same answer as for a document that does not exist, at a full document and at an empty one.
      const full = await connect(local.port, stranger.cookie).open(id).outcome;
      const none = await connect(local.port, stranger.cookie).open('3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b')
        .outcome;
      expect(full).toEqual({ refused: REFUSAL.NO_ACCESS });
      expect(none).toEqual({ refused: REFUSAL.NO_ACCESS });
    } finally {
      await local.stop();
    }
  });

  it('takes no place for a load that fails', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(db().document, 'findUniqueOrThrow').mockRejectedValueOnce(new Error('the load failed'));
      // The library answers `authenticated` before it loads the document, and then refuses it.
      const failing = connect(local.port, owner.cookie);
      failing.open(id);
      await until(() => failing.framesFor(id).some((each) => each.rest === denied('unavailable')));
      expect(local.placesOf(id)).toBe(0);
      // And the document opens at its next attempt, in the first slot.
      await connect(local.port, owner.cookie).open(id).synced;
      expect(slotsOf(local, id)).toEqual([1]);
    } finally {
      await local.stop();
    }
  });

  it('holds the limit a server is given, which is the one named setting by default', async () => {
    expect(CONNECTIONS_PER_DOCUMENT).toBe(10);
    const local = await inProcess({ connectionsPerDocument: 3 });
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      const { outcomes } = await openAll(local, id, Array(4).fill(owner));
      expect(outcomes.filter((each) => each.scope)).toHaveLength(3);
      expect(outcomes.filter((each) => each.refused === REFUSAL.CAPACITY)).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });
});

// ── The colour of each connection ───────────────────────────────────────────

describe('the slot of each connection (FR-ED-17)', () => {
  it('is the lowest that is free, in the order of connection, and a freed slot goes to the next arrival', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      for (let n = 0; n < 3; n++) await connect(local.port, owner.cookie).open(id).synced;
      expect(slotsOf(local, id)).toEqual([1, 2, 3]);
      // The second leaves: the slot 2 is free, and the fourth to arrive holds it and not 4.
      connectionsOf(local, id)
        .find((each) => each.context.place.slot === 2)!
        .close({ code: 1000, reason: 'test' });
      await connect(local.port, owner.cookie).open(id).synced;
      expect(slotsOf(local, id)).toEqual([1, 2, 3]);
    } finally {
      await local.stop();
    }
  });
});

// ── What a connection may say of itself ─────────────────────────────────────

describe('presence: what a connection says of itself (FR-ED-17)', () => {
  it('shows each peer a cursor under the name the server holds and the slot of the connection', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      const cursor = cursorAt(clients.owner.provider);
      clients.owner.provider.setAwarenessField('cursor', cursor);
      const id = clientIdOf(clients.owner);
      // The Editor and the Viewer are both told, and the name is the account's.
      for (const peer of [clients.editor, clients.viewer]) {
        await until(() => stateOf(peer, id)?.cursor);
        expect(stateOf(peer, id)).toEqual({ user: { name: 'Ada Owner', slot: 1 }, cursor });
      }
    } finally {
      await local.stop();
    }
  });

  it('replaces a name, a slot, and every other field a client sends, with the server’s', async () => {
    const local = await inProcess();
    try {
      const { id, clients } = await three(local);
      const cursor = cursorAt(clients.editor.provider);
      clients.editor.provider.awareness!.setLocalState({
        user: { name: 'Someone else', slot: 7, color: 'a colour of its own' },
        cursor,
        padding: 'x'.repeat(100),
      });
      const editorId = clientIdOf(clients.editor);
      await until(() => stateOf(clients.owner, editorId)?.cursor);
      expect(stateOf(clients.owner, editorId)).toEqual({ user: { name: 'Ben Editor', slot: 2 }, cursor });
      expect(stateOf(clients.viewer, editorId)).toEqual({ user: { name: 'Ben Editor', slot: 2 }, cursor });
      // What the server holds of it is the same.
      expect(local.hocuspocus.documents.get(id)!.awareness.getStates().get(editorId)).toEqual({
        user: { name: 'Ben Editor', slot: 2 },
        cursor,
      });
    } finally {
      await local.stop();
    }
  });

  it('shows a Viewer to the others, as the requirement says of each connected collaborator, by its own name and slot', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      const cursor = cursorAt(clients.viewer.provider);
      clients.viewer.provider.awareness!.setLocalState({ user: { name: 'Ada Owner', slot: 1 }, cursor });
      const id = clientIdOf(clients.viewer);
      await until(() => stateOf(clients.owner, id)?.cursor);
      // Not the Owner's name and slot, which it asked for.
      expect(stateOf(clients.owner, id)).toEqual({ user: { name: 'Cy Viewer', slot: 3 }, cursor });
      expect(stateOf(clients.editor, id)).toEqual({ user: { name: 'Cy Viewer', slot: 3 }, cursor });
    } finally {
      await local.stop();
    }
  });

  it('drops a state for the identifier of another client, and one for a second identifier of its own', async () => {
    const local = await inProcess();
    try {
      const { id, sockets, clients } = await three(local);
      const victim = clientIdOf(clients.editor);
      // Both have spoken, so the server holds one identifier for each.
      clients.editor.provider.setAwarenessField('cursor', cursorAt(clients.editor.provider));
      clients.owner.provider.setAwarenessField('cursor', cursorAt(clients.owner.provider));
      await until(
        () =>
          stateOf(clients.viewer, victim)?.cursor &&
          stateOf(clients.viewer, clientIdOf(clients.owner))?.cursor,
      );

      /** A frame that says what a client with this identifier is: newer than anything it has said. */
      const speaking = (clientId: number, state: object) => {
        const ydoc = new Y.Doc();
        ydoc.clientID = clientId;
        const fake = new Awareness(ydoc);
        for (let clock = 0; clock < 200; clock++) fake.setLocalState(state);
        return sent(id, AWARENESS, encodeAwarenessUpdate(fake, [clientId]));
      };
      const cursor = cursorAt(clients.owner.provider);
      // The Owner speaks for the Editor, and then for an identifier nobody has used.
      sockets.owner.socket.webSocket!.send(speaking(victim, { user: { name: 'Hijacked', slot: 9 }, cursor }));
      sockets.owner.socket.webSocket!.send(
        speaking(4242424242, { user: { name: 'Invented', slot: 9 }, cursor }),
      );
      await sleep(400);
      const held = local.hocuspocus.documents.get(id)!;
      expect(held.awareness.getStates().get(victim)).toMatchObject({ user: { name: 'Ben Editor', slot: 2 } });
      expect(held.awareness.getStates().has(4242424242)).toBe(false);
      for (const peer of [clients.owner, clients.viewer]) {
        expect(stateOf(peer, victim)).toMatchObject({ user: { name: 'Ben Editor', slot: 2 } });
        expect(stateOf(peer, 4242424242)).toBeUndefined();
      }
      // Nobody was closed for it.
      expect(local.placesOf(id)).toBe(3);
    } finally {
      await local.stop();
    }
  });

  it('keeps a client whose cursor is not two relative positions, and passes none of it on', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      const id = clientIdOf(clients.editor);
      const bad: unknown[] = [
        'text',
        { anchor: { type: 'x' }, head: {} },
        { anchor: { tname: 'a'.repeat(300) }, head: { tname: 'a' } },
        { anchor: { type: { client: -1, clock: 0 } }, head: { tname: 'a' } },
        { anchor: { tname: 'a', extra: 1 }, head: { tname: 'a' } },
        { anchor: { tname: 'a' } },
        { anchor: { tname: 'a' }, head: { tname: 'a' }, more: 1 },
      ];
      const good = cursorAt(clients.editor.provider);
      for (const cursor of bad) {
        // A cursor that is one is shown, and then each that is not takes it away: were it passed on,
        // the peer would still hold it, as what was sent.
        clients.editor.provider.awareness!.setLocalState({ cursor: good });
        await until(() => stateOf(clients.owner, id)?.cursor);
        clients.editor.provider.awareness!.setLocalState({ cursor });
        await until(() => !('cursor' in stateOf(clients.owner, id)!));
        // The person is still there, without the cursor.
        expect(stateOf(clients.owner, id)).toEqual({ user: { name: 'Ben Editor', slot: 2 } });
        await until(() => !('cursor' in (stateOf(clients.viewer, id) ?? { cursor: 1 })));
        expect(stateOf(clients.viewer, id)).toEqual({ user: { name: 'Ben Editor', slot: 2 } });
      }
      // And one that is a cursor goes on again.
      clients.editor.provider.setAwarenessField('cursor', good);
      await until(() => stateOf(clients.owner, id)?.cursor);
      expect(stateOf(clients.owner, id)?.cursor).toEqual(good);
    } finally {
      await local.stop();
    }
  });

  it('closes the connection that sends awareness longer than a state can be', async () => {
    const local = await inProcess();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const { id, owner, sockets, editor } = await three(local);
      expect(local.placesOf(id)).toBe(3);

      // 5,000 bytes of what is not even an update: never read, and the connection goes.
      sockets.owner.socket.webSocket!.send(sent(id, AWARENESS, new Uint8Array(5000)));
      await until(() => local.placesOf(id) === 2);
      expect(connectionOf(local, id, owner.id)).toBeUndefined();
      // The others are untouched.
      expect(connectionOf(local, id, editor.id)).toBeDefined();
    } finally {
      await local.stop();
    }
  });

  it('takes a cursor away from the others when its connection closes, and leaves the others’ alone', async () => {
    const local = await inProcess();
    try {
      const { id, editor, clients } = await three(local);
      clients.editor.provider.setAwarenessField('cursor', cursorAt(clients.editor.provider));
      clients.owner.provider.setAwarenessField('cursor', cursorAt(clients.owner.provider));
      const gone = clientIdOf(clients.editor);
      const stays = clientIdOf(clients.owner);
      await until(() => stateOf(clients.viewer, gone)?.cursor && stateOf(clients.viewer, stays)?.cursor);
      connectionOf(local, id, editor.id)!.close({ code: 1000, reason: 'test' });
      await until(() => stateOf(clients.viewer, gone) === undefined);
      expect(stateOf(clients.viewer, stays)?.user).toEqual({ name: 'Ada Owner', slot: 1 });
    } finally {
      await local.stop();
    }
  });

  it('names a person by the part of the address before the @ where the account has no name', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const nameless = await person();
      await db().user.update({ where: { id: nameless.id }, data: { name: '   ' } });
      const id = await documentOf(owner.id);
      await grant(id, nameless.id, 'EDITOR');
      const a = connect(local.port, owner.cookie).open(id);
      await a.synced;
      const b = connect(local.port, nameless.cookie).open(id);
      await b.synced;
      b.provider.setAwarenessField('cursor', cursorAt(b.provider));
      await until(() => stateOf(a, clientIdOf(b))?.cursor);
      expect(stateOf(a, clientIdOf(b))?.user).toEqual({ name: nameless.email.split('@')[0], slot: 2 });
    } finally {
      await local.stop();
    }
  });
});

// ── The 60-second re-check ──────────────────────────────────────────────────

describe('the re-check of open connections (FR-ED-41, NFR-SE-03 (e))', () => {
  const roles = (local: Local, id: string) =>
    connectionsOf(local, id)
      .map((each) => each.context.role)
      .sort();

  it('closes the connections of a session whose row is gone, as session-ended, and gives their places back', async () => {
    const local = await inProcess();
    try {
      const { id, editor, sockets } = await three(local);
      // A session revoked: its row is deleted. The cookie is still a good copy of it.
      await db().session.deleteMany({ where: { userId: editor.id } });
      await local.recheck();
      await until(() => sockets.editor.closedFor(id, REFUSAL.SESSION_ENDED));
      expect(roles(local, id)).toEqual(['owner', 'viewer']);
      expect(local.placesOf(id)).toBe(2);
    } finally {
      await local.stop();
    }
  });

  it('closes a session that has expired under either period of FR-AU-84, and one whose account is deleted', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, sockets } = await three(local);
      // The 7 days of idleness: the row says it has expired.
      await db().session.updateMany({
        where: { userId: editor.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      // The 30 days from its beginning, though it was renewed and is not idle.
      await db().session.updateMany({
        where: { userId: viewer.id },
        data: { createdAt: new Date(Date.now() - 31 * DAY * 1000) },
      });
      // The tombstone of a deleted account (FR-AU-58 (e)): no name, no address.
      await db().user.update({ where: { id: owner.id }, data: { name: null, email: null } });
      await local.recheck();
      for (const each of [sockets.editor, sockets.viewer, sockets.owner]) {
        await until(() => each.closedFor(id, REFUSAL.SESSION_ENDED));
      }
      expect(roles(local, id)).toEqual([]);
    } finally {
      await local.stop();
    }
  });

  it('keeps a session that stands, one near the end of its 30 days among them', async () => {
    const local = await inProcess();
    try {
      const { id, editor } = await three(local);
      await db().session.updateMany({
        where: { userId: editor.id },
        data: {
          createdAt: new Date(Date.now() - 29 * DAY * 1000),
          expiresAt: new Date(Date.now() + DAY * 1000),
        },
      });
      const before = connectionsOf(local, id);
      await local.recheck();
      expect(before.every((each) => connectionsOf(local, id).includes(each))).toBe(true);
      expect(roles(local, id)).toEqual(['editor', 'owner', 'viewer']);
    } finally {
      await local.stop();
    }
  });

  it('closes the connections of a collaborator whose row was removed, as access-ended, and no one else’s', async () => {
    const local = await inProcess();
    try {
      const { id, editor, sockets } = await three(local);
      await db().documentCollaborator.delete({
        where: { documentId_userId: { documentId: id, userId: editor.id } },
      });
      await local.recheck();
      await until(() => sockets.editor.closedFor(id, REFUSAL.ACCESS_ENDED));
      expect(roles(local, id)).toEqual(['owner', 'viewer']);
      expect(local.placesOf(id)).toBe(2);
      // And the handshake refuses it from here on (FR-ED-39).
      expect(await connect(local.port, editor.cookie).open(id).outcome).toEqual({
        refused: REFUSAL.NO_ACCESS,
      });
    } finally {
      await local.stop();
    }
  });

  it('closes every connection to a document that was deleted with no notice, as access-ended', async () => {
    const local = await inProcess();
    try {
      const { id, owner, sockets } = await three(local);
      // No event is published: only the row changes, as when the notice is lost.
      await db().document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: owner.id } });
      await local.recheck();
      for (const each of Object.values(sockets)) await until(() => each.closedFor(id, REFUSAL.ACCESS_ENDED));
      expect(roles(local, id)).toEqual([]);
    } finally {
      await local.stop();
    }
  });

  it('switches an Editor who becomes a Viewer to read-only in place, tells it, and back again (FR-ED-40 (b))', async () => {
    const local = await inProcess();
    try {
      const { id, editor, sockets, clients } = await three(local);
      const held = local.hocuspocus.documents.get(id)!;
      const connection = connectionOf(local, id, editor.id)!;
      expect(connection.readOnly).toBe(false);

      clients.editor.changes.push(['written as an Editor']);
      await until(() => held.getArray('changes').length === 1);

      await db().documentCollaborator.update({
        where: { documentId_userId: { documentId: id, userId: editor.id } },
        data: { role: 'VIEWER' },
      });
      await local.recheck();
      // The same connection, still open, now read-only, and its record says why.
      expect(connectionOf(local, id, editor.id)).toBe(connection);
      expect(connection.readOnly).toBe(true);
      expect(connection.context.role).toBe('viewer');
      expect(connection.context.permissions).not.toContain('document.content.edit');
      // The role it was told at its connection, and now the change.
      await until(() => clients.editor.notices.length === 2);
      expect(readRoleNotice(clients.editor.notices[0]!)).toEqual({ role: 'editor', canEdit: true });
      expect(readRoleNotice(clients.editor.notices[1]!)).toEqual({ role: 'viewer', canEdit: false });

      // What it sends now is discarded (NFR-SE-03 (a)): an update, as a frame past the editor's own controls.
      sockets.editor.socket.webSocket!.send(sent(id, SYNC, 2, forgedUpdate('written as a Viewer')));
      await sleep(300);
      expect(held.getArray('changes').toArray()).toEqual(['written as an Editor']);
      // The others are told nothing more than the role each was told at its connection.
      expect(clients.owner.notices).toHaveLength(1);
      expect(clients.viewer.notices).toHaveLength(1);

      // An Editor again: editable in place, told, and what it writes now is applied.
      await db().documentCollaborator.update({
        where: { documentId_userId: { documentId: id, userId: editor.id } },
        data: { role: 'EDITOR' },
      });
      await local.recheck();
      expect(connectionOf(local, id, editor.id)).toBe(connection);
      expect(connection.readOnly).toBe(false);
      expect(connection.context.role).toBe('editor');
      await until(() => clients.editor.notices.length === 3);
      expect(readRoleNotice(clients.editor.notices[2]!)).toEqual({ role: 'editor', canEdit: true });
      clients.editor.changes.push(['written as an Editor again']);
      await until(() => held.getArray('changes').toArray().includes('written as an Editor again'));
    } finally {
      await local.stop();
    }
  });

  it('does nothing to a connection where nothing changed, and tells no one', async () => {
    const local = await inProcess();
    try {
      const { id, clients } = await three(local);
      const before = connectionsOf(local, id);
      const flags = before.map((each) => [each.readOnly, each.context.role]);
      await local.recheck();
      await local.recheck();
      const after = connectionsOf(local, id);
      expect(after).toHaveLength(3);
      expect(before.every((each) => after.includes(each))).toBe(true);
      expect(after.map((each) => [each.readOnly, each.context.role])).toEqual(flags);
      for (const each of Object.values(clients)) expect(each.notices).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });

  it('reads the session’s row and never the identity library, which answers from the signed copy', async () => {
    const local = await inProcess();
    try {
      const { id } = await three(local);
      const library = vi.spyOn(auth().api, 'getSession');
      const rows = vi.spyOn(db().session, 'findMany');
      await local.recheck();
      expect(library).not.toHaveBeenCalled();
      // One query for the sessions of all three connections.
      expect(rows).toHaveBeenCalledTimes(1);
      expect(rows.mock.calls[0]![0]).toMatchObject({ where: { id: { in: expect.any(Array) } } });
      expect(connectionsOf(local, id)).toHaveLength(3);
    } finally {
      await local.stop();
    }
  });

  it('closes as unavailable what it could not read, and says nothing of the fault', async () => {
    const local = await inProcess();
    try {
      const { id, editor, sockets } = await three(local);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const quoting = new Error(`Failing row contains (${editor.email}).`);

      // The access of one account cannot be read: its connection is closed, and the others are not.
      const real = db().document.findUnique.bind(db().document);
      let reads = 0;
      vi.spyOn(db().document, 'findUnique').mockImplementation(((args: never) =>
        ++reads === 2 ? Promise.reject(quoting) : real(args)) as never);
      await local.recheck();
      await until(
        () => Object.values(sockets).filter((each) => each.closedFor(id, REFUSAL.UNAVAILABLE)).length === 1,
      );
      expect(connectionsOf(local, id)).toHaveLength(2);
      expect(errors.mock.calls.flat().join('\n')).toContain('re-check not read for access (Error)');
      vi.restoreAllMocks();

      // The sessions cannot be read: every connection is closed.
      const again = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(db().session, 'findMany').mockRejectedValue(quoting);
      await local.recheck();
      expect(connectionsOf(local, id)).toHaveLength(0);
      expect(again.mock.calls.flat().join('\n')).toContain('re-check not read for sessions (Error)');
      // NFR-SE-19: the class of the fault, never its message, which quotes a row.
      expect(again.mock.calls.flat().join('\n')).not.toContain(editor.email);
      expect(errors.mock.calls.flat().join('\n')).not.toContain(editor.email);
    } finally {
      await local.stop();
    }
  });

  it('does not start a run while the last has not ended', async () => {
    const local = await inProcess();
    try {
      await three(local);
      const original = db().session.findMany.bind(db().session);
      const rows = vi.spyOn(db().session, 'findMany').mockImplementation((async (args: never) => {
        await sleep(400);
        return original(args);
      }) as never);
      const first = local.recheck();
      await local.recheck();
      expect(rows).toHaveBeenCalledTimes(1);
      await first;
      await local.recheck();
      expect(rows).toHaveBeenCalledTimes(2);
    } finally {
      await local.stop();
    }
  });

  it('is run by the timer of the server, with no call', async () => {
    const local = await inProcess({ recheckMs: 150 });
    try {
      const { id, editor, sockets } = await three(local);
      await db().session.deleteMany({ where: { userId: editor.id } });
      await until(() => sockets.editor.closedFor(id, REFUSAL.SESSION_ENDED), 15_000);
      expect(roles(local, id)).toEqual(['owner', 'viewer']);
    } finally {
      await local.stop();
    }
  });

  it('runs every 60 seconds by default, on a timer that keeps no process alive, and clears it at the stop', async () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const cleared = vi.spyOn(globalThis, 'clearInterval');
    const collab = createCollabServer({ ...settings(), limits: settings().limits });
    const period = set.mock.calls.findIndex(([, ms]) => ms === 60_000);
    expect(period).toBeGreaterThanOrEqual(0);
    const timer = set.mock.results[period]!.value as NodeJS.Timeout;
    expect(timer.hasRef()).toBe(false);
    await collab.stop();
    expect(cleared.mock.calls.map(([each]) => each)).toContain(timer);
  });

  it('reads the sessions again once before it gives up every connection of the run', async () => {
    const local = await inProcess();
    try {
      const { id } = await three(local);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      // One query that fails drops no one: the second answers.
      const rows = vi.spyOn(db().session, 'findMany').mockRejectedValueOnce(new Error('a blip'));
      await local.recheck();
      expect(rows).toHaveBeenCalledTimes(2);
      expect(connectionsOf(local, id)).toHaveLength(3);
      expect(errors.mock.calls.flat().join('\n')).toContain('re-check not read for sessions (Error)');
      // Two that fail, one after the other, do.
      rows.mockRejectedValue(new Error('an outage'));
      await local.recheck();
      expect(connectionsOf(local, id)).toHaveLength(0);
    } finally {
      await local.stop();
    }
  });
});

// What the review of this slice found (FR-ED-40 (b), FR-ED-41, NFR-PE-05, NFR-SE-03).
describe('after the review', () => {
  it('gives back the places of every handshake that waited for a load that failed', async () => {
    const local = await inProcess();
    try {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const owner = await person();
      const id = await documentOf(owner.id);
      // A slow load that fails: the three handshakes below wait for the same one, and the library tells
      // of its failure once.
      vi.spyOn(db().document, 'findUniqueOrThrow').mockImplementationOnce((async () => {
        await sleep(500);
        throw new Error('the load failed');
      }) as never);
      const attempts = [1, 2, 3].map(() => connect(local.port, owner.cookie));
      for (const each of attempts) each.open(id);
      await until(() =>
        attempts.every((each) => each.framesFor(id).some((frame) => frame.rest === denied('unavailable'))),
      );
      expect(local.placesOf(id)).toBe(0);
      // And the document is opened at the next attempt, in the first slot.
      await connect(local.port, owner.cookie).open(id).synced;
      expect(slotsOf(local, id)).toEqual([1]);
    } finally {
      await local.stop();
    }
  });

  it('gives the place back where the name of the account cannot be read', async () => {
    const local = await inProcess();
    try {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const owner = await person();
      const id = await documentOf(owner.id);
      const real = db().user.findUnique.bind(db().user);
      // Only the reading of the name and the address: the library reads the account for the session too.
      vi.spyOn(db().user, 'findUnique').mockImplementation(((args: { select?: Record<string, boolean> }) =>
        args?.select?.name && args.select.email && Object.keys(args.select).length === 2
          ? Promise.reject(new Error(`Failing row contains (${owner.email}).`))
          : real(args as never)) as never);
      const failing = connect(local.port, owner.cookie);
      failing.open(id);
      await until(() => failing.framesFor(id).some((frame) => frame.rest === denied('unavailable')));
      expect(local.placesOf(id)).toBe(0);
      expect(errors.mock.calls.flat().join('\n')).toContain('collab: account failed (Error)');
      expect(errors.mock.calls.flat().join('\n')).not.toContain(owner.email);
      vi.restoreAllMocks();
      await connect(local.port, owner.cookie).open(id).synced;
      expect(slotsOf(local, id)).toEqual([1]);
    } finally {
      await local.stop();
    }
  });

  it('lets an awareness message that does not read to its end speak for no one, and not for whom the message before spoke for', async () => {
    const local = await inProcess();
    try {
      const { id, sockets, clients } = await three(local);
      const ownerId = clientIdOf(clients.owner);
      const first = cursorAt(clients.owner.provider);
      clients.owner.provider.setAwarenessField('cursor', first);
      await until(() => stateOf(clients.viewer, ownerId)?.cursor);

      // A message with an identifier written in 6 bytes (valid for the library, which decodes it) and the
      // Owner's own, with a cursor of another kind and a clock that is newer than any.
      const ydoc = new Y.Doc();
      const fake = new Awareness(ydoc);
      const other = { anchor: { tname: 'other' }, head: { tname: 'other' } };
      for (const each of [2 ** 40, ownerId]) {
        fake.states.set(each, { cursor: other });
        fake.meta.set(each, { clock: 100_000, lastUpdated: Date.now() });
      }
      const update = encodeAwarenessUpdate(fake, [2 ** 40, ownerId]);
      fake.destroy();
      sockets.owner.socket.webSocket!.send(sent(id, AWARENESS, update));
      await sleep(500);
      // Nothing of that message was passed on.
      expect(stateOf(clients.viewer, ownerId)?.cursor).toEqual(first);
      expect(stateOf(clients.viewer, 2 ** 40)).toBeUndefined();
      expect(local.hocuspocus.documents.get(id)!.awareness.getStates().get(ownerId)?.cursor).toEqual(first);
    } finally {
      await local.stop();
    }
  });

  // A read-only connection's updates are not checked (`beforeSync`), and the library reads the flag after
  // that hook: so a connection is made editable only between its messages.
  it('makes a read-only connection editable only when none of its messages is in flight', async () => {
    const local = await inProcess();
    try {
      const { id, viewer, clients } = await three(local);
      const connection = connectionOf(local, id, viewer.id)!;
      expect(connection.readOnly).toBe(true);
      // A message of this connection that is being handled, for as long as the test says.
      let finish!: () => void;
      const inFlight = new Promise<void>((resolve) => (finish = resolve));
      vi.spyOn(connection, 'waitForPendingMessages').mockReturnValue(inFlight);

      await db().documentCollaborator.update({
        where: { documentId_userId: { documentId: id, userId: viewer.id } },
        data: { role: 'EDITOR' },
      });
      const run = local.recheck();
      await sleep(400);
      // The role is an Editor's by the row, and the flag has not turned.
      expect(connection.readOnly).toBe(true);
      expect(clients.viewer.notices).toHaveLength(1);
      finish();
      await run;
      expect(connection.readOnly).toBe(false);
      expect(connection.context.role).toBe('editor');
      await until(() => clients.viewer.notices.length === 2);
      expect(readRoleNotice(clients.viewer.notices[1]!)).toEqual({ role: 'editor', canEdit: true });
    } finally {
      await local.stop();
    }
  });

  describe('a client whose socket was lost and opened again by the library', () => {
    /** The editor of a document, as `DocumentConnection` makes it, over a socket the test can close. */
    async function reconnecting(local: Local, holder: Person, id: string) {
      const { DocumentConnection } = await import('../../src/lib/collab/client.ts');
      const made: WebSocket[] = [];
      class Socket extends WebSocket {
        constructor(url: string) {
          super(url, { headers: { cookie: holder.cookie, origin: ORIGIN } } as never);
          made.push(this);
        }
      }
      const connection = new DocumentConnection({
        url: `ws://127.0.0.1:${local.port}${COLLAB_PATH}`,
        documentId: id,
        errorAfterMs: 60_000,
        probe: async () => 200,
        WebSocketPolyfill: Socket,
      });
      connection.start();
      await until(() => connection.getState().phase === 'connected');
      return { connection, made };
    }

    it(
      'is read-only where its role was taken meanwhile, editable where it was given, and told which',
      { timeout: 90_000 },
      async () => {
        const local = await inProcess();
        try {
          const owner = await person('Ada Owner');
          const editor = await person('Ben Editor');
          const id = await documentOf(owner.id);
          await grant(id, editor.id, 'EDITOR');
          const { connection, made } = await reconnecting(local, editor, id);
          try {
            expect(connection.getState().canEdit).toBe(true);
            expect(connection.getState().notice).toBeUndefined();

            // The role is taken while the socket is lost, and the re-check (which is not run: its period is
            // long here) has seen nothing: the new handshake alone says so.
            const where = { documentId_userId: { documentId: id, userId: editor.id } };
            await db().documentCollaborator.update({ where, data: { role: 'VIEWER' } });
            made.at(-1)!.close();
            await until(() => connection.getState().canEdit === false, 20_000);
            await until(() => connection.getState().notice?.role === 'viewer');
            expect(connection.getState().notice).toEqual({ role: 'viewer', canEdit: false });
            expect(connectionOf(local, id, editor.id)!.readOnly).toBe(true);

            // And given back while it is lost again.
            await db().documentCollaborator.update({ where, data: { role: 'EDITOR' } });
            made.at(-1)!.close();
            await until(() => connection.getState().canEdit === true, 20_000);
            await until(() => connection.getState().notice?.role === 'editor');
            expect(connection.getState().notice).toEqual({ role: 'editor', canEdit: true });
            expect(connectionOf(local, id, editor.id)!.readOnly).toBe(false);
          } finally {
            connection.stop();
          }
        } finally {
          await local.stop();
        }
      },
    );
  });
});

// ── FR-ED-17: who has the document open ────────────────────────────────────

describe('who has the document open (FR-ED-17; the row of the people present)', () => {
  const listOf = (client: Opened) => readPeopleNotice(client.lists.at(-1) ?? '');

  it('tells every connection, a Viewer’s included, who is present: name, colour, role, and which is its own', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      await until(() => Object.values(clients).every((each) => listOf(each)?.length === 3));
      const everyone = [
        { slot: 1, name: 'Ada Owner', role: 'owner' },
        { slot: 2, name: 'Ben Editor', role: 'editor' },
        { slot: 3, name: 'Cy Viewer', role: 'viewer' },
      ];
      // The same three for each, in the order of the colours, with the recipient's own entry marked.
      expect(listOf(clients.owner)).toEqual([{ ...everyone[0]!, you: true }, everyone[1], everyone[2]]);
      expect(listOf(clients.editor)).toEqual([everyone[0], { ...everyone[1]!, you: true }, everyone[2]]);
      expect(listOf(clients.viewer)).toEqual([everyone[0], everyone[1], { ...everyone[2]!, you: true }]);
    } finally {
      await local.stop();
    }
  });

  it('shows the same account twice when it has the document open in two tabs, each in the colour of its place (register row PR-3)', async () => {
    const local = await inProcess();
    try {
      const { id, editor, clients } = await three(local);
      const second = connect(local.port, editor.cookie).open(id);
      await second.synced;
      await until(() => listOf(clients.owner)?.length === 4);
      expect(listOf(clients.owner)!.map(({ slot, name }) => [slot, name])).toEqual([
        [1, 'Ada Owner'],
        [2, 'Ben Editor'],
        [3, 'Cy Viewer'],
        [4, 'Ben Editor'],
      ]);
      // And the second tab is told it is the fourth, and not the second.
      await until(() => listOf(second)?.length === 4);
      expect(
        listOf(second)!
          .filter(({ you }) => you)
          .map(({ slot }) => slot),
      ).toEqual([4]);
    } finally {
      await local.stop();
    }
  });

  it('tells the others when a connection goes, and when a role changes, and not the one that went', async () => {
    const local = await inProcess();
    try {
      const { id, editor, viewer, clients } = await three(local);
      await until(() => Object.values(clients).every((each) => listOf(each)?.length === 3));
      const gone = clients.viewer.lists.length;
      connectionOf(local, id, viewer.id)!.close({ code: 1000, reason: 'test' });
      await until(() => listOf(clients.owner)?.length === 2);
      expect(listOf(clients.editor)!.map(({ name }) => name)).toEqual(['Ada Owner', 'Ben Editor']);
      // The connection that closed is sent nothing more.
      await sleep(200);
      expect(clients.viewer.lists).toHaveLength(gone);

      // A role that changes is sent again to everyone, in the new role.
      await db().documentCollaborator.update({
        where: { documentId_userId: { documentId: id, userId: editor.id } },
        data: { role: 'VIEWER' },
      });
      await local.recheck();
      await until(() => listOf(clients.owner)?.[1]?.role === 'viewer');
      expect(listOf(clients.editor)![1]).toEqual({ slot: 2, name: 'Ben Editor', role: 'viewer', you: true });
    } finally {
      await local.stop();
    }
  });

  it('holds the name and the slot the server holds, whatever a client says in awareness', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      clients.viewer.provider.awareness!.setLocalState({ user: { name: 'Ada Owner', slot: 1 } });
      await sleep(300);
      await local.recheck();
      expect(listOf(clients.owner)!.map(({ name, slot }) => [slot, name])).toEqual([
        [1, 'Ada Owner'],
        [2, 'Ben Editor'],
        [3, 'Cy Viewer'],
      ]);
    } finally {
      await local.stop();
    }
  });

  it('relays no list a client sends: a message of the kind from a peer reaches no one', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      await until(() => Object.values(clients).every((each) => listOf(each)?.length === 3));
      const before = Object.values(clients).map((each) => each.lists.length);
      clients.viewer.provider.sendStateless(peopleNotice([{ slot: 1, name: 'Someone else', role: 'owner' }]));
      clients.viewer.provider.sendStateless(JSON.stringify({ kind: 'role', role: 'owner', canEdit: true }));
      await sleep(400);
      expect(Object.values(clients).map((each) => each.lists.length)).toEqual(before);
      expect(clients.owner.notices).toHaveLength(1);
      expect(clients.editor.notices).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });
});

// ── S14-5: the limit on presence messages ──────────────────────────────────

describe('the limit of 60 presence messages a second for each connection (S14-5)', () => {
  /** A cursor that names the message it came in: the peers read the number back. */
  const cursor = (n: number) => ({
    anchor: { item: { client: 7, clock: n } },
    head: { item: { client: 7, clock: n } },
  });
  const numberSeenBy = (peer: Opened, clientId: number) => {
    const state = stateOf(peer, clientId) as { cursor?: { anchor: { item: { clock: number } } } } | undefined;
    return state?.cursor?.anchor.item.clock;
  };
  const say = (client: Opened, n: number) => client.provider.awareness!.setLocalState({ cursor: cursor(n) });

  it('passes the first 60 messages of a second to the peers, drops the 61st, keeps the connection, and passes the next second’s', async () => {
    const local = await inProcess();
    try {
      const { id, editor, clients } = await three(local);
      // The messages of the opening leave the window.
      await sleep(1100);
      const sender = clientIdOf(clients.editor);
      for (let n = 1; n <= 61; n += 1) say(clients.editor, n);
      await until(() => numberSeenBy(clients.owner, sender) === 60);
      // The 61st never reaches anyone: not the Owner, not the Viewer.
      await sleep(400);
      expect(numberSeenBy(clients.owner, sender)).toBe(60);
      expect(numberSeenBy(clients.viewer, sender)).toBe(60);
      expect(local.hocuspocus.documents.get(id)!.awareness.getStates().get(sender)).toMatchObject({
        cursor: cursor(60),
      });
      // The connection is kept: still open, the same one, and it still writes.
      expect(connectionOf(local, id, editor.id)).toBeDefined();
      expect(connectionOf(local, id, editor.id)!.readOnly).toBe(false);
      clients.editor.changes.push(['written after the limit']);
      await until(() => local.hocuspocus.documents.get(id)!.getArray('changes').length === 1);

      // A second later the next message passes.
      await sleep(1000);
      say(clients.editor, 100);
      await until(() => numberSeenBy(clients.owner, sender) === 100);
    } finally {
      await local.stop();
    }
  });

  // The library builds the awareness of every client for each request and can no more drop one than
  // refuse a message: a connection past the limit with these is closed.
  it('counts a request for everyone’s awareness under the same limit: 60 are let through, and the 61st closes the connection', async () => {
    const local = await inProcess();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id, owner, editor, sockets } = await three(local);
      await sleep(1100);
      // The type of the message (3) and nothing after it.
      for (let n = 1; n <= 60; n += 1) sockets.owner.socket.webSocket!.send(sent(id, 3));
      await sleep(300);
      expect(connectionOf(local, id, owner.id)).toBeDefined();
      sockets.owner.socket.webSocket!.send(sent(id, 3));
      await until(() => connectionOf(local, id, owner.id) === undefined);
      // Not the others'.
      expect(connectionOf(local, id, editor.id)).toBeDefined();
    } finally {
      await local.stop();
    }
  });

  it('counts the two kinds together: 30 requests and 30 cursors pass, and one more request closes the connection', async () => {
    const local = await inProcess();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id, owner, sockets, clients } = await three(local);
      await sleep(1100);
      for (let n = 1; n <= 30; n += 1) {
        sockets.owner.socket.webSocket!.send(sent(id, 3));
        say(clients.owner, n);
      }
      await sleep(300);
      expect(connectionOf(local, id, owner.id)).toBeDefined();
      // 31 requests alone would have passed: it is the 61st message of the second.
      sockets.owner.socket.webSocket!.send(sent(id, 3));
      await until(() => connectionOf(local, id, owner.id) === undefined);
    } finally {
      await local.stop();
    }
  });

  it('counts for each connection: a second tab of the same account has its own 60', async () => {
    const local = await inProcess();
    try {
      const { id, editor, clients } = await three(local);
      const second = connect(local.port, editor.cookie).open(id);
      await second.synced;
      await sleep(1100);
      for (let n = 1; n <= 61; n += 1) {
        say(clients.editor, n);
        say(second, n);
      }
      await until(
        () =>
          numberSeenBy(clients.owner, clientIdOf(clients.editor)) === 60 &&
          numberSeenBy(clients.owner, clientIdOf(second)) === 60,
      );
      await sleep(300);
      expect(numberSeenBy(clients.owner, clientIdOf(clients.editor))).toBe(60);
      expect(numberSeenBy(clients.owner, clientIdOf(second))).toBe(60);
    } finally {
      await local.stop();
    }
  });

  it('leaves the pace of a person alone: a cursor that moves every 25 ms for two seconds reaches the peers every time', async () => {
    const local = await inProcess();
    try {
      const { clients } = await three(local);
      await sleep(1100);
      const sender = clientIdOf(clients.editor);
      const seen: number[] = [];
      clients.owner.provider.awareness!.on('update', () => {
        const at = numberSeenBy(clients.owner, sender);
        if (at !== undefined && seen.at(-1) !== at) seen.push(at);
      });
      for (let n = 1; n <= 80; n += 1) {
        say(clients.editor, n);
        await sleep(25);
      }
      await until(() => numberSeenBy(clients.owner, sender) === 80);
      // Every one of the 80 arrived, in order: none was dropped.
      expect(seen).toEqual(Array.from({ length: 80 }, (_, at) => at + 1));
    } finally {
      await local.stop();
    }
  });
});

// ── F14-2: a downgrade handles what was received first ────────────────────

describe('a connection made read-only first handles the messages it has received (F14-2)', () => {
  const where = (id: string, userId: string) => ({ documentId_userId: { documentId: id, userId } });
  /** Makes the next messages of a connection wait in `beforeSync`, as a slow check does, until `release`. */
  function gated(connection: ReturnType<typeof connectionOf> & object) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = connection.callbacks.beforeSync;
    connection.callbacks.beforeSync = async (c, payload) => {
      await gate;
      return original(c, payload);
    };
    return release;
  }

  it('keeps an update that was already received when the Editor became a Viewer, and discards the one that comes after', async () => {
    const local = await inProcess();
    try {
      const { id, editor, sockets } = await three(local);
      const held = local.hocuspocus.documents.get(id)!;
      const connection = connectionOf(local, id, editor.id)!;
      const release = gated(connection);
      // Received, and being handled.
      sockets.editor.socket.webSocket!.send(sent(id, SYNC, 2, forgedUpdate('received as an Editor')));
      await sleep(150);

      await db().documentCollaborator.update({ where: where(id, editor.id), data: { role: 'VIEWER' } });
      const run = local.recheck();
      await sleep(400);
      // The role is a Viewer's by the row, and the connection has not turned: it is still handling.
      expect(connection.readOnly).toBe(false);
      expect(held.getArray('changes').length).toBe(0);
      release();
      await run;
      expect(held.getArray('changes').toArray()).toEqual(['received as an Editor']);
      expect(connection.readOnly).toBe(true);

      // After the switch nothing is taken.
      sockets.editor.socket.webSocket!.send(sent(id, SYNC, 2, forgedUpdate('sent after the switch')));
      await sleep(300);
      expect(held.getArray('changes').toArray()).toEqual(['received as an Editor']);
    } finally {
      await local.stop();
    }
  });

  it('switches all the same when its messages do not finish within the bound, and discards what still waits', async () => {
    const local = await inProcess({ pendingWaitMs: 200 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id, editor, sockets, clients } = await three(local);
      const held = local.hocuspocus.documents.get(id)!;
      const connection = connectionOf(local, id, editor.id)!;
      const release = gated(connection);
      sockets.editor.socket.webSocket!.send(sent(id, SYNC, 2, forgedUpdate('never finished')));
      await sleep(150);

      await db().documentCollaborator.update({ where: where(id, editor.id), data: { role: 'VIEWER' } });
      const started = Date.now();
      await local.recheck();
      // Made read-only at the bound, and not held back for as long as the client keeps the connection busy.
      expect(Date.now() - started).toBeLessThan(2000);
      expect(connection.readOnly).toBe(true);
      expect(connection.context.role).toBe('viewer');
      await until(() => clients.editor.notices.length === 2);
      expect(readRoleNotice(clients.editor.notices[1]!)).toEqual({ role: 'viewer', canEdit: false });
      expect(logged.mock.calls.some(([line]) => String(line).includes('a downgrade did not wait'))).toBe(
        true,
      );
      // What was still waiting finds the flag turned: it is discarded.
      release();
      await sleep(300);
      expect(held.getArray('changes').length).toBe(0);
    } finally {
      await local.stop();
    }
  });

  it('does not make a read-only connection editable at the bound, and makes it so at the next look', async () => {
    const local = await inProcess({ pendingWaitMs: 200 });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { id, viewer, clients } = await three(local);
      const connection = connectionOf(local, id, viewer.id)!;
      const waiting = vi.spyOn(connection, 'waitForPendingMessages').mockReturnValue(new Promise(() => {}));
      await db().documentCollaborator.update({ where: where(id, viewer.id), data: { role: 'EDITOR' } });
      await local.recheck();
      // Still read-only, as a Viewer, and told nothing.
      expect(connection.readOnly).toBe(true);
      expect(connection.context.role).toBe('viewer');
      expect(clients.viewer.notices).toHaveLength(1);
      // Its messages are handled at the next look: now it is made editable.
      waiting.mockRestore();
      await local.recheck();
      expect(connection.readOnly).toBe(false);
      expect(connection.context.role).toBe('editor');
      await until(() => clients.viewer.notices.length === 2);
      // One line said that it waited, and it names no one.
      expect(logged.mock.calls).toEqual([
        ['collab: an upgrade waits for the next look: the connection still holds messages'],
      ]);
    } finally {
      await local.stop();
    }
  });

  it('does not let a connection that waits hold back the close of another connection in the same run', async () => {
    const local = await inProcess();
    try {
      const { id, editor, viewer, sockets } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      // The Editor's connection never finishes its message, for the whole of the 1,000 ms of the bound.
      vi.spyOn(connection, 'waitForPendingMessages').mockReturnValue(new Promise(() => {}));
      await db().documentCollaborator.update({ where: where(id, editor.id), data: { role: 'VIEWER' } });
      await db().documentCollaborator.delete({ where: where(id, viewer.id) });
      const started = Date.now();
      const run = local.recheck();
      // The Viewer is closed at once, and not after the Editor's wait.
      await until(() => sockets.viewer.closedFor(id, REFUSAL.ACCESS_ENDED), 700);
      expect(Date.now() - started).toBeLessThan(900);
      await run;
      expect(connection.readOnly).toBe(true);
    } finally {
      await local.stop();
    }
  });
});
