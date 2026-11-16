// How the editor's connection sends what is typed (src/lib/collab/client.ts;
// the owner's decision of 12 October 2026): at once while the rate is
// ordinary, in one message for each 250 ms where it is not, so that no key a
// person holds can reach the 600 messages a minute of the server. The real
// class and the real provider run here over a socket that records what is
// sent, with the clock faked; nothing is a server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { BATCH_MS, BURST_MESSAGES, DocumentConnection, syncStatus } from '../../src/lib/collab/client.ts';

const ID = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
// The frames of the socket: the name of the document behind its length (36
// characters, so one byte), the type of the message (0 is a synchronisation),
// and for a synchronisation its step (0 and 1 the steps, 2 an update).
const SYNC = 0;
const UPDATE = 2;

const varint = (value: number): number[] => {
  const bytes = [];
  for (; value > 127; value = Math.floor(value / 128)) bytes.push(128 | (value % 128));
  return [...bytes, value];
};
const toFrame = (...rest: number[]) =>
  new Uint8Array([ID.length, ...new TextEncoder().encode(ID), ...rest]).buffer;

/** A socket that opens by itself and records what is sent; `receive` plays the server. */
class Socket extends EventTarget {
  static all: Socket[] = [];
  readyState = 0;
  binaryType = 'blob';
  readonly sent: Uint8Array[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    Socket.all.push(this);
    setTimeout(() => {
      this.readyState = 1;
      this.dispatchEvent(new Event('open'));
    }, 0);
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  receive(data: ArrayBuffer) {
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
  get updates(): Uint8Array[] {
    return this.sent.filter((frame) => frame[ID.length + 1] === SYNC && frame[ID.length + 2] === UPDATE);
  }
}

/** The update inside a frame that carries one. */
function inside(frame: Uint8Array): Uint8Array {
  let at = ID.length + 3;
  let length = 0;
  for (let shift = 0; ; shift += 7) {
    const byte = frame[at++]!;
    length += (byte & 127) * 2 ** shift;
    if (byte < 128) break;
  }
  return frame.slice(at, at + length);
}

/** A connection that has opened its document: the server has answered the first step and acknowledged. */
async function opened() {
  const connection = new DocumentConnection({
    url: 'ws://example.invalid/collab',
    documentId: ID,
    errorAfterMs: 60_000,
    probe: async () => 200,
    WebSocketPolyfill: Socket,
  });
  connection.start();
  await vi.advanceTimersByTimeAsync(10);
  const socket = Socket.all.at(-1)!;
  socket.receive(new Uint8Array([9]).buffer); // a ping: the socket is taken for connected
  socket.receive(authenticated('read-write')); // the scope of the handshake (an Editor's)
  socket.receive(toFrame(SYNC, 1, ...varint(2), ...Y.encodeStateAsUpdate(new Y.Doc())));
  socket.receive(toFrame(8, 1)); // the acknowledgement of our second step
  await vi.advanceTimersByTimeAsync(0);
  expect(connection.getState()).toMatchObject({ phase: 'connected', unsent: false });
  // The first step of the opening cost a token; the bucket is full again.
  await vi.advanceTimersByTimeAsync(BATCH_MS);
  socket.sent.length = 0;
  const changes = connection.document.getArray<string>('changes');
  return { connection, socket, changes };
}

/** What the server would hold of the updates a socket was sent. */
function serverCopy(socket: Socket): Y.Array<string> {
  const server = new Y.Doc();
  for (const frame of socket.updates) Y.applyUpdate(server, inside(frame));
  return server.getArray<string>('changes');
}

/** Types `count` changes spaced `every` ms apart, each a transaction of its own. */
async function type(changes: Y.Array<string>, count: number, every: number) {
  for (let n = 0; n < count; n += 1) {
    changes.push([`key ${n}`]);
    await vi.advanceTimersByTimeAsync(every);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('ordinary typing is sent at once (SRS 2.4: Yjs sync propagation, P50 under 150 ms)', () => {
  it('sends 5 changes a second for 3 seconds as 15 messages, each in the tick of its change', async () => {
    const { connection, socket, changes } = await opened();
    for (let n = 0; n < 15; n += 1) {
      changes.push([`key ${n}`]);
      // Without advancing the clock: nothing waited for a timer.
      expect(socket.updates).toHaveLength(n + 1);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(serverCopy(socket).toArray()).toHaveLength(15);
    connection.stop();
  });

  it('sends a burst of as many keys as the bucket holds at once, and no more', async () => {
    const { connection, socket, changes } = await opened();
    for (let n = 0; n < BURST_MESSAGES; n += 1) changes.push([`key ${n}`]);
    expect(socket.updates).toHaveLength(BURST_MESSAGES);
    changes.push(['the ninth']);
    expect(socket.updates).toHaveLength(BURST_MESSAGES);
    // The ninth waits for its batch, and is sent when the delay has passed.
    await vi.advanceTimersByTimeAsync(BATCH_MS - 1);
    expect(socket.updates).toHaveLength(BURST_MESSAGES);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.updates).toHaveLength(BURST_MESSAGES + 1);
    connection.stop();
  });
});

describe('a burst is merged: 8 at once and then 4 a second, and every change arrives', () => {
  it('sends 60 changes made in a second as at most 8 + 4 messages, and all 60 reach the server', async () => {
    const { connection, socket, changes } = await opened();
    await type(changes, 60, 16);
    await vi.advanceTimersByTimeAsync(BATCH_MS);
    expect(socket.updates.length).toBeLessThanOrEqual(BURST_MESSAGES + 4 + 1);
    expect(socket.updates.length).toBeGreaterThan(BURST_MESSAGES);
    expect(serverCopy(socket).toArray()).toEqual(Array.from({ length: 60 }, (_, n) => `key ${n}`));
    connection.stop();
  });

  it('sends at once again when the rate has fallen back', async () => {
    const { connection, socket, changes } = await opened();
    await type(changes, 60, 16);
    await vi.advanceTimersByTimeAsync(2 * BATCH_MS * BURST_MESSAGES); // the bucket is full again
    const before = socket.updates.length;
    for (let n = 0; n < BURST_MESSAGES; n += 1) {
      changes.push([`after ${n}`]);
      expect(socket.updates).toHaveLength(before + n + 1);
    }
    connection.stop();
  });
});

describe('the most a tab sends in a minute is 248 update messages, whatever the keys do', () => {
  const MINUTE_BOUND = BURST_MESSAGES + 60_000 / BATCH_MS;
  // Each pattern is a list of the gaps between changes, in ms, repeated for a minute.
  const patterns: Record<string, number[]> = {
    'a key held at 30 a second': [33],
    'a key held at 100 a second': [10],
    'bursts of 9 changes in 90 ms each second, around the rate of the bucket': [
      10, 10, 10, 10, 10, 10, 10, 10, 10, 910,
    ],
    'bursts of 8 and a pause, which is the rate of ordinary typing': [5, 5, 5, 5, 5, 5, 5, 5, 960],
    '5 keys a second': [200],
  };
  for (const [name, gaps] of Object.entries(patterns)) {
    it(`holds for ${name}`, { timeout: 60_000 }, async () => {
      const { connection, socket, changes } = await opened();
      let made = 0;
      for (let at = 0, n = 0; at < 60_000; n += 1) {
        const gap = gaps[n % gaps.length]!;
        changes.push([`key ${made++}`]);
        await vi.advanceTimersByTimeAsync(gap);
        at += gap;
      }
      expect(socket.updates.length).toBeLessThanOrEqual(MINUTE_BOUND);
      // Two tabs of one account, both held: under the 600 of the server.
      expect(2 * socket.updates.length).toBeLessThan(600);
      // And nothing is lost: what is sent is every change.
      await vi.advanceTimersByTimeAsync(BATCH_MS);
      expect(serverCopy(socket).length).toBe(made);
      connection.stop();
    });
  }

  it(
    'is 248 for a key held at 30 a second: the bound is nearly reached, not far under it',
    { timeout: 60_000 },
    async () => {
      const { connection, socket, changes } = await opened();
      await type(changes, 1800, 33);
      expect(socket.updates.length).toBeGreaterThan(200);
      expect(socket.updates.length).toBeLessThanOrEqual(MINUTE_BOUND);
      connection.stop();
    },
  );
});

describe('a change that waits is sent when the page goes', () => {
  /** A page whose events the test makes. */
  function page() {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    return { window, document };
  }
  async function waiting() {
    const here = page();
    const open = await opened();
    for (let n = 0; n < BURST_MESSAGES; n += 1) open.changes.push([`key ${n}`]);
    open.changes.push(['the last, waiting']);
    expect(open.socket.updates).toHaveLength(BURST_MESSAGES);
    return { ...here, ...open };
  }

  it('on pagehide', async () => {
    const { window, socket, connection } = await waiting();
    window.dispatchEvent(new Event('pagehide'));
    expect(socket.updates).toHaveLength(BURST_MESSAGES + 1);
    expect(serverCopy(socket).toArray().at(-1)).toBe('the last, waiting');
    connection.stop();
  });

  it('when the page becomes hidden, and not when it becomes visible', async () => {
    const { document, socket, connection } = await waiting();
    document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.updates).toHaveLength(BURST_MESSAGES);
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(socket.updates).toHaveLength(BURST_MESSAGES + 1);
    connection.stop();
  });

  it('when the connection is stopped, which is what a page that is left does', async () => {
    const { window, document, socket, connection } = await waiting();
    const removed = vi.spyOn(window, 'removeEventListener');
    const removedFromDocument = vi.spyOn(document, 'removeEventListener');
    expect(socket.updates).toHaveLength(BURST_MESSAGES);
    connection.stop();
    expect(socket.updates).toHaveLength(BURST_MESSAGES + 1);
    expect(serverCopy(socket).toArray().at(-1)).toBe('the last, waiting');
    // The listeners are removed with the connection.
    expect(removed).toHaveBeenCalledWith('pagehide', expect.any(Function));
    expect(removedFromDocument).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
  });
});

describe('a change that waits for its batch does not turn the indicator to syncing', () => {
  it('shows "In sync" while it waits, and "syncing" only for a message that is sent and not yet acknowledged', async () => {
    const { connection, socket, changes } = await opened();
    // The bucket is emptied, and the server acknowledges each message.
    for (let n = 0; n < BURST_MESSAGES; n += 1) changes.push([`key ${n}`]);
    for (let n = 0; n < BURST_MESSAGES; n += 1) socket.receive(toFrame(8, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(syncStatus(connection.getState())).toEqual({ state: 'synced', label: 'In sync' });

    const seen: string[] = [];
    connection.subscribe(() => seen.push(syncStatus(connection.getState()).label));
    changes.push(['waits']);
    await vi.advanceTimersByTimeAsync(BATCH_MS - 1);
    // Nothing was sent, and nothing was shown.
    expect(socket.updates).toHaveLength(BURST_MESSAGES);
    expect(seen).toEqual([]);
    expect(connection.getState().unsent).toBe(false);

    // Sent: not acknowledged yet, so the words say that it could be lost.
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.updates).toHaveLength(BURST_MESSAGES + 1);
    expect(connection.getState().unsent).toBe(true);
    expect(syncStatus(connection.getState())).toEqual({
      state: 'syncing',
      label: 'Syncing. Changes that are not yet sent are lost if this tab is closed.',
    });
    socket.receive(toFrame(8, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(syncStatus(connection.getState())).toEqual({ state: 'synced', label: 'In sync' });
    connection.stop();
  });

  it('shows only "In sync" and "Syncing" while a key is held, and never the restoring or the error words', async () => {
    const { connection, socket, changes } = await opened();
    const shown = new Set<string>();
    connection.subscribe(() => shown.add(syncStatus(connection.getState()).label));
    // 10 seconds at 30 a second, and the server acknowledges each message 40 ms after it.
    for (let n = 0; n < 300; n += 1) {
      const heard = socket.updates.length;
      changes.push([`key ${n}`]);
      await vi.advanceTimersByTimeAsync(33);
      if (socket.updates.length > heard) {
        setTimeout(() => socket.receive(toFrame(8, 1)), 40);
      }
    }
    await vi.advanceTimersByTimeAsync(BATCH_MS + 100);
    expect([...shown].sort()).toEqual([
      'In sync',
      'Syncing. Changes that are not yet sent are lost if this tab is closed.',
    ]);
    connection.stop();
  });
});

// The types of the frames the server sends (@hocuspocus/server, types.ts).
const AUTH = 2;
const STATELESS = 5;
/** A frame that says the server refused this document, and why. */
const refusal = (reason: string) => toFrame(AUTH, 1, reason.length, ...new TextEncoder().encode(reason));
/** A frame that says the server accepted this document, with its scope: `read-write` or `readonly`. */
function authenticated(scope: 'read-write' | 'readonly') {
  return toFrame(AUTH, 2, scope.length, ...new TextEncoder().encode(scope));
}
/** A frame that carries a stateless message from the server. */
const stateless = (payload: string) => {
  const text = new TextEncoder().encode(payload);
  return toFrame(STATELESS, ...varint(text.length), ...text);
};
/** The frames this socket sent that ask the server to open the document: authentication by a token. */
const openings = (socket: Socket) => socket.sent.filter((frame) => frame[ID.length + 1] === AUTH);
/** The frames that ask the server for what it holds: the first step of a synchronisation. */
const asks = (socket: Socket) =>
  socket.sent.filter((frame) => frame[ID.length + 1] === SYNC && frame[ID.length + 2] === 0);

describe('a document at its limit of ten connections (FR-ED-18, NFR-PE-05)', () => {
  /** A connection that the server has refused for the limit. */
  async function refused() {
    const connection = new DocumentConnection({
      url: 'ws://example.invalid/collab',
      documentId: ID,
      errorAfterMs: 60_000,
      probe: async () => 200,
      WebSocketPolyfill: Socket,
    });
    connection.start();
    await vi.advanceTimersByTimeAsync(10);
    const socket = Socket.all.at(-1)!;
    socket.receive(new Uint8Array([9]).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(openings(socket)).toHaveLength(1);
    socket.receive(refusal('capacity'));
    await vi.advanceTimersByTimeAsync(0);
    return { connection, socket };
  }

  it('shows the statement and neither the restoring state nor the error state, however long it lasts', async () => {
    const { connection } = await refused();
    expect(connection.getState()).toMatchObject({ phase: 'capacity', opened: false });
    // The error state comes after `errorAfterMs` of a lost connection; this one is not lost.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(connection.getState().phase).toBe('capacity');
    connection.stop();
  });

  it('asks again every 30 seconds, and not once before', async () => {
    const { connection, socket } = await refused();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(openings(socket)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(openings(socket)).toHaveLength(2);
    // Refused again: the next try is 30 seconds after this one.
    socket.receive(refusal('capacity'));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(openings(socket)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(openings(socket)).toHaveLength(3);
    expect(connection.getState().phase).toBe('capacity');
    connection.stop();
  });

  it('opens the document when a place is free at the next try, and shows the state of a connection that is open', async () => {
    const { connection, socket } = await refused();
    await vi.advanceTimersByTimeAsync(30_000);
    socket.receive(toFrame(SYNC, 1, ...varint(2), ...Y.encodeStateAsUpdate(new Y.Doc())));
    socket.receive(toFrame(8, 1));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState()).toMatchObject({ phase: 'connected', opened: true });
    connection.stop();
  });
});

describe('the permissions of the role of an open connection change (FR-ED-40 (g))', () => {
  const permissions = (role: unknown) => JSON.stringify({ kind: 'permissions', role });

  it('is kept in the state, counted so that each is stated, and changes nothing else of the connection', async () => {
    const { connection, socket } = await opened();
    expect(connection.getState().permissions).toBeUndefined();
    const before = connection.getState();
    socket.receive(stateless(permissions('editor')));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().permissions).toEqual({ role: 'editor', changes: 1 });
    socket.receive(stateless(permissions('editor')));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().permissions).toEqual({ role: 'editor', changes: 2 });
    // Nothing is closed, switched, or said of the role, and no request for the server's state is made.
    expect(connection.getState()).toMatchObject({
      phase: before.phase,
      canEdit: before.canEdit,
      opened: true,
    });
    expect(connection.getState().notice).toBeUndefined();
    expect(asks(socket)).toHaveLength(0);
    connection.stop();
  });

  it('is taken away when the role changes: the statement of the new role says what it may do', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(permissions('editor')));
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(stateless(JSON.stringify({ kind: 'role', role: 'viewer', canEdit: false })));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().permissions).toBeUndefined();
    expect(connection.getState().notice).toEqual({ role: 'viewer', canEdit: false });
    connection.stop();
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['another kind', JSON.stringify({ kind: 'other', role: 'editor' })],
    ['a role that is not one', permissions('king')],
    ['no role', JSON.stringify({ kind: 'permissions' })],
    ['a field more', JSON.stringify({ kind: 'permissions', role: 'editor', permissions: [] })],
    ['an array', '[1]'],
    ['null', 'null'],
  ])('is ignored where it is %s', async (_, payload) => {
    const { connection, socket } = await opened();
    socket.receive(stateless(payload));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().permissions).toBeUndefined();
    expect(connection.getState().phase).toBe('connected');
    connection.stop();
  });
});

describe('the role of an open connection changes (FR-ED-40 (b), FR-ED-41)', () => {
  const notice = (role: string, canEdit: unknown) => JSON.stringify({ kind: 'role', role, canEdit });

  it('is kept in the state, and read-only means no request for the server’s state', async () => {
    const { connection, socket } = await opened();
    expect(connection.getState().notice).toBeUndefined();
    socket.receive(stateless(notice('viewer', false)));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().notice).toEqual({ role: 'viewer', canEdit: false });
    expect(asks(socket)).toHaveLength(0);
    connection.stop();
  });

  it('asks the server for its state where the connection may edit again, so that what a later change depends on is sent', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(notice('viewer', false)));
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(stateless(notice('editor', true)));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().notice).toEqual({ role: 'editor', canEdit: true });
    expect(asks(socket)).toHaveLength(1);
    connection.stop();
  });

  it.each([
    ['text that is not JSON', 'not json'],
    ['another kind', JSON.stringify({ kind: 'other', role: 'viewer', canEdit: false })],
    ['a role that is not one', notice('king', true)],
    ['a flag that is not one', notice('editor', 'yes')],
    ['a field more', JSON.stringify({ kind: 'role', role: 'editor', canEdit: true, extra: 1 })],
    ['a field fewer', JSON.stringify({ kind: 'role', role: 'editor' })],
    ['an array', '[1]'],
    ['null', 'null'],
  ])('is ignored where it is %s', async (_, payload) => {
    const { connection, socket } = await opened();
    socket.receive(stateless(payload));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().notice).toBeUndefined();
    expect(connection.getState().phase).toBe('connected');
    expect(asks(socket)).toHaveLength(0);
    connection.stop();
  });

  // A socket that was lost and opened again by the library is accepted again, with the scope the role holds
  // then: the server's re-check, which saw no change, sends no notice for it.
  describe('after a reconnection', () => {
    it('is editable or read-only as the scope of the new handshake says, in either direction, and says the role', async () => {
      const { connection, socket } = await opened();
      expect(connection.getState().canEdit).toBe(true);

      // An Editor whose role was taken while the laptop slept.
      socket.receive(authenticated('readonly'));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState().canEdit).toBe(false);
      socket.receive(stateless(notice('viewer', false)));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState()).toMatchObject({
        canEdit: false,
        notice: { role: 'viewer', canEdit: false },
      });
      // The library synchronises after a reconnection itself: no request is added.
      expect(asks(socket)).toHaveLength(0);

      // A Viewer who was made an Editor while away, and is not left read-only until the page is reloaded.
      socket.receive(authenticated('read-write'));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState().canEdit).toBe(true);
      // The statement that no longer holds is taken away at once.
      expect(connection.getState().notice).toBeUndefined();
      socket.receive(stateless(notice('editor', true)));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState()).toMatchObject({
        canEdit: true,
        notice: { role: 'editor', canEdit: true },
      });
      connection.stop();
    });

    it('says nothing where the role is what the tab showed', async () => {
      const { connection, socket } = await opened();
      for (let times = 0; times < 2; times++) {
        socket.receive(authenticated('read-write'));
        socket.receive(stateless(notice('editor', true)));
        await vi.advanceTimersByTimeAsync(0);
        expect(connection.getState()).toMatchObject({ canEdit: true });
        expect(connection.getState().notice).toBeUndefined();
      }
      connection.stop();
    });

    it('says a change from one role that cannot edit to another', async () => {
      const { connection, socket } = await opened();
      socket.receive(authenticated('readonly'));
      socket.receive(stateless(notice('viewer', false)));
      await vi.advanceTimersByTimeAsync(0);
      socket.receive(authenticated('readonly'));
      socket.receive(stateless(notice('reviewer', false)));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState().notice).toEqual({ role: 'reviewer', canEdit: false });
      connection.stop();
    });
  });

  it('is gone with the connection: a new one is told its role afresh', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(notice('viewer', false)));
    await vi.advanceTimersByTimeAsync(0);
    connection.stop();
    connection.start();
    expect(connection.getState().notice).toBeUndefined();
    connection.stop();
  });
});

describe('what the server says of its store (D294)', () => {
  it('is held from the notice, taken away by a notice that it stored, and by a lost socket', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(JSON.stringify({ kind: 'store', stored: false })));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unstored).toBe(true);
    expect(syncStatus(connection.getState()).state).toBe('syncing');
    socket.receive(stateless(JSON.stringify({ kind: 'store', stored: true })));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unstored).toBe(false);
    expect(syncStatus(connection.getState())).toEqual({ state: 'synced', label: 'In sync' });
    connection.stop();
  });
});

/** A paragraph of the document as the editor's binding writes one. */
function paragraphOf(text: string): Y.XmlElement {
  const element = new Y.XmlElement('paragraph');
  const body = new Y.XmlText();
  element.insert(0, [body]);
  body.insert(0, text);
  return element;
}

describe('the words of changes the server did not take (F14-2)', () => {
  const viewer = JSON.stringify({ kind: 'role', role: 'viewer', canEdit: false });
  const editor = JSON.stringify({ kind: 'role', role: 'editor', canEdit: true });
  /** The server's acknowledgement of one message that carried an update. */
  const acknowledge = (socket: Socket) => socket.receive(toFrame(8, 1));

  /** A tab with a paragraph the server acknowledged. */
  async function acknowledged() {
    const { connection, socket } = await opened();
    const fragment = connection.document.getXmlFragment('default');
    const first = paragraphOf('Kept. ');
    fragment.insert(0, [first]);
    await vi.advanceTimersByTimeAsync(0);
    acknowledge(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsent).toBe(false);
    return { connection, socket, fragment, first, text: first.get(0) as Y.XmlText };
  }

  it('keeps the words typed after the last acknowledgement when the role becomes one that cannot edit', async () => {
    const { connection, socket, text } = await acknowledged();
    text.insert(6, 'Typed as an Editor.');
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsent).toBe(true);
    expect(connection.getState().unsaved).toBeUndefined();

    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState()).toMatchObject({
      canEdit: false,
      notice: { role: 'viewer', canEdit: false },
      // Only what was not acknowledged: the paragraph before it is the server's.
      unsaved: { text: 'Typed as an Editor.' },
    });
    connection.stop();
  });

  it('keeps the words that waited for their batch in the tab, which the server was never sent', async () => {
    const { connection, socket, text } = await acknowledged();
    // Eight keys use the bucket, and the ninth waits 250 ms for its batch.
    for (let key = 0; key < BURST_MESSAGES; key += 1) text.insert(text.length, 'x');
    text.insert(text.length, ' waiting');
    await vi.advanceTimersByTimeAsync(0);
    const sentBefore = socket.updates.length;
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved?.text).toBe('xxxxxxxx waiting');
    // The server took none of it, and the tab is not sending any more that waits.
    expect(socket.updates.length).toBe(sentBefore);
    connection.stop();
  });

  it('says nothing of unsaved words where the server acknowledged everything before it told the role', async () => {
    const { connection, socket, text } = await acknowledged();
    text.insert(6, 'Typed and taken.');
    await vi.advanceTimersByTimeAsync(0);
    acknowledge(socket);
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsent).toBe(false);
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().notice).toEqual({ role: 'viewer', canEdit: false });
    expect(connection.getState().unsaved).toBeUndefined();
    connection.stop();
  });

  it('keeps a change that was not words as unsaved with no words to copy', async () => {
    const { connection, socket, text } = await acknowledged();
    text.delete(0, 3);
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toEqual({ text: '' });
    connection.stop();
  });

  it('offers the words typed while the socket was lost, when the new handshake says the role cannot edit', async () => {
    const { connection, socket, text } = await acknowledged();
    text.insert(6, 'Typed offline.');
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(authenticated('readonly'));
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState()).toMatchObject({ canEdit: false, unsaved: { text: 'Typed offline.' } });
    connection.stop();
  });

  // The library sets its count of unacknowledged messages to 1 at every (re)connection, for the answer
  // to its first step, whether or not a change waits: the count cannot say that the tab holds one.
  it('says nothing of unsaved words where the tab reconnects with every change acknowledged', async () => {
    const { connection, socket } = await acknowledged();
    (connection as unknown as { provider: { forceSync(): void } }).provider.forceSync();
    expect(connection.getState().unsent).toBe(true);
    socket.receive(authenticated('readonly'));
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState()).toMatchObject({
      canEdit: false,
      notice: { role: 'viewer', canEdit: false },
    });
    expect(connection.getState().unsaved).toBeUndefined();
    connection.stop();
  });

  // The provider counts a batch, and a status of 0 does not lower the count: a count that is not zero
  // cannot say which of several messages the server took.
  it('offers only what the server refused where it applied one change and refused the next, which the count cannot tell', async () => {
    const { connection, socket, text } = await acknowledged();
    text.insert(6, 'Taken. ');
    await vi.advanceTimersByTimeAsync(0);
    text.insert(13, 'Refused.');
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.updates).toHaveLength(3);
    // The first was applied, the role was taken, and the second reached the server after that.
    acknowledge(socket);
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toEqual({ text: 'Refused.' });
    socket.receive(toFrame(8, 0));
    await vi.advanceTimersByTimeAsync(0);
    // The refusal changes nothing: it is what the tab already offers.
    expect(connection.getState().unsaved).toEqual({ text: 'Refused.' });
    connection.stop();
  });

  it('offers only the second where the server refused it before it told the role', async () => {
    const { connection, socket, text } = await acknowledged();
    text.insert(6, 'Taken. ');
    text.insert(13, 'Refused.');
    await vi.advanceTimersByTimeAsync(0);
    acknowledge(socket);
    socket.receive(toFrame(8, 0));
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toEqual({ text: 'Refused.' });
    connection.stop();
  });

  // The role notice is sent before the answer to the client's second step on a new socket.
  describe('after a reconnection, where the answer to an earlier message was lost with the socket', () => {
    /** A change that the server applied, the socket lost before its status, and the new socket's steps. */
    async function reconnected() {
      const { connection, socket, text } = await acknowledged();
      text.insert(6, 'Applied, status lost.');
      await vi.advanceTimersByTimeAsync(0);
      (connection as unknown as { provider: { forceSync(): void } }).provider.forceSync();
      // The server asks for what the tab holds (an empty state vector: it holds nothing the tab lacks).
      socket.receive(toFrame(SYNC, 0, ...varint(1), 0));
      await vi.advanceTimersByTimeAsync(0);
      socket.receive(authenticated('readonly'));
      socket.receive(stateless(viewer));
      await vi.advanceTimersByTimeAsync(0);
      return { connection, socket };
    }

    it('offers the words until the second step is answered as applied, and then takes the offer back', async () => {
      const { connection, socket } = await reconnected();
      expect(connection.getState().unsaved).toEqual({ text: 'Applied, status lost.' });
      // Nothing new for a read-only server: it applied nothing and says so as applied.
      socket.receive(toFrame(8, 1));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState().unsaved).toBeUndefined();
      expect(connection.getState().notice).toEqual({ role: 'viewer', canEdit: false });
      connection.stop();
    });

    it('keeps the offer where the second step is refused', async () => {
      const { connection, socket } = await reconnected();
      socket.receive(toFrame(8, 0));
      await vi.advanceTimersByTimeAsync(0);
      expect(connection.getState().unsaved).toEqual({ text: 'Applied, status lost.' });
      connection.stop();
    });
  });

  it('takes the statement away when the connection may edit again, which sends what the tab holds', async () => {
    const { connection, socket, text } = await acknowledged();
    text.insert(6, 'Typed as an Editor.');
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toBeDefined();
    socket.receive(stateless(editor));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toBeUndefined();
    expect(connection.getState().notice).toEqual({ role: 'editor', canEdit: true });
    expect(asks(socket)).toHaveLength(1);
    connection.stop();
  });

  it('does not keep unsaved words for a tab that never held a change, or for a change of one reader’s role to another', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(viewer));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toBeUndefined();
    socket.receive(stateless(JSON.stringify({ kind: 'role', role: 'reviewer', canEdit: false })));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().unsaved).toBeUndefined();
    connection.stop();
  });
});

describe('who has the document open (FR-ED-17)', () => {
  const list = (people: unknown) => JSON.stringify({ kind: 'people', people });

  it('is kept as the server last said it, and the next list replaces it', async () => {
    const { connection, socket } = await opened();
    expect(connection.getState().people).toBeUndefined();
    socket.receive(stateless(list([{ slot: 1, name: 'Ada Owner', role: 'owner', you: true }])));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().people).toEqual([{ slot: 1, name: 'Ada Owner', role: 'owner', you: true }]);
    socket.receive(stateless(list([])));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().people).toEqual([]);
    // Nothing else of the connection moved.
    expect(connection.getState()).toMatchObject({ phase: 'connected', canEdit: true });
    expect(connection.getState().notice).toBeUndefined();
    connection.stop();
  });

  it.each([
    ['a slot past the colours', list([{ slot: 11, name: 'x' }])],
    ['a field more', list([{ slot: 1, name: 'x', email: 'a@b' }])],
    ['a role that is not one', list([{ slot: 1, name: 'x', role: 'admin' }])],
    ['not a list', list('Ada')],
  ])('keeps the last list where the next is %s', async (_, payload) => {
    const { connection, socket } = await opened();
    socket.receive(stateless(list([{ slot: 2, name: 'Ben Editor' }])));
    await vi.advanceTimersByTimeAsync(0);
    socket.receive(stateless(payload));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().people).toEqual([{ slot: 2, name: 'Ben Editor' }]);
    connection.stop();
  });

  it('is taken away when the connection is lost for good, and told afresh when it returns', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(list([{ slot: 1, name: 'Ada Owner' }])));
    await vi.advanceTimersByTimeAsync(0);
    expect(connection.getState().people).toHaveLength(1);
    // The socket is lost, and not restored within the period of the error state (FR-ED-23).
    socket.readyState = 3;
    socket.dispatchEvent(Object.assign(new Event('close'), { code: 1006, reason: '' }));
    await vi.advanceTimersByTimeAsync(59_000);
    expect(connection.getState().phase).toBe('restoring');
    expect(connection.getState().people).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(connection.getState().phase).toBe('lost');
    expect(connection.getState().people).toBeUndefined();
    connection.stop();
  });

  it('is gone with the connection: a new one is told afresh', async () => {
    const { connection, socket } = await opened();
    socket.receive(stateless(list([{ slot: 1, name: 'Ada Owner' }])));
    await vi.advanceTimersByTimeAsync(0);
    connection.stop();
    connection.start();
    expect(connection.getState().people).toBeUndefined();
    connection.stop();
  });
});

describe('awareness (FR-ED-17)', () => {
  it('is the provider’s own once the connection is started, and says nothing of this client but its cursor', async () => {
    const connection = new DocumentConnection({
      url: 'ws://example.invalid/collab',
      documentId: ID,
      errorAfterMs: 60_000,
      probe: async () => 200,
      WebSocketPolyfill: Socket,
    });
    expect(connection.awareness).toBeNull();
    connection.start();
    expect(connection.awareness).not.toBeNull();
    // The name and the colour are the server's: the client says neither.
    expect(connection.awareness!.getLocalState()).toEqual({});
    connection.stop();
  });
});
