// The collaboration server (FR-AU-08; NFR-SE-03, lead paragraph, (a) and (f);
// NFR-SE-07; NFR-RE-07; FR-AU-83), against the real process: `node
// src/collab/server.ts`, started here on a free port with the test database
// and Valkey. The clients are the real provider of the editor, over Node's own
// WebSocket, and set `Cookie` and `Origin` themselves as a browser would.
//
// A few tests need to look inside the server, and run the same server object
// in this process: they are in the last two groups.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Access } from '../../src/lib/documents/access.ts';
import { cookiesOf, createAccount, DAY, load, ORIGIN, prepare, signIn } from './identity.ts';

const FOUNDER = 'founder@example.com';
const database = prepare('collab');
const { auth, db, valkey, settings, validateSession } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { applyState } = await import('../../src/lib/collab/state.ts');
const { COLLAB_PATH, REFUSAL } = await import('../../src/lib/collab/protocol.ts');
const { PERMISSIONS } = await import('../../src/lib/documents/permissions.ts');

// What `authorise` answers, for the tests that run the server in this process
// and need an answer no account can be given until sharing is built.
const answers = new Map<string, Access>();
vi.doMock('../../src/lib/documents/access.ts', async (original) => {
  const actual = await original<typeof import('../../src/lib/documents/access.ts')>();
  return {
    ...actual,
    authorise: (userId: string, documentId: unknown, permission: never) =>
      answers.get(`${userId} ${String(documentId)}`) ?? actual.authorise(userId, documentId, permission),
  };
});
const { createCollabServer } = await import('../../src/collab/server.ts');

const UNKNOWN = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
// A text no log may hold (NFR-SE-19): it is written into documents below.
const CONTENT = 'content-that-no-log-may-hold';

// ── The server process ──────────────────────────────────────────────────────

const children: ChildProcess[] = [];

async function startServer(env: Record<string, string> = {}, port = 0) {
  const child = spawn('node', ['src/collab/server.ts'], {
    env: { ...process.env, ...env, COLLAB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );
  const listening = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /listening on (\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error(`the collaboration server did not start: ${stderr}`)));
  });
  return { port: listening, child, exited, stderr: () => stderr };
}

// Two processes for the whole file: one as a deployment has it by default, and
// one whose list of the founding team holds an address (in another case than
// the account's, FR-AU-83).
const server = await startServer();
const team = await startServer({ FOUNDING_TEAM_EMAILS: 'Someone@Example.com, Founder@Example.COM' });

// ── Clients ─────────────────────────────────────────────────────────────────

interface Asked {
  cookie?: string;
  /** null for a request without the header. */
  origin?: string | null;
  path?: string;
}

/** One handshake, as the upgrade request a browser sends, and what the server answered to it. */
function handshake(port: number, { cookie, origin = ORIGIN, path = COLLAB_PATH }: Asked = {}) {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      path,
      agent: false,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        ...(origin === null ? {} : { Origin: origin }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    // Refused: an HTTP answer, and no WebSocket.
    request.on('response', (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
    });
    // Accepted.
    request.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve({ status: 101, headers: response.headers, body: '' });
    });
    request.on('error', reject);
    request.end();
  });
}

/** A handshake that was refused: the status, and nothing of any document. */
async function expectRefused(port: number, asked: Asked, status: number) {
  const answer = await handshake(port, asked);
  expect(answer.status).toBe(status);
  expect(answer.body).toBe('');
  expect(answer.headers['cache-control']).toBe('no-store');
  expect(answer.headers.upgrade).toBeUndefined();
  return answer;
}

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
// The types of a frame (@hocuspocus/server, types.ts). A document's state
// travels in the first and the last of these three, and in no other.
const SYNC = 0;
const AUTH = 2;
const SYNC_REPLY = 4;
/** The rest of the frame that refuses a document: "permission denied", and the reason. */
const denied = (reason: string) => Buffer.from([1, reason.length, ...Buffer.from(reason)]).toString('hex');

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
    // Reconnection, for the kill test: every 100 ms, with no growth.
    delay: 100,
    minDelay: 100,
    factor: 1,
    jitter: false,
  });
  sockets.push(socket);
  const open = (name: string) => {
    const provider = new HocuspocusProvider({ websocketProvider: socket, name });
    const outcome = new Promise<{ scope?: string; refused?: string }>((resolve) => {
      provider.on('authenticated', ({ scope }: { scope: string }) => resolve({ scope }));
      provider.on('authenticationFailed', ({ reason }: { reason: string }) => resolve({ refused: reason }));
    });
    const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
    provider.attach();
    return { provider, outcome, synced, changes: provider.document.getArray<string>('changes') };
  };
  /** The frames received for one document. */
  const framesFor = (name: string) => frames.filter((each) => each.name === name);
  return { socket, open, frames, framesFor };
}

async function until<T>(read: () => T | Promise<T>, within = 5000, every = 20): Promise<NonNullable<T>> {
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
async function person(email = `collaborator${++people}@example.com`) {
  const id = await createAccount(auth, email);
  const signedIn = async () => cookiesOf(await signIn(auth, email));
  return { id, email, signedIn, cookie: await signedIn() };
}
const documentOf = async (userId: string) => (await createDocument(userId)).id;

/** The changes in the stored state of a document, or null where none is stored. */
async function stored(id: string): Promise<string[] | null> {
  const row = await db().document.findUnique({ where: { id }, select: { yjsState: true } });
  if (!row?.yjsState) return null;
  const document = new Y.Doc();
  applyState(document, row.yjsState);
  return document.getArray<string>('changes').toArray();
}
const logged = () =>
  db().securityLogEntry.findMany({ select: { kind: true, userId: true, documentId: true } });

beforeEach(async () => {
  await db().securityLogEntry.deleteMany();
});
afterEach(() => {
  vi.restoreAllMocks();
  answers.clear();
  for (const socket of sockets.splice(0)) socket.destroy();
});
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

// ── The handshake ───────────────────────────────────────────────────────────

describe('the health check and the path (NFR-SE-05 (c))', () => {
  it('answers the health check as before, and nothing else over HTTP', async () => {
    const base = `http://127.0.0.1:${server.port}`;
    const health = await fetch(`${base}/collab/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('');
    for (const [method, path] of [
      ['POST', '/collab/health'],
      ['GET', '/collab'],
      ['GET', '/'],
    ] as const) {
      const response = await fetch(base + path, { method });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
  });

  it('refuses a handshake on any path but /collab, written exactly, with a 404', async () => {
    const { cookie } = await person();
    for (const path of ['/', '/collab/', '/collab?document=1', '/COLLAB', '/collab/health', '/collab/x']) {
      await expectRefused(server.port, { cookie, path }, 404);
    }
    expect((await handshake(server.port, { cookie })).status).toBe(101);
  });
});

describe('a handshake from another origin (FR-AU-08, NFR-SE-17 (c))', () => {
  it('is refused with a 403 and logged, whatever cookie it carries', async () => {
    const { cookie } = await person();
    const origins = [
      'https://evil.example',
      'https://internal.example.test',
      'http://app.example.test',
      `${ORIGIN}:8443`,
      `${ORIGIN}/`,
      'null',
    ];
    for (const origin of origins) await expectRefused(server.port, { cookie, origin }, 403);
    // NFR-SE-19: each 403 is logged. The cookie was not read, so no user is named.
    expect(await logged()).toEqual(
      origins.map(() => ({ kind: 'forbidden', userId: null, documentId: null })),
    );
  });

  it('is refused where the request carries no Origin header at all', async () => {
    const { cookie } = await person();
    await expectRefused(server.port, { cookie, origin: null }, 403);
    expect(await logged()).toEqual([{ kind: 'forbidden', userId: null, documentId: null }]);
  });

  it('spends nothing of the user’s limit', async () => {
    const { cookie } = await person();
    for (let n = 0; n < 35; n++)
      await expectRefused(server.port, { cookie, origin: 'https://evil.example' }, 403);
    expect((await handshake(server.port, { cookie })).status).toBe(101);
  });
});

describe('a handshake without a valid session (FR-AU-08, NFR-SE-03)', () => {
  it('is refused with a 401 where there is no cookie, or one that is not a session', async () => {
    await expectRefused(server.port, {}, 401);
    await expectRefused(server.port, { cookie: '__Secure-better-auth.session_token=made-up.c2ln' }, 401);
    // A 401 is no 403: nothing is logged for it.
    expect(await logged()).toEqual([]);
  });

  it('is refused where the session has ended, by either period of FR-AU-84', async () => {
    const idle = await person();
    await db().session.updateMany({
      where: { userId: idle.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expectRefused(server.port, { cookie: idle.cookie }, 401);

    const old = await person();
    await db().session.updateMany({
      where: { userId: old.id },
      data: { createdAt: new Date(Date.now() - 30 * DAY * 1000 - 1000) },
    });
    await expectRefused(server.port, { cookie: old.cookie }, 401);
  });

  it('reads the row of the session: a session whose row is gone is refused although its signed copy is fresh', async () => {
    const { id, cookie } = await person();
    expect((await handshake(server.port, { cookie })).status).toBe(101);
    // Signed out, or revoked, on another device.
    await db().session.deleteMany({ where: { userId: id } });
    // The copy in the cookie still stands for a request that only reads (NFR-SE-17 (c)).
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);
    // NFR-SE-03 (f): the reconnection fails at the handshake.
    await expectRefused(server.port, { cookie }, 401);
  });
});

describe('the limit of handshakes (NFR-SE-07: 30 in any minute for each user)', () => {
  it('refuses the 31st with a 429 that says when to try again, and logs the limit once', async () => {
    expect(settings().limits.HANDSHAKES_PER_USER).toEqual({ max: 30, windowSeconds: 60 });
    const { id, cookie, signedIn } = await person();
    for (let n = 0; n < 30; n++) expect((await handshake(server.port, { cookie })).status).toBe(101);

    for (let n = 0; n < 3; n++) {
      const refused = await expectRefused(server.port, { cookie }, 429);
      const seconds = Number(refused.headers['retry-after']);
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(60);
    }
    // The limit is the user's: a second session, and the other process, count against it too.
    await expectRefused(server.port, { cookie: await signedIn() }, 429);
    await expectRefused(team.port, { cookie }, 429);
    // Another user is not held back.
    expect((await handshake(server.port, { cookie: (await person()).cookie })).status).toBe(101);

    // NFR-SE-19: one entry for the limit reached, not one for each refusal.
    expect(await logged()).toEqual([{ kind: 'rate_limit_reached', userId: id, documentId: null }]);
  });
});

describe('the founding-team gate at the handshake (FR-AU-83; register D114, A102)', () => {
  it('refuses an account of the team with a 403 until two-factor authentication is on', async () => {
    const founder = await person(FOUNDER);
    await expectRefused(team.port, { cookie: founder.cookie }, 403);
    expect(await logged()).toEqual([{ kind: 'forbidden', userId: founder.id, documentId: null }]);

    // The same account, where the list does not hold its address.
    expect((await handshake(server.port, { cookie: founder.cookie })).status).toBe(101);
    // Another account, where the list holds the founder's.
    expect((await handshake(team.port, { cookie: (await person()).cookie })).status).toBe(101);

    // The row is read at each handshake: the same session passes once it is on.
    await db().user.update({ where: { id: founder.id }, data: { twoFactorEnabled: true } });
    expect((await handshake(team.port, { cookie: founder.cookie })).status).toBe(101);
    await db().user.update({ where: { id: founder.id }, data: { twoFactorEnabled: false } });
    await expectRefused(team.port, { cookie: founder.cookie }, 403);
  });
});

// ── One document on the connection ──────────────────────────────────────────

describe('a document the account may see (FR-ED-15, FR-ED-16)', () => {
  it('is opened for its Owner, who may edit, and two clients hold the same state', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const first = connect(server.port, owner.cookie).open(id);
    const second = connect(server.port, await owner.signedIn()).open(id);
    expect(await first.outcome).toEqual({ scope: 'read-write' });
    expect(await second.outcome).toEqual({ scope: 'read-write' });
    await Promise.all([first.synced, second.synced]);

    first.changes.push(['from the first']);
    second.changes.push(['from the second']);
    await until(() => first.changes.length === 2 && second.changes.length === 2);
    expect(first.changes.toArray()).toEqual(second.changes.toArray());
  });
});

describe('a document the account may not see (FR-AU-08, FR-ED-39; the answer to Q8)', () => {
  it('is refused before anything of it is sent, with one answer whatever lies behind it', async () => {
    const owner = await person();
    const other = await person();
    const theirs = await documentOf(other.id);
    await connect(server.port, other.cookie).open(theirs).synced;
    const deleted = await documentOf(owner.id);
    await db().document.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const mine = await documentOf(owner.id);

    const names = [
      UNKNOWN, // no such document
      theirs, // another account's, open on the server at this moment
      deleted, // the Owner's own, deleted (FR-ED-36)
      mine.toUpperCase(), // not the canonical writing of the identifier
      `{${mine}}`,
      `${mine} `,
      'not-an-identifier',
      "' OR 1=1 --",
    ];
    const answers = [];
    for (const name of names) {
      const client = connect(server.port, owner.cookie);
      expect(await client.open(name).outcome, name).toEqual({ refused: REFUSAL.NO_ACCESS });
      // Time for anything else the server might have sent.
      await sleep(150);
      const received = client.framesFor(name);
      // NO document state: one frame, the refusal, and neither kind of frame that carries state.
      expect(client.frames.some((each) => each.type === SYNC || each.type === SYNC_REPLY)).toBe(false);
      expect(received.map(({ type, rest }) => ({ type, rest }))).toEqual([
        { type: AUTH, rest: denied('no-access') },
      ]);
      expect(client.frames).toHaveLength(1);
      answers.push(received[0]!.rest);
    }
    // "Not found" and "no access" are one answer.
    expect(new Set(answers).size).toBe(1);
    // A document that is not found is no 403: nothing is logged.
    expect(await logged()).toEqual([]);
    // The Owner's own document opens on the same server.
    expect(await connect(server.port, owner.cookie).open(mine).outcome).toEqual({ scope: 'read-write' });
  });

  it('is refused as the second document of a socket that was accepted for the first', async () => {
    const owner = await person();
    const other = await person();
    const mine = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    const there = connect(server.port, other.cookie).open(theirs);
    await there.synced;
    there.changes.push([CONTENT]);

    const client = connect(server.port, owner.cookie);
    const own = client.open(mine);
    await own.synced;
    // The socket is accepted and carries a document. The check is made again for the next one.
    const second = client.open(theirs);
    expect(await second.outcome).toEqual({ refused: REFUSAL.NO_ACCESS });
    await sleep(150);
    expect(client.framesFor(theirs).map(({ type, rest }) => ({ type, rest }))).toEqual([
      { type: AUTH, rest: denied('no-access') },
    ]);
    expect(second.changes.toArray()).toEqual([]);
    // What the refused client wrote reaches no one, and the first document still works.
    second.changes.push(['from a client that was refused']);
    own.changes.push(['mine']);
    await until(() => own.provider.unsyncedChanges === 0);
    await sleep(150);
    expect(there.changes.toArray()).toEqual([CONTENT]);
  });

  it('is sent nothing for a document it never asked to open: no state before the check', async () => {
    const owner = await person();
    const other = await person();
    const mine = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    const there = connect(server.port, other.cookie).open(theirs);
    await there.synced;
    there.changes.push([CONTENT]);

    const client = connect(server.port, owner.cookie);
    await client.open(mine).synced;
    // A request for the state of another account's document, and an update to
    // it, sent as frames of the accepted socket without the frame that opens a
    // document: [name][sync][step 1][empty state vector], and [name][sync][update][…].
    const name = Buffer.from(theirs);
    const update = Y.encodeStateAsUpdate(
      (() => {
        const forged = new Y.Doc();
        forged.getArray('changes').push(['forged']);
        return forged;
      })(),
    );
    client.socket.webSocket!.send(Buffer.from([name.length, ...name, SYNC, 0, 1, 0]));
    client.socket.webSocket!.send(Buffer.from([name.length, ...name, SYNC, 2, update.length, ...update]));
    await sleep(300);
    expect(client.framesFor(theirs)).toEqual([]);
    expect(there.changes.toArray()).toEqual([CONTENT]);
  });
});

// ── Storing ─────────────────────────────────────────────────────────────────

describe('storing a document’s state (NFR-RE-07; register P14)', () => {
  it('stores one change no later than 2 seconds after it, and acknowledges it before that', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes, provider } = connect(server.port, owner.cookie).open(id);
    await synced;
    expect(await stored(id)).toBeNull();
    const before = (await db().document.findUniqueOrThrow({ where: { id } })).updatedAt;

    const sent = Date.now();
    changes.push([CONTENT]);
    // "A change is acknowledged when the server has received it, not when it is stored."
    await until(() => provider.unsyncedChanges === 0, 1000, 5);
    expect(await stored(id)).toBeNull();

    await until(async () => (await stored(id))?.includes(CONTENT), 4000, 10);
    expect(Date.now() - sent).toBeLessThanOrEqual(2000);
    // Reported to the owner: a store moves `Document.updatedAt`.
    const row = await db().document.findUniqueOrThrow({ where: { id } });
    expect(row.updatedAt.getTime()).toBeGreaterThan(before.getTime());
    // The content is in no row that a query did not select it for (src/lib/db.ts).
    expect(Object.keys(row)).not.toContain('yjsState');
    expect(Object.keys((await db().document.findMany({ where: { id } }))[0]!)).not.toContain('yjsState');
  });

  it('stores at least every 10 seconds while changes continue', { timeout: 40_000 }, async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes } = connect(server.port, owner.cookie).open(id);
    await synced;

    // A change every 250 ms for 11 seconds: never 2 seconds without one.
    const began = Date.now();
    let made = 0;
    const editing = setInterval(() => changes.push([`change ${++made}`]), 250);
    const stores: number[] = [];
    try {
      let last = 0;
      while (Date.now() - began < 11_000) {
        const count = (await stored(id))?.length ?? 0;
        if (count > last) stores.push(Date.now() - began);
        last = count;
        await sleep(25);
      }
    } finally {
      clearInterval(editing);
    }
    // The first store came while the changes still did, within 10 seconds of the first of them.
    expect(stores.length).toBeGreaterThan(0);
    expect(stores[0]).toBeLessThanOrEqual(10_000);
    for (let n = 1; n < stores.length; n++) expect(stores[n]! - stores[n - 1]!).toBeLessThanOrEqual(10_000);
    // And when they stop, the rest within 2 seconds.
    await until(async () => (await stored(id))?.length === made, 2000, 10);
  });

  it('loads what was stored for a client that opens the document later, on another process', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const first = connect(server.port, owner.cookie).open(id);
    await first.synced;
    first.changes.push(['one', 'two', CONTENT]);
    await until(async () => (await stored(id))?.length === 3);
    first.provider.configuration.websocketProvider.destroy();

    // The other process has never held this document: what it sends is what the database holds.
    const later = connect(team.port, await owner.signedIn()).open(id);
    await later.synced;
    expect(later.changes.toArray()).toEqual(['one', 'two', CONTENT]);
  });

  it('does not store to a deleted document (FR-ED-36)', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes, provider } = connect(server.port, owner.cookie).open(id);
    await synced;
    changes.push(['before']);
    await until(async () => (await stored(id))?.length === 1);

    await db().document.update({ where: { id }, data: { deletedAt: new Date() } });
    const row = () => db().document.findUniqueOrThrow({ where: { id }, select: { updatedAt: true } });
    const { updatedAt } = await row();
    changes.push(['after the deletion']);
    await until(() => provider.unsyncedChanges === 0);
    await sleep(2500);
    expect(await stored(id)).toEqual(['before']);
    expect((await row()).updatedAt).toEqual(updatedAt);
  });

  it('tries a store that failed again, and says so on stderr by the class of the fault alone', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes } = connect(server.port, owner.cookie).open(id);
    await synced;
    const before = server.stderr().length;
    // The database refuses the write, with an error that quotes the query.
    database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsState" TO "yjsStateAway"');
    try {
      changes.push([CONTENT]);
      await until(() => /store failed/.test(server.stderr().slice(before)), 5000);
    } finally {
      database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsStateAway" TO "yjsState"');
    }
    await until(async () => (await stored(id))?.includes(CONTENT), 5000);
    const lines = server.stderr().slice(before).trim().split('\n');
    for (const line of lines) expect(line).toMatch(/^collab: store failed \(\w+\)$/);
  });
});

describe('an orderly stop (NFR-RE-07)', () => {
  it('stores every open document before the process exits', async () => {
    const stopping = await startServer();
    const owner = await person();
    const other = await person();
    const ids = [await documentOf(owner.id), await documentOf(owner.id), await documentOf(other.id)];
    const client = connect(stopping.port, owner.cookie);
    const open = [
      client.open(ids[0]!),
      client.open(ids[1]!),
      connect(stopping.port, other.cookie).open(ids[2]!),
    ];
    await Promise.all(open.map((each) => each.synced));
    for (const [n, each] of open.entries()) each.changes.push([`document ${n}`]);
    await until(() => open.every((each) => each.provider.unsyncedChanges === 0), 1000, 5);
    // Received, and not yet stored: the 2 seconds have not passed.
    for (const id of ids) expect(await stored(id)).toBeNull();

    stopping.child.kill('SIGTERM');
    expect(await stopping.exited).toEqual({ code: 0, signal: null });
    for (const [n, id] of ids.entries()) expect(await stored(id)).toEqual([`document ${n}`]);
    // It no longer accepts a handshake.
    await expect(handshake(stopping.port, { cookie: owner.cookie })).rejects.toThrow();
  });

  it('exits at once on a second signal', async () => {
    const stopping = await startServer();
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes, provider } = connect(stopping.port, owner.cookie).open(id);
    await synced;
    database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsState" TO "yjsStateAway"');
    try {
      changes.push(['never stored']);
      await until(() => provider.unsyncedChanges === 0, 1000, 5);
      // The stop cannot store, and tries again for a few seconds.
      stopping.child.kill('SIGTERM');
      await sleep(300);
      expect(stopping.child.exitCode).toBeNull();
      const second = Date.now();
      stopping.child.kill('SIGTERM');
      expect(await stopping.exited).toEqual({ code: 1, signal: null });
      expect(Date.now() - second).toBeLessThan(500);
    } finally {
      database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsStateAway" TO "yjsState"');
    }
  });

  it('exits with a failure where a document could not be stored', { timeout: 20_000 }, async () => {
    const stopping = await startServer();
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes, provider } = connect(stopping.port, owner.cookie).open(id);
    await synced;
    database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsState" TO "yjsStateAway"');
    try {
      changes.push(['never stored']);
      await until(() => provider.unsyncedChanges === 0, 1000, 5);
      stopping.child.kill('SIGTERM');
      expect(await stopping.exited).toEqual({ code: 1, signal: null });
    } finally {
      database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsStateAway" TO "yjsState"');
    }
    expect(stopping.stderr()).toMatch(/^collab: store failed \(\w+\)$/m);
  });
});

describe('the kill test of NFR-RE-07', () => {
  // "The requirement is met when, with two clients editing, an instance is
  // killed, and after reconnection both clients and the stored state hold every
  // change either client made."
  it('loses no change of either client when the instance is killed', { timeout: 60_000 }, async () => {
    const instance = await startServer();
    const owner = await person();
    const id = await documentOf(owner.id);
    const clients = [
      connect(instance.port, owner.cookie).open(id),
      connect(instance.port, await owner.signedIn()).open(id),
    ];
    await Promise.all(clients.map((each) => each.synced));

    // Both clients edit, every 100 ms, from before the kill until after the reconnection.
    const made: string[] = [];
    const editing = setInterval(() => {
      for (const [n, client] of clients.entries()) {
        const change = `client ${n}, change ${made.length}`;
        made.push(change);
        client.changes.push([change]);
      }
    }, 100);
    let madeBeforeKill = 0;
    try {
      // Long enough for one store, and then into the next period, so that the
      // kill finds changes received and not yet stored.
      await until(async () => ((await stored(id))?.length ?? 0) > 0, 15_000);
      await sleep(700);
      madeBeforeKill = made.length;
      const storedBeforeKill = (await stored(id))!.length;
      expect(storedBeforeKill).toBeLessThan(madeBeforeKill);

      instance.child.kill('SIGKILL');
      expect(await instance.exited).toEqual({ code: null, signal: 'SIGKILL' });
      // Nothing was stored by the kill.
      expect((await stored(id))!.length).toBe(storedBeforeKill);
      // The clients go on editing with no server at all.
      await sleep(800);

      // The instance starts again where it was.
      await startServer({}, instance.port);
      await until(
        () => clients.every((each) => each.provider.synced && each.provider.isAuthenticated),
        15_000,
      );
      await sleep(500);
    } finally {
      clearInterval(editing);
    }
    expect(made.length).toBeGreaterThan(madeBeforeKill);

    // After reconnection: both clients, and the stored state, hold every change either made.
    const sorted = [...made].sort();
    await until(() => clients.every((each) => each.changes.length === made.length), 10_000);
    for (const client of clients) expect(client.changes.toArray().sort()).toEqual(sorted);
    expect(clients[0]!.changes.toArray()).toEqual(clients[1]!.changes.toArray());
    await until(async () => (await stored(id))?.length === made.length, 5000);
    expect((await stored(id))!.sort()).toEqual(sorted);
  });
});

describe('what the processes wrote to stderr (NFR-SE-19)', () => {
  it('holds no address, no cookie, and nothing of a document', () => {
    for (const each of [server, team]) {
      const stderr = each.stderr();
      expect(stderr).not.toContain('example.com');
      expect(stderr).not.toContain(CONTENT);
      expect(stderr).not.toContain('session_token');
    }
  });
});

// ── The same server, in this process ────────────────────────────────────────

async function inProcess() {
  const collab = createCollabServer(settings());
  await new Promise<void>((resolve) => collab.httpServer.listen(0, resolve));
  return { ...collab, port: (collab.httpServer.address() as AddressInfo).port };
}

describe('the order of the handshake (FR-AU-08; API design, "Collaboration connection")', () => {
  it('checks the origin before it reads the cookie, and the session before it takes the limit', async () => {
    const local = await inProcess();
    try {
      const { cookie } = await person();
      const session = vi.spyOn(auth().api, 'getSession');
      const limit = vi.spyOn(valkey(), 'eval');
      const account = vi.spyOn(db().user, 'findUnique');

      // Another origin, with a valid cookie: no session row is read and no limit is spent.
      await expectRefused(local.port, { cookie, origin: 'https://evil.example' }, 403);
      await expectRefused(local.port, { cookie, origin: null }, 403);
      expect(session).not.toHaveBeenCalled();
      expect(limit).not.toHaveBeenCalled();

      // No session: the limit, which is the user's, is not taken.
      await expectRefused(local.port, {}, 401);
      expect(session).toHaveBeenCalledTimes(1);
      // NFR-SE-17 (f): the row, never the copy in the cookie.
      expect(session.mock.calls[0]![0]).toMatchObject({ query: { disableCookieCache: true } });
      expect(limit).not.toHaveBeenCalled();
      expect(account).not.toHaveBeenCalled();

      // Accepted: the session, then the limit, then the account's row for the gate.
      expect((await handshake(local.port, { cookie })).status).toBe(101);
      expect(session).toHaveBeenCalledTimes(2);
      expect(limit).toHaveBeenCalledTimes(1);
      expect(session.mock.invocationCallOrder[1]!).toBeLessThan(limit.mock.invocationCallOrder[0]!);
      expect(limit.mock.invocationCallOrder[0]!).toBeLessThan(account.mock.invocationCallOrder[0]!);
    } finally {
      await local.stop();
    }
  });

  it('refuses where what it depends on cannot answer, and says nothing of the fault (NFR-SE-06, A10)', async () => {
    const local = await inProcess();
    try {
      const { cookie, email } = await person();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(auth().api, 'getSession').mockRejectedValueOnce(new Error(`Failing row contains (${email}).`));
      await expectRefused(local.port, { cookie }, 500);
      vi.spyOn(valkey(), 'eval').mockRejectedValueOnce(new Error('ECONNREFUSED redis://secret@host'));
      await expectRefused(local.port, { cookie }, 500);
      expect(errors.mock.calls).toEqual(Array(2).fill(['collab: handshake failed (Error)']));
    } finally {
      await local.stop();
    }
  });

  it('refuses every handshake once it is stopping', async () => {
    const local = await inProcess();
    const { cookie } = await person();
    const port = local.port;
    // The listener is kept open here, as a socket already accepted by the system would be.
    vi.spyOn(local.httpServer, 'close').mockImplementation(() => local.httpServer);
    expect(await local.stop()).toBe(true);
    await expectRefused(port, { cookie }, 503);
    vi.restoreAllMocks();
    local.httpServer.close();
  });
});

describe('what is recorded for a connection, and a role that cannot edit (NFR-SE-03 (a), FR-ED-20)', () => {
  it('records the user, the document, the role, its permissions, and the session presented', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      await connect(local.port, owner.cookie).open(id).synced;
      const session = await db().session.findFirstOrThrow({ where: { userId: owner.id } });

      const connections = local.hocuspocus.documents.get(id)!.getConnections();
      expect(connections).toHaveLength(1);
      expect(connections[0]!.readOnly).toBe(false);
      expect(connections[0]!.context).toEqual({
        userId: owner.id,
        documentId: id,
        role: 'owner',
        // Every permission of FR-ED-44 but the one the Owner never holds.
        permissions: Object.keys(PERMISSIONS).filter((permission) => permission !== 'document.leave'),
        sessionId: session.id,
      });
    } finally {
      await local.stop();
    }
  });

  // Only the Owner exists until sharing is built, so the role is handed to the
  // server here in place of the answer of `authorise`. Everything after that
  // answer is the real server and the real client.
  it('discards every update received on a connection held as Viewer', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const viewer = await person();
      const id = await documentOf(owner.id);
      const document = await db().document.findUniqueOrThrow({ where: { id } });
      answers.set(`${viewer.id} ${id}`, { outcome: 'allowed', role: 'viewer', document });

      const writing = connect(local.port, owner.cookie).open(id);
      const reading = connect(local.port, viewer.cookie).open(id);
      expect(await writing.outcome).toEqual({ scope: 'read-write' });
      expect(await reading.outcome).toEqual({ scope: 'readonly' });
      await Promise.all([writing.synced, reading.synced]);
      const held = local.hocuspocus.documents.get(id)!;
      expect(
        held
          .getConnections()
          .map(({ context, readOnly }) => [context.role, readOnly])
          .sort(),
      ).toEqual([
        ['owner', false],
        ['viewer', true],
      ]);

      // The Viewer receives what the Owner writes.
      writing.changes.push(['from the Owner']);
      await until(() => reading.changes.length === 1);
      // What the Viewer writes stays in the Viewer's own client.
      reading.changes.push(['from the Viewer']);
      await sleep(400);
      expect(held.getArray('changes').toArray()).toEqual(['from the Owner']);
      expect(writing.changes.toArray()).toEqual(['from the Owner']);
      // It is never acknowledged, and never stored.
      expect(reading.provider.unsyncedChanges).toBeGreaterThan(0);
      await until(async () => (await stored(id))?.length === 1, 3000);
      await sleep(300);
      expect(await stored(id)).toEqual(['from the Owner']);
    } finally {
      await local.stop();
    }
  });

  it('logs the refusal of a role that does not hold the permission, and answers it as any other (NFR-SE-19)', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      answers.set(`${owner.id} ${id}`, { outcome: 'forbidden' });
      const client = connect(local.port, owner.cookie);
      expect(await client.open(id).outcome).toEqual({ refused: REFUSAL.NO_ACCESS });
      await sleep(100);
      expect(client.frames.map(({ type, rest }) => ({ type, rest }))).toEqual([
        { type: AUTH, rest: denied('no-access') },
      ]);
      expect(await logged()).toEqual([{ kind: 'forbidden', userId: owner.id, documentId: id }]);
      expect(local.hocuspocus.documents.size).toBe(0);
    } finally {
      await local.stop();
    }
  });

  it('opens nothing where the authorisation or the load fails, and says nothing of the fault', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const quoting = new Error(`Failing row contains (${owner.email}, ${CONTENT}).`);

      // The load: the one query that selects the content.
      const find = vi.spyOn(db().document, 'findUniqueOrThrow').mockRejectedValueOnce(quoting);
      const first = connect(local.port, owner.cookie);
      const refused = first.open(id);
      await until(() => first.framesFor(id).some((each) => each.rest === denied('unavailable')));
      expect(first.frames.some((each) => each.type === SYNC || each.type === SYNC_REPLY)).toBe(false);
      expect(refused.changes.toArray()).toEqual([]);
      find.mockRestore();

      // The authorisation.
      vi.spyOn(db().document, 'findUnique').mockRejectedValueOnce(quoting);
      const second = connect(local.port, owner.cookie);
      expect(await second.open(id).outcome).toEqual({ refused: REFUSAL.UNAVAILABLE });

      expect(errors.mock.calls).toEqual([
        ['collab: load failed (Error)'],
        ['collab: authorisation failed (Error)'],
      ]);
      expect(local.hocuspocus.documents.size).toBe(0);
    } finally {
      await local.stop();
    }
  });
});
