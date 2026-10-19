// What a transfer of ownership does to an open connection (FR-ED-40 (h);
// NFR-SE-03 (b) to (d); FR-ED-47): the connections of the new Owner and of the
// former Owner STAY OPEN, and each has its new role applied in place WITHIN 5
// SECONDS of the change being committed, by the notice on the channel and not by
// the re-check, whose period is made an hour here so that nothing but an event
// can act.
//
// The real collaboration server in this process, the real provider of the
// editor over Node's own WebSocket, the application's own routes, the real
// database and Valkey. One server for each test.
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from './channel.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

// What a route leaves for after its response (the email of an offer) is not run here.
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: () => {},
}));

const database = prepare('collabownership', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey, settings } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { COLLAB_PATH, readRoleNotice } = await import('../../src/lib/collab/protocol.ts');
const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
const { createCollabServer } = await import('../../src/collab/server.ts');
const offering = await import('../../src/app/api/documents/[id]/ownership-offer/route.ts');
const answering = await import('../../src/app/api/ownership-offers/[offerId]/[answer]/route.ts');

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
// The type of a frame that closes a document's connection (@hocuspocus/server, types.ts).
const CLOSE = 7;

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
  // The list of the people present is another message (FR-ED-17); it is not what these tests count.
  provider.on('stateless', ({ payload }: { payload: string }) => {
    if (!payload.startsWith('{"kind":"people"')) notices.push(payload);
  });
  provider.attach();
  return {
    provider,
    outcome,
    synced,
    notices,
    changes: provider.document.getArray<string>('changes'),
    /** Whether the server closed this document's connection, for any reason. */
    closed: () => frames.some((each) => each.name === documentId && each.type === CLOSE),
  };
}

// ── Accounts and documents ──────────────────────────────────────────────────

let count = 0;
let addresses = 0;
const net = () => ({ 'x-forwarded-for': `10.30.${Math.floor(++addresses / 250)}.${addresses % 250}` });
async function person(name: string) {
  const email = `transfer${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email, undefined, net())) };
}
type Person = Awaited<ReturnType<typeof person>>;
/** One more session of the account: a second browser. */
const anotherSession = async (who: Person) => cookiesOf(await signIn(auth, who.email, undefined, net()));

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

/**
 * A document with an Owner, an Editor and a Viewer, each with one connection, and a second tab of the Owner
 * and of the Editor; the offer made and not yet answered.
 */
async function offered(local: Local) {
  const owner = await person('Ada Owner');
  const editor = await person('Ben Editor');
  const viewer = await person('Cy Viewer');
  const id = (await createDocument(owner.id)).id;
  const row = (
    await db().documentCollaborator.create({ data: { documentId: id, userId: editor.id, role: 'EDITOR' } })
  ).id;
  await db().documentCollaborator.create({ data: { documentId: id, userId: viewer.id, role: 'VIEWER' } });
  const clients = {
    owner: connect(local.port, owner.cookie, id),
    editor: connect(local.port, editor.cookie, id),
    viewer: connect(local.port, viewer.cookie, id),
    ownerSecond: connect(local.port, await anotherSession(owner), id),
    editorSecond: connect(local.port, await anotherSession(editor), id),
  };
  for (const client of Object.values(clients)) {
    await client.synced;
    // The server tells each connection its role as it is made.
    await until(() => client.notices.length === 1);
  }
  const made = await offering.POST(
    request('POST', `/api/documents/${id}/ownership-offer`, owner.cookie, { collaboratorId: row }),
    at({ id }),
  );
  expect(made.status).toBe(201);
  const { id: offerId } = await db().ownershipOffer.findFirstOrThrow({ where: { documentId: id } });
  return { id, owner, editor, viewer, row, offerId, clients };
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
const answer = (cookie: string, offerId: string, chosen: 'accept' | 'decline') =>
  answering.POST(
    request('POST', `/api/ownership-offers/${offerId}/${chosen}`, cookie),
    at({ offerId, answer: chosen }),
  );
const withdraw = (cookie: string, id: string) =>
  offering.DELETE(request('DELETE', `/api/documents/${id}/ownership-offer`, cookie), at({ id }));

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

// ── The event ───────────────────────────────────────────────────────────────

describe('a transfer of ownership (FR-ED-40 (h); NFR-SE-03 (c))', () => {
  it('keeps the connections of both people open, and applies each new role in place within 5 seconds, told once', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, offerId, clients } = await offered(local);
      const places = connectionsOf(local, id).length;
      expect(places).toBe(5);
      const was = {
        owner: connectionOf(local, id, owner.id)!,
        editor: connectionOf(local, id, editor.id)!,
      };
      expect(was.owner.context.role).toBe('owner');
      expect(was.editor.context.role).toBe('editor');
      expect(was.owner.context.permissions).toContain('document.ownership.transfer');
      expect(was.editor.context.permissions).not.toContain('document.ownership.transfer');

      const response = await answer(editor.cookie, offerId, 'accept');
      expect(response.status).toBe(200);
      const committed = Date.now();
      // Both roles, applied to the connections that were open, in place.
      await until(
        () => was.owner.context.role === 'editor' && was.editor.context.role === 'owner',
        FIVE_SECONDS,
      );
      expect(Date.now() - committed).toBeLessThan(FIVE_SECONDS);

      // The same connections, still open and still editable: neither was closed, none was read-only.
      expect(connectionOf(local, id, owner.id)).toBe(was.owner);
      expect(connectionOf(local, id, editor.id)).toBe(was.editor);
      expect(was.owner.readOnly).toBe(false);
      expect(was.editor.readOnly).toBe(false);
      expect(connectionsOf(local, id)).toHaveLength(places);
      expect(local.placesOf(id)).toBe(places);
      // What each holds is what its new role holds: the former Owner an Editor's, the new Owner an Owner's.
      expect(was.owner.context.permissions).not.toContain('document.ownership.transfer');
      expect(was.owner.context.permissions).not.toContain('document.delete');
      expect(was.owner.context.permissions).toContain('document.content.edit');
      expect(was.editor.context.permissions).toContain('document.ownership.transfer');
      expect(was.editor.context.permissions).toContain('document.delete');

      // Each tab is told its new role, once, in the words of the notice (slice 14).
      for (const tab of [clients.owner, clients.ownerSecond]) {
        await until(() => tab.notices.length === 2, FIVE_SECONDS);
        expect(readRoleNotice(tab.notices[1]!)).toEqual({ role: 'editor', canEdit: true });
      }
      for (const tab of [clients.editor, clients.editorSecond]) {
        await until(() => tab.notices.length === 2, FIVE_SECONDS);
        expect(readRoleNotice(tab.notices[1]!)).toEqual({ role: 'owner', canEdit: true });
      }
      await sleep(400);
      for (const tab of [clients.owner, clients.ownerSecond, clients.editor, clients.editorSecond]) {
        expect(tab.notices).toHaveLength(2);
        expect(tab.closed()).toBe(false);
      }
      // The Viewer's connection, which the transfer did not touch, is untouched and told nothing.
      expect(clients.viewer.notices).toHaveLength(1);
      expect(clients.viewer.closed()).toBe(false);

      // Both go on writing to the one document.
      const held = local.hocuspocus.documents.get(id)!;
      clients.owner.changes.push(['written by the former Owner']);
      clients.editor.changes.push(['written by the new Owner']);
      await until(() => held.getArray('changes').length === 2);
    } finally {
      await local.stop();
    }
  });

  it('is told by the rows: a handshake after the transfer is admitted under the new roles', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, offerId } = await offered(local);
      expect((await answer(editor.cookie, offerId, 'accept')).status).toBe(200);
      const again = connect(local.port, await anotherSession(owner), id);
      expect(await again.outcome).toEqual({ scope: 'read-write' });
      await again.synced;
      await until(() => again.notices.length === 1);
      expect(readRoleNotice(again.notices[0]!)).toEqual({ role: 'editor', canEdit: true });
      const refreshed = connect(local.port, await anotherSession(editor), id);
      await refreshed.synced;
      await until(() => refreshed.notices.length === 1);
      expect(readRoleNotice(refreshed.notices[0]!)).toEqual({ role: 'owner', canEdit: true });
    } finally {
      await local.stop();
    }
  });

  it('touches no other document: the same people hold another document open and it is as it was', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, offerId } = await offered(local);
      // A second document of the same Owner, on which the same Editor is an Editor, open in both.
      const other = (await createDocument(owner.id)).id;
      await db().documentCollaborator.create({
        data: { documentId: other, userId: editor.id, role: 'EDITOR' },
      });
      const there = {
        owner: connect(local.port, await anotherSession(owner), other),
        editor: connect(local.port, await anotherSession(editor), other),
      };
      await there.owner.synced;
      await there.editor.synced;
      await until(() => there.owner.notices.length === 1 && there.editor.notices.length === 1);

      expect((await answer(editor.cookie, offerId, 'accept')).status).toBe(200);
      await until(() => connectionOf(local, id, owner.id)!.context.role === 'editor', FIVE_SECONDS);
      await sleep(400);
      expect(connectionOf(local, other, owner.id)!.context.role).toBe('owner');
      expect(connectionOf(local, other, editor.id)!.context.role).toBe('editor');
      expect(there.owner.notices).toHaveLength(1);
      expect(there.editor.notices).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });

  // Weakening: the notice published for a decline, a withdrawal, or an offer.
  it('does nothing to a connection for an offer that is declined or withdrawn, or for the offer itself', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, offerId, clients } = await offered(local);
      await sleep(500);
      for (const tab of Object.values(clients)) expect(tab.notices).toHaveLength(1);
      expect((await answer(editor.cookie, offerId, 'decline')).status).toBe(200);
      await sleep(500);
      for (const tab of Object.values(clients)) expect(tab.notices).toHaveLength(1);
      expect(connectionOf(local, id, owner.id)!.context.role).toBe('owner');
      expect(connectionOf(local, id, editor.id)!.context.role).toBe('editor');
    } finally {
      await local.stop();
    }
  });

  it('does nothing that the rows do not bear out for a notice about the pair that is forged, or late', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, clients } = await offered(local);
      // No transfer was made: the offer is open, the rows say what they said.
      for (const userId of [owner.id, editor.id]) {
        await forger.publish(
          COLLAB_EVENTS_CHANNEL,
          JSON.stringify({ kind: 'collaborator-changed', documentId: id, userId }),
        );
      }
      await sleep(800);
      for (const tab of Object.values(clients)) {
        expect(tab.notices).toHaveLength(1);
        expect(tab.closed()).toBe(false);
      }
      expect(connectionOf(local, id, owner.id)!.context.role).toBe('owner');
      expect(connectionOf(local, id, editor.id)!.context.role).toBe('editor');
    } finally {
      await local.stop();
    }
  });

  it('and a later withdrawal by the former Owner is refused: the offer was accepted', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, offerId } = await offered(local);
      expect((await answer(editor.cookie, offerId, 'accept')).status).toBe(200);
      expect((await withdraw(owner.cookie, id)).status).toBe(403);
      expect((await withdraw(editor.cookie, id)).status).toBe(404);
    } finally {
      await local.stop();
    }
  });
});
