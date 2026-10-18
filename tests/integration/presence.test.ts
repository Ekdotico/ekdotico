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
const { COLLAB_PATH, REFUSAL, readRoleNotice } = await import('../../src/lib/collab/protocol.ts');
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
    const notices: string[] = [];
    provider.on('stateless', ({ payload }: { payload: string }) => notices.push(payload));
    provider.attach();
    return { provider, outcome, synced, notices, changes: provider.document.getArray<string>('changes') };
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
async function inProcess(options: { connectionsPerDocument?: number; recheckMs?: number } = {}) {
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
      const notice = await until(() => clients.editor.notices.at(-1));
      expect(readRoleNotice(notice)).toEqual({ role: 'viewer', canEdit: false });

      // What it sends now is discarded (NFR-SE-03 (a)): an update, as a frame past the editor's own controls.
      sockets.editor.socket.webSocket!.send(sent(id, SYNC, 2, forgedUpdate('written as a Viewer')));
      await sleep(300);
      expect(held.getArray('changes').toArray()).toEqual(['written as an Editor']);
      // The others are told nothing.
      expect(clients.owner.notices).toEqual([]);
      expect(clients.viewer.notices).toEqual([]);

      // An Editor again: editable in place, told, and what it writes now is applied.
      await db().documentCollaborator.update({
        where: { documentId_userId: { documentId: id, userId: editor.id } },
        data: { role: 'EDITOR' },
      });
      await local.recheck();
      expect(connectionOf(local, id, editor.id)).toBe(connection);
      expect(connection.readOnly).toBe(false);
      expect(connection.context.role).toBe('editor');
      await until(() => clients.editor.notices.length === 2);
      expect(readRoleNotice(clients.editor.notices[1]!)).toEqual({ role: 'editor', canEdit: true });
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
      for (const each of Object.values(clients)) expect(each.notices).toEqual([]);
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
      vi.spyOn(db().session, 'findMany').mockRejectedValueOnce(quoting);
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
});
