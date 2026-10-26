// What the confirmation of the deletion of an account does to an open connection (FR-AU-58 (a);
// FR-ED-40 (d), FR-ED-41; NFR-SE-03 (b) to (e)): every connection the account holds is closed within
// 5 SECONDS of the record being committed, by the notice on the channel; where the notice is lost, by
// the re-check, which reads the rows; and the account is refused at the handshake from then on.
//
// The real collaboration server in this process, the real provider of the editor over Node's own
// WebSocket, the real database and Valkey. One server for each test.
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { until } from './channel.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('collabdeletion', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey, settings } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { COLLAB_PATH, REFUSAL } = await import('../../src/lib/collab/protocol.ts');
const { createCollabServer } = await import('../../src/collab/server.ts');
const { confirmDeletion } = await import('../../src/lib/account/deletion.ts');
const { carryOutDeletions } = await import('../../src/lib/account/deletion-steps.ts');

/** What the requirements allow between the commit of a change and its effect on a connection. */
const FIVE_SECONDS = 5000;

// ── Frames ──────────────────────────────────────────────────────────────────

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
const CLOSE = 7;
const closedBecause = (reason: string) =>
  Buffer.from([reason.length, ...Buffer.from(reason)]).toString('hex');

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
  const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  provider.attach();
  return {
    synced,
    closedFor: (reason: string) =>
      frames.some(
        (each) => each.name === documentId && each.type === CLOSE && each.rest === closedBecause(reason),
      ),
    closed: () => frames.some((each) => each.name === documentId && each.type === CLOSE),
  };
}

/** The status the server answers a handshake with, from a browser that holds this cookie. */
function handshake(port: number, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const asked = httpRequest({
      host: '127.0.0.1',
      port,
      path: COLLAB_PATH,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        origin: ORIGIN,
        cookie,
      },
    });
    asked.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    asked.on('upgrade', (_response, socket) => {
      socket.destroy();
      resolve(101);
    });
    asked.on('error', reject);
    asked.end();
  });
}

// ── Accounts and the server ─────────────────────────────────────────────────

let count = 0;
let addresses = 0;
const net = () => ({ 'x-forwarded-for': `10.40.${Math.floor(++addresses / 250)}.${addresses % 250}` });
async function person(name = 'A Person') {
  const email = `closing${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email, undefined, net())) };
}
const anotherSession = async (who: { email: string }) =>
  cookiesOf(await signIn(auth, who.email, undefined, net()));

/** The server in this process, hearing the channel or not, with the period of its re-check given. */
async function inProcess(options: { listen: boolean; recheckMs: number }) {
  const collab = createCollabServer(
    { ...settings(), limits: settings().limits },
    { recheckMs: options.recheckMs },
  );
  await new Promise<void>((resolve) => collab.httpServer.listen(0, resolve));
  if (options.listen) await collab.listenForEvents();
  return { ...collab, port: (collab.httpServer.address() as AddressInfo).port };
}
type Local = Awaited<ReturnType<typeof inProcess>>;
const connectionsOf = (local: Local, id: string) =>
  local.hocuspocus.documents.get(id)?.getConnections() ?? [];

/** An Owner with a document open, and an Editor with it open in two browsers. */
async function opened(local: Local) {
  const owner = await person('Ada Owner');
  const editor = await person('Ben Editor');
  const id = (await createDocument(owner.id)).id;
  await db().documentCollaborator.create({ data: { documentId: id, userId: editor.id, role: 'EDITOR' } });
  const clients = {
    owner: connect(local.port, owner.cookie, id),
    a: connect(local.port, editor.cookie, id),
    b: connect(local.port, await anotherSession(editor), id),
  };
  for (const client of Object.values(clients)) await client.synced;
  return { id, owner, editor, clients };
}

afterEach(() => {
  for (const socket of sockets.splice(0)) socket.destroy();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the connections of an account whose deletion is confirmed (FR-AU-58 (a), FR-ED-40 (d))', () => {
  it('closes every connection the account holds, in every browser, as session-ended, within 5 seconds, and no one else’s', async () => {
    const local = await inProcess({ listen: true, recheckMs: 3_600_000 });
    try {
      const { id, editor, clients } = await opened(local);
      expect(connectionsOf(local, id)).toHaveLength(3);
      const outcome = await confirmDeletion(editor.id, async () => 'held');
      expect(outcome.outcome).toBe('confirmed');
      const committed = Date.now();
      // By the notice alone: the period of the re-check is an hour. The sessions still stand in the table.
      await until(
        () => clients.a.closedFor(REFUSAL.SESSION_ENDED) && clients.b.closedFor(REFUSAL.SESSION_ENDED),
        FIVE_SECONDS,
      );
      expect(Date.now() - committed).toBeLessThan(FIVE_SECONDS);
      expect(await db().session.count({ where: { userId: editor.id } })).toBe(2);
      await until(() => connectionsOf(local, id).length === 1);
      await sleep(300);
      expect(clients.owner.closed()).toBe(false);
      // And from then on the account is refused at the handshake, though its sessions are still rows.
      expect(await handshake(local.port, editor.cookie)).toBe(401);
    } finally {
      await local.stop();
    }
  });

  it('closes them by the re-check where the notice was lost, because the rows say the account does not stand', async () => {
    const local = await inProcess({ listen: false, recheckMs: 300 });
    try {
      const { id, editor, clients } = await opened(local);
      await confirmDeletion(editor.id, async () => 'held');
      await until(
        () => clients.a.closedFor(REFUSAL.SESSION_ENDED) && clients.b.closedFor(REFUSAL.SESSION_ENDED),
        FIVE_SECONDS,
      );
      await sleep(300);
      expect(clients.owner.closed()).toBe(false);
      expect(connectionsOf(local, id).filter((each) => each.context.userId === editor.id)).toHaveLength(0);
    } finally {
      await local.stop();
    }
  });

  it('keeps the connections of an account whose deletion was refused for the documents it owns', async () => {
    const local = await inProcess({ listen: true, recheckMs: 300 });
    try {
      const { owner, clients } = await opened(local);
      expect((await confirmDeletion(owner.id, async () => 'held')).outcome).toBe('owns_documents');
      await sleep(800);
      expect(clients.owner.closed()).toBe(false);
    } finally {
      await local.stop();
    }
  });

  it('refuses the handshake of the tombstone once the steps have ended its sessions, as it did before', async () => {
    const local = await inProcess({ listen: true, recheckMs: 3_600_000 });
    try {
      const { editor } = await opened(local);
      await confirmDeletion(editor.id, async () => 'held');
      await carryOutDeletions();
      expect(await db().session.count({ where: { userId: editor.id } })).toBe(0);
      expect(await handshake(local.port, editor.cookie)).toBe(401);
    } finally {
      await local.stop();
    }
  });
});
