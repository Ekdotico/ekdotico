// What the events of FR-ED-40 (a), (b), (d) do to an open connection (NFR-SE-03
// (b) to (d); FR-AU-27, FR-AU-84): a removal, a leave, a change of role, and the
// end of a session act on every matching connection WITHIN 5 SECONDS of the
// change being committed, by the notice on the channel and not by the re-check,
// whose period is made an hour here so that nothing but an event can act.
//
// The real collaboration server in this process, the real provider of the
// editor over Node's own WebSocket, the application's own routes and
// endpoints, the real database and Valkey. One server for each test.
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from './channel.ts';
import { cookiesOf, createAccount, load, ORIGIN, post, prepare, signIn } from './identity.ts';

const database = prepare('collabevents', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey, settings } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { COLLAB_PATH, REFUSAL, readRoleNotice } = await import('../../src/lib/collab/protocol.ts');
const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
const { createCollabServer } = await import('../../src/collab/server.ts');
const one = await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
const leaving = await import('../../src/app/api/documents/[id]/leave/route.ts');

/** What the requirements allow between the commit of a change and its effect on a connection. */
const FIVE_SECONDS = 5000;

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
const CLOSE = 7;
/** The rest of the frame that closes a document's connection: the reason. */
const closedBecause = (reason: string) =>
  Buffer.from([reason.length, ...Buffer.from(reason)]).toString('hex');

// ── Clients ─────────────────────────────────────────────────────────────────

const sockets: HocuspocusProviderWebsocket[] = [];

/** One socket of a signed-in browser, with one document opened on it. */
function connect(port: number, cookie: string, documentId: string) {
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
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: documentId });
  const outcome = new Promise<{ scope?: string; refused?: string }>((resolve) => {
    provider.on('authenticated', ({ scope }: { scope: string }) => resolve({ scope }));
    provider.on('authenticationFailed', ({ reason }: { reason: string }) => resolve({ refused: reason }));
  });
  const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  const notices: string[] = [];
  provider.on('stateless', ({ payload }: { payload: string }) => notices.push(payload));
  provider.attach();
  return {
    socket,
    provider,
    outcome,
    synced,
    notices,
    changes: provider.document.getArray<string>('changes'),
    /** Whether the server closed this document's connection for this reason. */
    closedFor: (reason: string) =>
      frames.some(
        (each) => each.name === documentId && each.type === CLOSE && each.rest === closedBecause(reason),
      ),
    /** Whether the server closed it for any reason. */
    closed: () => frames.some((each) => each.name === documentId && each.type === CLOSE),
  };
}

// ── Accounts and documents ──────────────────────────────────────────────────

let count = 0;
let addresses = 0;
const net = () => ({ 'x-forwarded-for': `10.20.${Math.floor(++addresses / 250)}.${addresses % 250}` });
async function person(name = 'A Person') {
  const email = `events${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email, undefined, net())) };
}
type Person = Awaited<ReturnType<typeof person>>;
/** One more session of the account: a second browser. */
const anotherSession = async (who: Person) => cookiesOf(await signIn(auth, who.email, undefined, net()));

const grant = (documentId: string, who: Person, role: 'EDITOR' | 'VIEWER') =>
  db().documentCollaborator.create({ data: { documentId, userId: who.id, role } });

/** The server in this process. The period of its re-check is an hour, and it hears the channel. */
async function inProcess() {
  const collab = createCollabServer({ ...settings(), limits: settings().limits }, { recheckMs: 3_600_000 });
  await new Promise<void>((resolve) => collab.httpServer.listen(0, resolve));
  await collab.listenForEvents();
  return { ...collab, port: (collab.httpServer.address() as AddressInfo).port };
}
type Local = Awaited<ReturnType<typeof inProcess>>;

const connectionsOf = (local: Local, id: string) =>
  local.hocuspocus.documents.get(id)?.getConnections() ?? [];
const connectionOf = (local: Local, id: string, userId: string) =>
  connectionsOf(local, id).find((each) => each.context.userId === userId);

/** A document with an Owner, an Editor and a Viewer, each with one connection; the rows of the two collaborators. */
async function three(local: Local) {
  const owner = await person('Ada Owner');
  const editor = await person('Ben Editor');
  const viewer = await person('Cy Viewer');
  const id = (await createDocument(owner.id)).id;
  const rows = {
    editor: (await grant(id, editor, 'EDITOR')).id,
    viewer: (await grant(id, viewer, 'VIEWER')).id,
  };
  const clients = {
    owner: connect(local.port, owner.cookie, id),
    editor: connect(local.port, editor.cookie, id),
    viewer: connect(local.port, viewer.cookie, id),
  };
  for (const client of Object.values(clients)) {
    await client.synced;
    // The server tells each connection its role as it is made.
    await until(() => client.notices.length === 1);
  }
  return { id, owner, editor, viewer, rows, clients };
}

// ── What the application does ───────────────────────────────────────────────

const request = (method: string, path: string, cookie: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      origin: ORIGIN,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });
const remove = (cookie: string, id: string, collaboratorId: string) =>
  one.DELETE(
    request('DELETE', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie),
    at({ id, collaboratorId }),
  );
const changeRole = (cookie: string, id: string, collaboratorId: string, role: string) =>
  one.PATCH(
    request('PATCH', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie, { role }),
    at({ id, collaboratorId }),
  );
const leave = (cookie: string, id: string) =>
  leaving.POST(request('POST', `/api/documents/${id}/leave`, cookie), at({ id }));

/** Runs a change, and resolves with the time its effect took from the moment the change had committed (the answer). */
async function within(change: () => Promise<Response>, effect: () => unknown, limit = FIVE_SECONDS) {
  const response = await change();
  expect(response.status).toBeLessThan(300);
  const committed = Date.now();
  await until(effect, limit);
  const took = Date.now() - committed;
  expect(took).toBeLessThan(limit);
  return took;
}

const forger = new Redis(process.env.VALKEY_URL!);
beforeEach(async () => {
  await db().securityLogEntry.deleteMany();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
});
afterAll(async () => {
  forger.disconnect();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

// ── The events ──────────────────────────────────────────────────────────────

describe('a removal and a leave (FR-ED-40 (a); NFR-SE-03 (b))', () => {
  it('closes every connection the removed person holds, as access-ended, within 5 seconds, and no one else’s', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, rows, clients } = await three(local);
      // The same person in a second tab, and the open document of someone else.
      const second = connect(local.port, await anotherSession(editor), id);
      await second.synced;
      expect(connectionsOf(local, id)).toHaveLength(4);

      const took = await within(
        () => remove(owner.cookie, id, rows.editor),
        () => clients.editor.closedFor(REFUSAL.ACCESS_ENDED) && second.closedFor(REFUSAL.ACCESS_ENDED),
      );
      expect(took).toBeLessThan(FIVE_SECONDS);
      // Closed, and their places free; the Owner's and the Viewer's untouched.
      await until(() => connectionsOf(local, id).length === 2);
      expect(local.placesOf(id)).toBe(2);
      await sleep(300);
      expect(clients.owner.closed()).toBe(false);
      expect(clients.viewer.closed()).toBe(false);
      expect(clients.owner.notices).toHaveLength(1);
      expect(clients.viewer.notices).toHaveLength(1);
      // "A removed user's attempt to reconnect fails at the handshake" (NFR-SE-03 (f)).
      const again = connect(local.port, editor.cookie, id);
      expect(await again.outcome).toEqual({ refused: REFUSAL.NO_ACCESS });
    } finally {
      await local.stop();
    }
  });

  it('closes the connections of a collaborator who leaves, within 5 seconds', async () => {
    const local = await inProcess();
    try {
      const { id, viewer, clients } = await three(local);
      await within(
        () => leave(viewer.cookie, id),
        () => clients.viewer.closedFor(REFUSAL.ACCESS_ENDED),
      );
      await until(() => connectionsOf(local, id).length === 2);
      await sleep(300);
      expect(clients.owner.closed()).toBe(false);
      expect(clients.editor.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });

  it('acts on the document of the notice alone: the same person holds another document open and keeps it', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, rows, clients } = await three(local);
      const other = (await createDocument(owner.id)).id;
      await grant(other, editor, 'EDITOR');
      const there = connect(local.port, await anotherSession(editor), other);
      await there.synced;

      await within(
        () => remove(owner.cookie, id, rows.editor),
        () => clients.editor.closedFor(REFUSAL.ACCESS_ENDED),
      );
      await sleep(400);
      expect(there.closed()).toBe(false);
      expect(connectionOf(local, other, editor.id)).toBeDefined();
    } finally {
      await local.stop();
    }
  });
});

describe('a change of role (FR-ED-40 (b); NFR-SE-03 (c))', () => {
  it('makes the connection read-only in place within 5 seconds, tells it once, and makes it editable in place again', async () => {
    const local = await inProcess();
    try {
      const { id, owner, rows, clients, editor } = await three(local);
      const held = local.hocuspocus.documents.get(id)!;
      const connection = connectionOf(local, id, editor.id)!;
      expect(connection.readOnly).toBe(false);
      clients.editor.changes.push(['written as an Editor']);
      await until(() => held.getArray('changes').length === 1);

      await within(
        () => changeRole(owner.cookie, id, rows.editor, 'viewer'),
        () => connection.readOnly,
      );
      // The same connection, still open, now of a Viewer; told once, in the words of the notice.
      expect(connectionOf(local, id, editor.id)).toBe(connection);
      expect(connection.context.role).toBe('viewer');
      await until(() => clients.editor.notices.length === 2);
      expect(readRoleNotice(clients.editor.notices[1]!)).toEqual({ role: 'viewer', canEdit: false });
      expect(clients.editor.closed()).toBe(false);
      // What it sends now is discarded (NFR-SE-03 (a)); the others are told nothing.
      clients.editor.changes.push(['written as a Viewer']);
      await sleep(400);
      expect(held.getArray('changes').toArray()).toEqual(['written as an Editor']);
      expect(clients.owner.notices).toHaveLength(1);
      expect(clients.viewer.notices).toHaveLength(1);

      await within(
        () => changeRole(owner.cookie, id, rows.editor, 'editor'),
        () => !connection.readOnly,
      );
      expect(connection.context.role).toBe('editor');
      await until(() => clients.editor.notices.length === 3);
      expect(readRoleNotice(clients.editor.notices[2]!)).toEqual({ role: 'editor', canEdit: true });
      // Between messages the client asks for the state (the client of slice 14), which the test does by hand.
      clients.editor.provider.forceSync();
      clients.editor.changes.push(['written as an Editor again']);
      await until(() => held.getArray('changes').toArray().includes('written as an Editor again'));
      // One notice for each change, and none was sent twice.
      expect(clients.editor.notices).toHaveLength(3);
    } finally {
      await local.stop();
    }
  });

  it('makes a Viewer who is raised to Editor editable in place, and tells it', async () => {
    const local = await inProcess();
    try {
      const { id, owner, viewer, rows, clients } = await three(local);
      const connection = connectionOf(local, id, viewer.id)!;
      expect(connection.readOnly).toBe(true);
      await within(
        () => changeRole(owner.cookie, id, rows.viewer, 'editor'),
        () => !connection.readOnly,
      );
      await until(() => clients.viewer.notices.length === 2);
      expect(readRoleNotice(clients.viewer.notices[1]!)).toEqual({ role: 'editor', canEdit: true });
    } finally {
      await local.stop();
    }
  });
});

describe('the end of a session (FR-ED-40 (d); NFR-SE-03 (b); FR-AU-84, FR-AU-85)', () => {
  /** An Owner with a document open, and an Editor with it open in two browsers, A and B. */
  async function twoBrowsers(local: Local) {
    const owner = await person('Ada Owner');
    const editor = await person('Ben Editor');
    const id = (await createDocument(owner.id)).id;
    await grant(id, editor, 'EDITOR');
    const cookies = { a: editor.cookie, b: await anotherSession(editor) };
    const clients = {
      owner: connect(local.port, owner.cookie, id),
      a: connect(local.port, cookies.a, id),
      b: connect(local.port, cookies.b, id),
    };
    for (const client of Object.values(clients)) await client.synced;
    return { id, owner, editor, cookies, clients };
  }

  it('closes the connections opened under a session that signed out, as session-ended, within 5 seconds, and only those', async () => {
    const local = await inProcess();
    try {
      const { cookies, clients } = await twoBrowsers(local);
      await within(
        async () => (await post(auth, '/sign-out', undefined, { cookie: cookies.a })).response,
        () => clients.a.closedFor(REFUSAL.SESSION_ENDED),
      );
      await sleep(400);
      expect(clients.b.closed()).toBe(false);
      expect(clients.owner.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });

  it('closes the connections of the sessions revoked, one and all the others, within 5 seconds, and not the session in use', async () => {
    const local = await inProcess();
    try {
      const { editor, cookies, clients, id } = await twoBrowsers(local);
      const rowOfB = (
        await db().session.findMany({ where: { userId: editor.id }, orderBy: { createdAt: 'desc' } })
      )[0]!;
      await within(
        async () => (await post(auth, '/revoke-session', { id: rowOfB.id }, { cookie: cookies.a })).response,
        () => clients.b.closedFor(REFUSAL.SESSION_ENDED),
      );
      await sleep(300);
      expect(clients.a.closed()).toBe(false);

      // And all the others: a third browser, ended by the first.
      const third = connect(local.port, await anotherSession(editor), id);
      await third.synced;
      await within(
        async () => (await post(auth, '/revoke-other-sessions', undefined, { cookie: cookies.a })).response,
        () => third.closedFor(REFUSAL.SESSION_ENDED),
      );
      await sleep(300);
      expect(clients.a.closed()).toBe(false);
      expect(clients.owner.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });

  it('closes the connections of the other sessions when the password is changed, and not that of the session in use', async () => {
    const local = await inProcess();
    try {
      const { cookies, clients } = await twoBrowsers(local);
      await within(
        async () =>
          (
            await post(
              auth,
              '/change-password',
              { currentPassword: 'correct horse battery staple', newPassword: 'another long password, too' },
              { cookie: cookies.a, ...net() },
            )
          ).response,
        () => clients.b.closedFor(REFUSAL.SESSION_ENDED),
      );
      await sleep(300);
      expect(clients.a.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });
});

// ── An event is a reason to look, and the rows decide ───────────────────────

describe('what a notice that the rows do not bear out does', () => {
  it('changes nothing for events that are forged, late, or about no one here', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, clients } = await three(local);
      const events = [
        { kind: 'collaborator-changed', documentId: id, userId: editor.id },
        { kind: 'collaborator-changed', documentId: id, userId: owner.id },
        { kind: 'collaborator-changed', documentId: id, userId: 'nobody-at-all' },
        {
          kind: 'collaborator-changed',
          documentId: '00000000-0000-4000-8000-000000000000',
          userId: editor.id,
        },
        { kind: 'session-ended', userId: editor.id },
        { kind: 'session-ended', userId: viewer.id },
        { kind: 'session-ended', userId: 'nobody-at-all' },
      ];
      for (const event of events) await forger.publish(COLLAB_EVENTS_CHANNEL, JSON.stringify(event));
      for (const garbage of [
        '{',
        'null',
        '[]',
        '{"kind":"session-ended"}',
        '{"kind":"collaborator-changed","userId":"x"}',
      ]) {
        await forger.publish(COLLAB_EVENTS_CHANNEL, garbage);
      }
      await sleep(800);
      // Every session stands and every role is as it was: no connection is closed, none switched, none told.
      for (const client of Object.values(clients)) {
        expect(client.closed()).toBe(false);
        expect(client.notices).toHaveLength(1);
      }
      expect(connectionsOf(local, id)).toHaveLength(3);
    } finally {
      await local.stop();
    }
  });

  it('looks once for a burst of events about one user and not once for each', async () => {
    const local = await inProcess();
    try {
      const { editor } = await three(local);
      const reads = vi.spyOn(db().session, 'findMany');
      const pipeline = forger.pipeline();
      for (let n = 0; n < 200; n++) {
        pipeline.publish(COLLAB_EVENTS_CHANNEL, JSON.stringify({ kind: 'session-ended', userId: editor.id }));
      }
      await pipeline.exec();
      await sleep(1000);
      // The first look, and the one that the events that came during it wait for. Weakening: a look for each.
      expect(reads.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(reads.mock.calls.length).toBeLessThanOrEqual(4);
    } finally {
      await local.stop();
    }
  });

  // Weakening: the keys that wait are not bounded, and the look stays scoped to them.
  it('turns past 1,000 waiting keys into the whole re-check, so that a flood costs one look and misses no one', async () => {
    const local = await inProcess();
    try {
      const { editor, viewer, clients } = await three(local);
      // The first look, for the Editor, is held while the flood arrives.
      const original = db().session.findMany.bind(db().session) as (query: unknown) => Promise<unknown>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let held = false;
      vi.spyOn(db().session, 'findMany').mockImplementation((async (query: unknown) => {
        if (!held) {
          held = true;
          await gate;
        }
        return original(query);
      }) as never);
      // A session that ended and was told to no one (an expiry, or a notice that was lost): the Viewer's.
      await db().session.deleteMany({ where: { userId: viewer.id } });
      await forger.publish(
        COLLAB_EVENTS_CHANNEL,
        JSON.stringify({ kind: 'session-ended', userId: editor.id }),
      );
      await until(() => held);
      const flood = forger.pipeline();
      for (let n = 0; n < 1300; n++) {
        flood.publish(
          COLLAB_EVENTS_CHANNEL,
          JSON.stringify({ kind: 'session-ended', userId: `forged-user-${n}` }),
        );
      }
      await flood.exec();
      await sleep(300);
      release();
      // The look that came after was the whole re-check, which found the session that no one had told of.
      await until(() => clients.viewer.closedFor(REFUSAL.SESSION_ENDED), FIVE_SECONDS);
      // And the Editor, whose session stands, was kept by the look that was held.
      expect(clients.editor.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });
});

describe('a reading never undoes a fresher one (FR-ED-40 (b), FR-ED-41)', () => {
  // Weakening: no number on a reading, and no check of it before a decision is applied.
  it('drops what a re-check read as Editor, and had not yet applied, when the role was lowered and applied meanwhile', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, rows, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      expect(connection.readOnly).toBe(false);

      // The re-check reads the Editor's access, and is held after it has: its reading is "Editor".
      const original = db().document.findUnique.bind(db().document) as (query: unknown) => Promise<unknown>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reading = false;
      type Query = { where?: { id?: string }; include?: { collaborators?: { where?: { userId?: string } } } };
      vi.spyOn(db().document, 'findUnique').mockImplementation((async (query: Query) => {
        const result = await original(query);
        if (!reading && query.where?.id === id && query.include?.collaborators?.where?.userId === editor.id) {
          reading = true;
          await gate;
        }
        return result;
      }) as never);
      const run = local.recheck();
      await until(() => reading);

      // The Owner lowers the role, and the event acts: the connection is read-only, and told.
      expect((await changeRole(owner.cookie, id, rows.editor, 'viewer')).status).toBe(200);
      await until(() => connection.readOnly);
      await until(() => clients.editor.notices.length === 2);

      // The stale reading is let go, and decides "Editor" against a connection that is a Viewer's.
      release();
      await run;
      await sleep(300);
      expect(connection.readOnly).toBe(true);
      expect(connection.context.role).toBe('viewer');
      expect(clients.editor.notices).toHaveLength(2);
    } finally {
      await local.stop();
    }
  });
});

describe('two runs that decide the same change at once (FR-ED-40 (b), FR-ED-41)', () => {
  // Weakening: the notice sent by each run that applies the switch, and not by the one that changes the connection.
  it('tell the connection once, whichever applies the change', async () => {
    const local = await inProcess();
    try {
      const { id, editor, rows, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      // The row says Viewer, and no one has told the server.
      await db().documentCollaborator.update({ where: { id: rows.editor }, data: { role: 'VIEWER' } });

      // Both runs, the re-check and the look an event asks for, read the Editor's access, and are held
      // until both have read it: each then decides to switch the same connection.
      const original = db().document.findUnique.bind(db().document) as (query: unknown) => Promise<unknown>;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let arrived = 0;
      type Query = { where?: { id?: string }; include?: { collaborators?: { where?: { userId?: string } } } };
      vi.spyOn(db().document, 'findUnique').mockImplementation((async (query: Query) => {
        const result = await original(query);
        if (query.where?.id === id && query.include?.collaborators?.where?.userId === editor.id) {
          if (++arrived === 2) release();
          await gate;
        }
        return result;
      }) as never);
      const run = local.recheck();
      await forger.publish(
        COLLAB_EVENTS_CHANNEL,
        JSON.stringify({ kind: 'collaborator-changed', documentId: id, userId: editor.id }),
      );
      await until(() => arrived === 2);
      await run;
      await until(() => connection.readOnly);
      await sleep(400);
      expect(clients.editor.notices).toHaveLength(2);
      expect(readRoleNotice(clients.editor.notices[1]!)).toEqual({ role: 'viewer', canEdit: false });
    } finally {
      await local.stop();
    }
  });
});

describe('where the notice is lost (FR-ED-41: the re-check is the backstop)', () => {
  it('leaves the connection open until the re-check runs, which then closes it, and the removal stood meanwhile', async () => {
    const local = await inProcess();
    try {
      const { id, owner, rows, clients } = await three(local);
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(valkey(), 'publish').mockRejectedValue(
        Object.assign(new Error('down'), { code: 'ECONNREFUSED' }),
      );
      expect((await remove(owner.cookie, id, rows.editor)).status).toBe(200);
      await sleep(800);
      expect(clients.editor.closed()).toBe(false);
      vi.restoreAllMocks();
      await local.recheck();
      await until(() => clients.editor.closedFor(REFUSAL.ACCESS_ENDED));
    } finally {
      await local.stop();
    }
  });
});

describe('where the database cannot be read for an event', () => {
  it('closes the connections the look was for as unavailable, and says one line that names no person', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, rows, clients } = await three(local);
      const lines = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect((await remove(owner.cookie, id, rows.editor)).status).toBe(200);
      await until(() => clients.editor.closed());
      expect(lines.mock.calls).toEqual([]);

      // A session event whose reading of the sessions fails, once: fail closed.
      const fresh = connect(local.port, await anotherSession(owner), id);
      await fresh.synced;
      const lost = Object.assign(new Error(`connection lost ${owner.email}`), { code: 'P1001' });
      vi.spyOn(db().session, 'findMany').mockRejectedValue(lost);
      await forger.publish(
        COLLAB_EVENTS_CHANNEL,
        JSON.stringify({ kind: 'session-ended', userId: owner.id }),
      );
      await until(() => fresh.closedFor(REFUSAL.UNAVAILABLE));
      expect(JSON.stringify(lines.mock.calls)).not.toContain(owner.email);
      expect(JSON.stringify(lines.mock.calls)).not.toContain(editor.id);
      // Only the owner's connections were looked at.
      expect(clients.viewer.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });
});
