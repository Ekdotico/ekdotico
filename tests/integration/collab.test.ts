// The collaboration server (FR-AU-08; NFR-SE-03, lead paragraph, (a) and (f);
// NFR-SE-07; NFR-RE-07; FR-AU-83), against the real process: `node
// src/collab/server.ts`, started here on a free port with the test database
// and Valkey. The clients are the real provider of the editor, over Node's own
// WebSocket, and set `Cookie` and `Origin` themselves as a browser would.
//
// A few tests need to look inside the server, and run the same server object
// in this process: they are the groups after "The same server, in this process".
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { connect as tcp, type AddressInfo } from 'node:net';
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
const { createCollabServer, originRefusalMark } = await import('../../src/collab/server.ts');

const UNKNOWN = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
// A text no log may hold (NFR-SE-19): it is written into documents below.
const CONTENT = 'content-that-no-log-may-hold';
const HANDLE_HEADER = 'x-ekdotico-handshake';

// ── The server process ──────────────────────────────────────────────────────

const children: ChildProcess[] = [];
// What each process this file started has written to stderr, for the last test of the processes.
const written: (() => string)[] = [];

async function startServer(env: Record<string, string> = {}, port = 0) {
  const child = spawn('node', ['src/collab/server.ts'], {
    env: { ...process.env, ...env, COLLAB_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  written.push(() => stderr);
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
  /** Further headers of the request. */
  headers?: Record<string, string>;
}

/** One handshake, as the upgrade request a browser sends, and what the server answered to it. */
function handshake(port: number, { cookie, origin = ORIGIN, path = COLLAB_PATH, headers }: Asked = {}) {
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
        ...headers,
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
// travels in the first and the last of these, and in no other.
const SYNC = 0;
const AUTH = 2;
const SYNC_REPLY = 4;
const CLOSE = 7;
const SYNC_STATUS = 8;
// What a frame of the two types that carry state holds (y-protocols, sync.js).
const STEP_2 = 1;
const UPDATE = 2;
/** The rest of the frame that refuses a document: "permission denied", and the reason. */
const denied = (reason: string) => Buffer.from([1, reason.length, ...Buffer.from(reason)]).toString('hex');

/** A number as the frames write one. */
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
/** The frame that opens a document: authentication, by a token, which is empty. */
const opening = (name: string) => sent(name, AUTH, 0, 0);

/** An update a client could send: it adds one change. */
function forgedUpdate(change = 'forged'): Uint8Array {
  const forged = new Y.Doc();
  forged.getArray('changes').push([change]);
  return Y.encodeStateAsUpdate(forged);
}
/**
 * An update of 32 bytes that Yjs 13.6.33 applies, and whose state it then
 * encodes in a form it cannot read again: three structs of 2^55 in a row for
 * one client, and an empty set of deletions (src/lib/collab/state.ts).
 */
const POISON = Buffer.from([1, 3, 7, 0, ...[1, 2, 3].flatMap(() => [0, ...varint(2 ** 55)]), 0]);

const sockets: HocuspocusProviderWebsocket[] = [];

/** One socket of a signed-in browser, which carries as many documents as are opened on it. */
function connect(port: number, cookie: string, headers: Record<string, string> = {}) {
  const frames: ReturnType<typeof frame>[] = [];
  class Socket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie, origin: ORIGIN, ...headers } } as never);
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

/**
 * The upgrade request as bytes on a bare TCP connection, for what no WebSocket
 * client does: going away in the middle of the handshake, and asking for a
 * version of the protocol that does not exist.
 */
function upgradeOver(port: number, headers: Record<string, string>, version = '13') {
  const socket = tcp({ host: '127.0.0.1', port });
  socket.on('error', () => {});
  let answer = '';
  socket.on('data', (chunk) => (answer += chunk));
  const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
  socket.on('connect', () =>
    socket.write(
      [
        `GET ${COLLAB_PATH} HTTP/1.1`,
        'Host: app.example.test',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Version: ${version}`,
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '\r\n',
      ].join('\r\n'),
    ),
  );
  return { socket, closed, status: () => Number(/^HTTP\/1\.1 (\d+)/.exec(answer)?.[1]) };
}

/** A client that sends the upgrade request and resets the connection `after` ms later. */
async function abandon(port: number, headers: Record<string, string>, after: number) {
  const { socket, closed } = upgradeOver(port, headers);
  socket.on('connect', () => setTimeout(() => socket.resetAndDestroy(), after));
  await closed;
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
  // Each test begins in a period in which no refused origin has been logged.
  await valkey().del(originRefusalMark());
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
    for (const path of [
      '/',
      '/collab/',
      '/collab?document=1',
      '/collab?',
      '/COLLAB',
      '/collab/health',
      '/collab/x',
      // Other writings of the same place, which a server in front, or a
      // library behind, might read as the path.
      '//collab',
      '/./collab',
      '/%63ollab',
      '/collab%2F',
      '/collab%3F',
      'http://app.example.test/collab',
      `${ORIGIN}/collab`,
    ]) {
      await expectRefused(server.port, { cookie, path }, 404);
    }
    expect((await handshake(server.port, { cookie })).status).toBe(101);
  });
});

describe('a handshake from another origin (FR-AU-08, NFR-SE-17 (c))', () => {
  // NFR-SE-19 lists "a 403 response". This 403 needs no session and comes
  // before every limit, so it is read as one entry for each period in which an
  // origin was refused, and not one for each request: the reading the owner has
  // been asked to confirm for a limit that is reached and for a signature that
  // does not verify. The cookie was not read, so no user is named.
  const ENTRY = { kind: 'forbidden', userId: null, documentId: null };

  it('is refused with a 403 whatever cookie it carries, and logged once for the period', async () => {
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
    // The other process marks the same period: the mark is in Valkey.
    for (const origin of origins) await expectRefused(team.port, { cookie, origin }, 403);
    await until(async () => (await logged()).length > 0);
    await sleep(200);
    expect(await logged()).toEqual([ENTRY]);

    // The next period: one more entry.
    await valkey().del(originRefusalMark());
    for (const origin of origins) await expectRefused(server.port, { cookie, origin }, 403);
    await until(async () => (await logged()).length > 1);
    await sleep(200);
    expect(await logged()).toEqual([ENTRY, ENTRY]);
  });

  it('is refused where the request carries no Origin header at all', async () => {
    const { cookie } = await person();
    await expectRefused(server.port, { cookie, origin: null }, 403);
    await until(async () => (await logged()).length > 0);
    expect(await logged()).toEqual([ENTRY]);
  });

  it('holds the mark of the period for a minute, under a name that says nothing', async () => {
    await expectRefused(server.port, { origin: 'https://evil.example' }, 403);
    const mark = originRefusalMark();
    expect(mark).toMatch(/^limit-logged:[0-9a-f]{64}$/);
    const seconds = await until(async () => {
      const left = await valkey().ttl(mark);
      return left > 0 ? left : 0;
    });
    expect(seconds).toBeGreaterThan(50);
    expect(seconds).toBeLessThanOrEqual(60);
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

describe('a client that goes away during the handshake (NFR-RE-07)', () => {
  // Node takes its own 'error' listener off a socket before it hands the
  // socket over for an upgrade. A reset while the checks ran, or before the
  // refusal was written, was an 'error' nobody listened for, and ended the
  // process: for everyone, and with what was not yet stored lost.
  it(
    'does not end the process, whatever the handshake would have been answered',
    { timeout: 60_000 },
    async () => {
      const instance = await startServer();
      const owner = await person();
      const id = await documentOf(owner.id);
      const before = connect(instance.port, owner.cookie).open(id);
      await before.synced;
      before.changes.push(['before the resets']);
      await until(() => before.provider.unsyncedChanges === 0, 1000, 5);

      // Another account's session, so that the 30 handshakes spent are not the Owner's.
      const session = { Origin: ORIGIN, Cookie: (await person()).cookie };
      for (const headers of [{ Origin: 'https://evil.example' }, { Origin: ORIGIN }, session]) {
        for (let round = 0; round < 8; round++) {
          // At once, and at each of the moments a check is waiting on the database or on Valkey.
          for (const after of [0, 1, 2, 3, 5]) await abandon(instance.port, headers, after);
          await sleep(20);
        }
      }
      await sleep(300);

      expect(instance.child.exitCode).toBeNull();
      expect((await fetch(`http://127.0.0.1:${instance.port}/collab/health`)).status).toBe(200);
      // A client connects and is sent the document, and what was received before the resets is stored.
      const after = connect(instance.port, await owner.signedIn()).open(id);
      await after.synced;
      expect(after.changes.toArray()).toEqual(['before the resets']);
      await until(async () => (await stored(id))?.length === 1, 3000);
      // 120 resets, and at most one line for them, which names no one.
      const lines = instance
        .stderr()
        .split('\n')
        .filter((line) => line.startsWith('collab:'));
      expect(lines.length).toBeLessThanOrEqual(1);
      for (const line of lines) expect(line).toMatch(/^collab: socket failed \(\w+\)$/);
    },
  );
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

    // A change every 250 ms for 21 seconds: never 2 seconds without one, and
    // long enough for a second store, without which the gap below is no gap.
    const began = Date.now();
    let made = 0;
    const editing = setInterval(() => changes.push([`change ${++made}`]), 250);
    const stores: number[] = [];
    try {
      let last = 0;
      while (Date.now() - began < 21_000) {
        const count = (await stored(id))?.length ?? 0;
        if (count > last) stores.push(Date.now() - began);
        last = count;
        await sleep(25);
      }
    } finally {
      clearInterval(editing);
    }
    // The first store came while the changes still did, within 10 seconds of
    // the first of them, and the next within 10 seconds of that one.
    expect(stores.length).toBeGreaterThanOrEqual(2);
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

  it(
    'tries a store that failed again, and says so on stderr by the class of the fault alone',
    { timeout: 30_000 },
    async () => {
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
        // Two more attempts fail, 1 and 3 seconds after the first.
        await sleep(3500);
      } finally {
        database.sql('ALTER TABLE "Document" RENAME COLUMN "yjsStateAway" TO "yjsState"');
      }
      // The next attempt is 4 seconds after the third.
      await until(async () => (await stored(id))?.includes(CONTENT), 6000);
      await until(() => /recovered/.test(server.stderr().slice(before)));
      // One line for the failure and one for the recovery, not one for each attempt.
      const lines = server.stderr().slice(before).trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^collab: store failed \(\w+\)$/);
      expect(lines[1]).toBe('collab: store recovered');
    },
  );
});

describe('a state that cannot be loaded (NFR-RE-07)', () => {
  // Nothing of the application writes such a state (the next test, and the
  // group "what is kept out of a document" below). These are written to the row.
  it(
    'opens for no one, is said on stderr by the class of the fault, and the process goes on',
    { timeout: 30_000 },
    async () => {
      const owner = await person();
      const good = Y.encodeStateAsUpdate(
        (() => {
          const document = new Y.Doc();
          document.getArray('changes').push([CONTENT, CONTENT]);
          return document;
        })(),
      );
      const poisoned = new Y.Doc();
      Y.applyUpdate(poisoned, POISON);
      const states: [string, Uint8Array][] = [
        ['bytes that are no state', Buffer.alloc(64, 0xff)],
        ['a state cut short', good.subarray(0, good.length - 7)],
        ['a state Yjs wrote and cannot read', Y.encodeStateAsUpdate(poisoned)],
      ];
      for (const [label, state] of states) {
        const id = await documentOf(owner.id);
        await db().document.update({ where: { id }, data: { yjsState: Buffer.from(state) } });
        const before = server.stderr().length;

        // Twice: trying again is possible, and changes nothing.
        for (let attempt = 0; attempt < 2; attempt++) {
          const client = connect(server.port, owner.cookie);
          const opened = client.open(id);
          // The Owner sees the reason "unavailable", after which a client tries again.
          await until(() => client.framesFor(id).some((each) => each.rest === denied('unavailable')));
          await sleep(100);
          expect(
            client.frames.some((each) => each.type === SYNC || each.type === SYNC_REPLY),
            label,
          ).toBe(false);
          expect(opened.changes.toArray()).toEqual([]);
        }
        expect(server.child.exitCode).toBeNull();
        // Nothing was written over it.
        const row = await db().document.findUniqueOrThrow({ where: { id }, select: { yjsState: true } });
        expect(Buffer.from(row.yjsState!).equals(Buffer.from(state)), label).toBe(true);
        const lines = server.stderr().slice(before).trim().split('\n');
        expect(lines, label).toHaveLength(2);
        for (const line of lines) expect(line).toMatch(/^collab: stored state failed \(\w+\)$/);

        // Recovery is an administrator's, by hand: here, the state is cleared, and the document opens, empty.
        await db().document.update({ where: { id }, data: { yjsState: null } });
        const client = connect(server.port, owner.cookie).open(id);
        await client.synced;
        expect(client.changes.toArray()).toEqual([]);
      }
    },
  );

  it(
    'is not written by a client that sends what Yjs cannot store: the connection is closed',
    { timeout: 30_000 },
    async () => {
      const owner = await person();
      const id = await documentOf(owner.id);
      const hostile = connect(server.port, owner.cookie);
      const mine = hostile.open(id);
      const honest = connect(server.port, await owner.signedIn()).open(id);
      await Promise.all([mine.synced, honest.synced]);
      mine.changes.push(['before']);
      await until(async () => (await stored(id))?.length === 1, 3000);

      // The update Yjs applies and cannot store, and bytes that are no update:
      // each as an update and as the second step of a synchronisation.
      for (const [inner, update] of [
        [UPDATE, POISON],
        [STEP_2, POISON],
        [UPDATE, Buffer.alloc(48, 0xff)],
        [STEP_2, Buffer.alloc(48, 0xff)],
      ] as const) {
        const client = connect(server.port, await owner.signedIn());
        await client.open(id).synced;
        // Time for the acknowledgement of the synchronisation itself.
        await sleep(200);
        const acknowledged = () => client.framesFor(id).filter((each) => each.type === SYNC_STATUS).length;
        const acknowledgedBefore = acknowledged();
        client.socket.webSocket!.send(sent(id, SYNC, inner, update));
        // The connection to the document is closed, and nothing was acknowledged.
        await until(() => client.framesFor(id).some((each) => each.type === CLOSE));
        expect(acknowledged()).toBe(acknowledgedBefore);
      }
      expect(server.child.exitCode).toBeNull();

      // The others go on, and what is stored can be read: `stored` applies it.
      honest.changes.push(['after']);
      await until(async () => (await stored(id))?.length === 2, 3000);
      expect(await stored(id)).toEqual(['before', 'after']);
      const later = connect(team.port, await owner.signedIn()).open(id);
      await later.synced;
      expect(later.changes.toArray()).toEqual(['before', 'after']);
    },
  );
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
  it('holds no address, no cookie, and nothing of a document, in any process this file started', () => {
    // The two of the whole file, and every one a test started for itself.
    expect(written.length).toBeGreaterThan(5);
    for (const read of written) {
      const stderr = read();
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

describe('the log of a refused origin never holds the refusal back (NFR-SE-19, NFR-SE-06)', () => {
  it('answers the 403 although Valkey does not answer, and the entry is still written, once', async () => {
    const local = await inProcess();
    try {
      // Valkey never answers the mark.
      const set = vi.spyOn(valkey(), 'set').mockImplementation((() => new Promise(() => {})) as never);
      const began = Date.now();
      await expectRefused(local.port, { origin: 'https://evil.example' }, 403);
      expect(Date.now() - began).toBeLessThan(1000);
      expect(set).toHaveBeenCalledTimes(1);

      // Valkey fails: the entry is written by this process's own clock, once for the period.
      set.mockRejectedValue(new Error('ECONNREFUSED redis://secret@host'));
      for (let n = 0; n < 5; n++) await expectRefused(local.port, { origin: 'https://evil.example' }, 403);
      await until(async () => (await logged()).length > 0);
      await sleep(200);
      expect(await logged()).toEqual([{ kind: 'forbidden', userId: null, documentId: null }]);
    } finally {
      await local.stop();
    }
  });
});

describe('the record of a handshake, and the socket it belongs to', () => {
  const NONE = { handshakes: 0, sockets: 0 };
  const ONE = { handshakes: 1, sockets: 1 };

  it('is not made for a socket that ended while the checks ran', async () => {
    const local = await inProcess();
    try {
      const { cookie } = await person();
      // The limit is answered 150 ms late, and the socket ends 30 ms into the
      // checks, as it does when the client resets the connection.
      const evaluate = valkey().eval.bind(valkey()) as (...args: unknown[]) => Promise<unknown>;
      const limit = vi
        .spyOn(valkey(), 'eval')
        .mockImplementation((async (...args: unknown[]) => (await sleep(150), evaluate(...args))) as never);
      local.httpServer.once('upgrade', (_request, socket) => setTimeout(() => socket.destroy(), 30));
      const client = upgradeOver(local.port, { Origin: ORIGIN, Cookie: cookie });
      await client.closed;
      await until(() => limit.mock.results.length === 1);
      await sleep(400);
      expect(client.status()).toBeNaN();
      // The handshake was allowed, and nothing was recorded for it: its socket was gone.
      expect(local.held()).toEqual(NONE);
    } finally {
      await local.stop();
    }
  });

  it('is removed when the socket ends, in every way a socket ends', async () => {
    const local = await inProcess();
    const owner = await person();
    const id = await documentOf(owner.id);
    const headers = { Origin: ORIGIN, Cookie: owner.cookie };
    try {
      // The client closes the WebSocket.
      const closing = connect(local.port, owner.cookie);
      await closing.open(id).synced;
      expect(local.held()).toEqual(ONE);
      closing.socket.destroy();
      await until(() => local.held().sockets === 0);
      expect(local.held()).toEqual(NONE);

      // The client resets the connection once it is a WebSocket, with no closing frame.
      const reset = upgradeOver(local.port, headers);
      await until(() => reset.status() === 101);
      expect(local.held()).toEqual(ONE);
      reset.socket.resetAndDestroy();
      await until(() => local.held().sockets === 0);
      expect(local.held()).toEqual(NONE);

      // The handshake passes every check here, and the library then refuses the upgrade itself.
      const refused = upgradeOver(local.port, headers, '12');
      await refused.closed;
      expect(refused.status()).toBe(400);
      await until(() => local.held().sockets === 0);
      expect(local.held()).toEqual(NONE);

      // The server stops.
      await connect(local.port, owner.cookie).open(id).synced;
      expect(local.held()).toEqual(ONE);
    } finally {
      await local.stop();
    }
    await until(() => local.held().sockets === 0);
    expect(local.held()).toEqual(NONE);
  });

  it('is found by a handle the server wrote: one a client sends is overwritten', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const other = await person();
      const id = await documentOf(owner.id);
      const own = await documentOf(other.id);
      await connect(local.port, owner.cookie).open(id).synced;
      const handleOn = (name: string) =>
        local.hocuspocus.documents.get(name)!.getConnections()[0]!.request.headers.get(HANDLE_HEADER);
      const handle = handleOn(id)!;
      expect(handle).toMatch(/^[0-9a-f-]{36}$/);

      // Another account sends the handle of the Owner's handshake as its own.
      const intruder = connect(local.port, other.cookie, { [HANDLE_HEADER]: handle });
      expect(await intruder.open(id).outcome).toEqual({ refused: REFUSAL.NO_ACCESS });
      // It is still itself: its own document opens, under a handle of its own.
      await intruder.open(own).synced;
      expect(handleOn(own)).toMatch(/^[0-9a-f-]{36}$/);
      expect(handleOn(own)).not.toBe(handle);
      expect(local.hocuspocus.documents.get(own)!.getConnections()[0]!.context.userId).toBe(other.id);
      expect(local.hocuspocus.documents.get(id)!.getConnections()).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });
});

describe('opening documents on an accepted socket (NFR-SE-07)', () => {
  it('counts each document opened against the limit of handshakes, and refuses with a reason of its own', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      const client = connect(local.port, owner.cookie);
      // The upgrade was the first of the 30; 29 documents may be opened, whatever they are.
      expect(await client.open(id).outcome).toEqual({ scope: 'read-write' });
      for (let n = 0; n < 28; n++) {
        expect(await client.open(randomUUID()).outcome).toEqual({ refused: REFUSAL.NO_ACCESS });
      }

      const queries = vi.spyOn(db().document, 'findUnique');
      for (const name of [randomUUID(), await documentOf(owner.id)]) {
        expect(await client.open(name).outcome).toEqual({ refused: REFUSAL.LIMITED });
        expect(client.framesFor(name).map(({ type, rest }) => ({ type, rest }))).toEqual([
          { type: AUTH, rest: denied('limited') },
        ]);
      }
      // Refused before the query the limit is there to bound.
      expect(queries).not.toHaveBeenCalled();
      // One limit for both: no handshake either, in this process or another.
      await expectRefused(local.port, { cookie: owner.cookie }, 429);
      await expectRefused(server.port, { cookie: await owner.signedIn() }, 429);
      // NFR-SE-19: one entry for the limit reached.
      expect(await logged()).toEqual([{ kind: 'rate_limit_reached', userId: owner.id, documentId: null }]);

      // The document that was open stays open, and another account is not held back.
      expect(local.hocuspocus.documents.get(id)!.getConnections()).toHaveLength(1);
      const other = await person();
      expect(await connect(local.port, other.cookie).open(await documentOf(other.id)).outcome).toEqual({
        scope: 'read-write',
      });
    } finally {
      await local.stop();
    }
  });

  it('opens nothing where the limit cannot be asked (NFR-SE-06, A10)', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const client = connect(local.port, owner.cookie);
      await client.open(await documentOf(owner.id)).synced;
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.spyOn(valkey(), 'eval').mockRejectedValueOnce(new Error('ECONNREFUSED redis://secret@host'));
      expect(await client.open(await documentOf(owner.id)).outcome).toEqual({ refused: REFUSAL.UNAVAILABLE });
      expect(errors.mock.calls).toEqual([['collab: limit failed (Error)']]);
    } finally {
      await local.stop();
    }
  });

  // What the library bounds by itself (@hocuspocus/server 4.7.0,
  // ClientConnection.ts, `maxPendingDocuments`): the documents of one socket
  // that are waiting for the answer to their opening at one moment. At the
  // 101st it closes the socket. It is no bound on how many are opened one after
  // another, which is what the limit above is for.
  it('is bounded by the library at 100 documents waiting on one socket, which then closes', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const socket = new WebSocket(`ws://127.0.0.1:${local.port}${COLLAB_PATH}`, {
        headers: { cookie: owner.cookie, origin: ORIGIN },
      } as never);
      const closed = new Promise<number>((resolve) =>
        socket.addEventListener('close', (event) => resolve(event.code)),
      );
      await new Promise((resolve) => socket.addEventListener('open', resolve));
      const limit = vi.spyOn(valkey(), 'eval');
      const queries = vi.spyOn(db().document, 'findUnique');
      for (let n = 0; n < 150; n++) socket.send(opening(randomUUID()));

      // "Reset Connection" (@hocuspocus/common, CloseEvents.ts).
      expect(await closed).toBe(4205);
      await sleep(300);
      // 100 were asked of the limit, and it let 29 through to the query.
      expect(limit).toHaveBeenCalledTimes(100);
      expect(queries).toHaveBeenCalledTimes(29);
      expect(warned).toHaveBeenCalledTimes(1);
      expect(warned.mock.calls[0]![0]).toContain('maxPendingDocuments 100');
      expect(local.hocuspocus.documents.size).toBe(0);
    } finally {
      await local.stop();
    }
  });
});

describe('the orderly stop, where something does not end (NFR-RE-07)', () => {
  it('gives up at its deadline, says so, and reports a failure', async () => {
    const local = await inProcess();
    const owner = await person();
    const id = await documentOf(owner.id);
    const { synced, changes, provider } = connect(local.port, owner.cookie).open(id);
    await synced;
    // A write the database never answers, until the test lets it go.
    let release = () => {};
    vi.spyOn(db().document, 'updateMany').mockImplementation(
      (() => new Promise((resolve) => (release = () => resolve({ count: 0 })))) as never,
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    changes.push(['never stored']);
    await until(() => provider.unsyncedChanges === 0, 1000, 5);

    const began = Date.now();
    expect(await local.stop(500)).toBe(false);
    expect(Date.now() - began).toBeGreaterThanOrEqual(450);
    expect(Date.now() - began).toBeLessThan(2000);
    expect(errors.mock.calls).toEqual([['collab: stop failed (deadline)']]);
    // The sockets were closed all the same.
    await until(() => local.held().sockets === 0);
    release();
  });

  it('opens no document whose load ends after the stop began, and so does not wait for one', async () => {
    const local = await inProcess();
    const owner = await person();
    const first = await documentOf(owner.id);
    const late = await documentOf(owner.id);
    const open = connect(local.port, owner.cookie).open(first);
    await open.synced;
    open.changes.push(['received, and stored by the stop']);
    await until(() => open.provider.unsyncedChanges === 0, 1000, 5);

    // The store of the first takes 600 ms, and the load of the second 250 ms:
    // the second ends its load while the stop is still storing the first.
    const update = db().document.updateMany.bind(db().document) as (args: unknown) => Promise<unknown>;
    vi.spyOn(db().document, 'updateMany').mockImplementation(((args: unknown) =>
      sleep(600).then(() => update(args))) as never);
    const find = db().document.findUniqueOrThrow.bind(db().document) as (args: unknown) => Promise<unknown>;
    const load = vi
      .spyOn(db().document, 'findUniqueOrThrow')
      .mockImplementation(((args: unknown) => sleep(250).then(() => find(args))) as never);
    const other = connect(local.port, await owner.signedIn());
    other.open(late);
    await until(() => load.mock.calls.length === 1);

    const began = Date.now();
    expect(await local.stop(5000)).toBe(true);
    expect(Date.now() - began).toBeLessThan(3000);
    expect(other.framesFor(late).some((each) => each.rest === denied('unavailable'))).toBe(true);
    expect(other.frames.some((each) => each.type === SYNC || each.type === SYNC_REPLY)).toBe(false);
    expect(local.hocuspocus.documents.size).toBe(0);
    vi.restoreAllMocks();
    expect(await stored(first)).toEqual(['received, and stored by the stop']);
  });
});

describe('a store that fails, tried again (NFR-RE-07)', () => {
  it(
    'waits twice as long after each failure, in one loop, with one line for the failure and one for the recovery',
    { timeout: 30_000 },
    async () => {
      const local = await inProcess();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const client = connect(local.port, owner.cookie);
        const { synced, changes, provider } = client.open(id);
        await synced;

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const update = db().document.updateMany.bind(db().document) as (args: unknown) => Promise<unknown>;
        const attempts: number[] = [];
        let failing = true;
        vi.spyOn(db().document, 'updateMany').mockImplementation(((args: unknown) => {
          attempts.push(Date.now());
          // An error that quotes the row, as the database's does.
          return failing ? Promise.reject(new Error(`Failing row contains (${CONTENT}).`)) : update(args);
        }) as never);

        // Changes go on all the while, so the library asks for a store every period.
        let made = 0;
        const editing = setInterval(() => changes.push([`change ${++made}`]), 250);
        try {
          // The first attempt, then one a second later and one two seconds after that.
          // (The first comes 6 seconds after the first change, since changes go on.)
          await until(() => attempts.length === 3, 12_000);
          // The fourth is four seconds after the third: none in the first two and a half.
          await sleep(2500);
        } finally {
          clearInterval(editing);
        }
        expect(attempts).toHaveLength(3);
        const gaps = [attempts[1]! - attempts[0]!, attempts[2]! - attempts[1]!];
        expect(gaps[0]).toBeGreaterThanOrEqual(950);
        expect(gaps[0]).toBeLessThan(1600);
        expect(gaps[1]).toBeGreaterThanOrEqual(1950);
        expect(gaps[1]).toBeLessThan(2600);
        expect(errors.mock.calls).toEqual([['collab: store failed (Error)']]);

        // The last client leaves: the document stays in memory, since nothing else holds its changes.
        await until(() => provider.unsyncedChanges === 0);
        client.socket.destroy();
        await until(() => local.held().sockets === 0);
        await sleep(100);
        expect(local.hocuspocus.documents.has(id)).toBe(true);
        expect(await stored(id)).toBeNull();

        // The database answers again: the next attempt stores the state as it is now, says so, and the document is let go.
        failing = false;
        await until(() => errors.mock.calls.length === 2, 6000);
        expect(errors.mock.calls[1]).toEqual(['collab: store recovered']);
        expect(attempts[3]! - attempts[2]!).toBeGreaterThanOrEqual(3950);
        expect(await stored(id)).toHaveLength(made);
        await until(() => !local.hocuspocus.documents.has(id));
      } finally {
        await local.stop();
      }
    },
  );
});

describe('what is kept out of a document, and out of its row (NFR-RE-07)', () => {
  it(
    'stores nothing that could not be loaded again, whatever put it into the document',
    { timeout: 20_000 },
    async () => {
      const local = await inProcess();
      const owner = await person();
      const id = await documentOf(owner.id);
      const { synced, changes } = connect(local.port, owner.cookie).open(id);
      await synced;
      changes.push(['stored while the document could be loaded']);
      await until(async () => (await stored(id))?.length === 1, 3000);

      // Into the document the server holds, past the check of what a client
      // sends: as a fault of Yjs that is not yet known would arrive.
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const held = local.hocuspocus.documents.get(id)!;
      applyState(held, POISON);
      changes.push(['received after it']);
      // The lines of the server. (The client of this test is sent the same
      // state and complains in this process too, which is not the server's line.)
      const lines = () => errors.mock.calls.filter(([line]) => String(line).startsWith('collab:'));
      await until(() => lines().length > 0, 4000);
      expect(lines()).toEqual([['collab: store failed (UnloadableState)']]);
      // The row holds what it held, which loads.
      expect(await stored(id)).toEqual(['stored while the document could be loaded']);
      // The stop cannot store it either, and says so by its answer.
      expect(await local.stop()).toBe(false);
      expect(await stored(id)).toEqual(['stored while the document could be loaded']);
    },
  );

  it('lets go of a document that did not load', async () => {
    const local = await inProcess();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      await db().document.update({ where: { id }, data: { yjsState: Buffer.alloc(64, 0xff) } });
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      const destroyed = vi.spyOn(Y.Doc.prototype, 'destroy');
      const client = connect(local.port, owner.cookie);
      client.open(id);
      await until(() => client.framesFor(id).some((each) => each.rest === denied('unavailable')));
      expect(errors.mock.calls).toEqual([['collab: stored state failed (Error)']]);
      expect(local.hocuspocus.documents.size).toBe(0);
      // Destroyed, and its timer with it: the library by itself only forgets it.
      expect(destroyed).toHaveBeenCalled();
    } finally {
      await local.stop();
    }
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

      const owning = connect(local.port, owner.cookie);
      const viewing = connect(local.port, viewer.cookie);
      const writing = owning.open(id);
      const reading = viewing.open(id);
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

      // Past the provider, every frame that carries an update: the second step
      // of a synchronisation and an update, under each of the two types of
      // frame that carry state, addressed as this provider addresses its
      // frames and as one with a session of its own would.
      for (const outer of [SYNC, SYNC_REPLY]) {
        for (const inner of [STEP_2, UPDATE]) {
          for (const address of [id, `${id}\0a-session`]) {
            viewing.socket.webSocket!.send(sent(address, outer, inner, forgedUpdate()));
            await sleep(100);
            expect(held.getArray('changes').toArray(), `${outer}, ${inner}`).toEqual(['from the Owner']);
          }
        }
      }
      // The same frame is no dead letter: from the Owner's socket it is applied.
      owning.socket.webSocket!.send(sent(id, SYNC, UPDATE, forgedUpdate('by hand')));
      await until(() => held.getArray('changes').length === 2);
      // It is never acknowledged, and never stored.
      expect(reading.provider.unsyncedChanges).toBeGreaterThan(0);
      await until(async () => (await stored(id))?.length === 2, 3000);
      await sleep(300);
      expect((await stored(id))!.sort()).toEqual(['by hand', 'from the Owner']);
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
