// Deleting a document, the list of deleted documents, restoring one, the
// closing of its connections on every collaboration server instance, and the
// permanent deletion by the timer (FR-ED-36, FR-ED-40 (c); NFR-SE-03 (b), (d);
// NFR-RE-15; NFR-SE-19; contract IC-50), against a provisioned database, the
// real Valkey, and the real collaboration server: two processes of `node
// src/collab/server.ts`, as tests/integration/collab.test.ts starts one.
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import type { Access } from '../../src/lib/documents/access.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('deletion');
const { auth, db, valkey, settings } = await load();

// An answer `authorise` gives once, for the one test that needs an
// authorisation older than a deletion (see "a handshake that crosses").
const stale = new Map<string, Access>();
vi.doMock('../../src/lib/documents/access.ts', async (original) => {
  const actual = await original<typeof import('../../src/lib/documents/access.ts')>();
  return {
    ...actual,
    authorise: (userId: string, documentId: unknown, permission: never) => {
      const key = `${userId} ${String(documentId)}`;
      const answer = stale.get(key);
      stale.delete(key);
      return answer ?? actual.authorise(userId, documentId, permission);
    },
  };
});
const { authorise, authoriseDeleted } = await import('../../src/lib/documents/access.ts');
const { createDocument, renameDocument } = await import('../../src/lib/documents/documents.ts');
const { CLAIM_STALE_MS, deleteDocument, deleteExpiredDocuments, listDeletedDocuments, restoreDocument } =
  await import('../../src/lib/documents/deletion.ts');
const { istorico } = await import('../../src/lib/istorico/index.ts');
const { deleteExpiredSecurityLog, securityLogIn } = await import('../../src/lib/security-log.ts');
const { applyState } = await import('../../src/lib/collab/state.ts');
const { COLLAB_PATH, REFUSAL } = await import('../../src/lib/collab/protocol.ts');
const { COLLAB_EVENTS_CHANNEL, publishCollabEvent, readEvent, subscribeCollabEvents } =
  await import('../../src/lib/collab/events.ts');
const { createCollabServer, ENDED_MEMORY_MAX } = await import('../../src/collab/server.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const one = await import('../../src/app/api/documents/[id]/route.ts');
const deletedList = await import('../../src/app/api/documents/deleted/route.ts');
const restoring = await import('../../src/app/api/documents/[id]/restore/route.ts');

const UNKNOWN = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
// Two texts no log line and no message may hold (NFR-SE-19): a title, and content.
const TITLE = 'title-that-no-log-may-hold';
const CONTENT = 'content-that-no-log-may-hold';

// ── The routes, called as Next.js calls them ────────────────────────────────

const request = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

const list = (cookie: string) => collection.GET(request('GET', '/api/documents', cookie));
const read = (cookie: string, id: string) =>
  one.GET(request('GET', `/api/documents/${id}`, cookie), context(id));
const rename = (cookie: string, id: string) =>
  one.PATCH(request('PATCH', `/api/documents/${id}`, cookie, { title: 'Another' }), context(id));
const remove = (cookie: string, id: string) =>
  one.DELETE(request('DELETE', `/api/documents/${id}`, cookie), context(id));
const listDeleted = (cookie: string) => deletedList.GET(request('GET', '/api/documents/deleted', cookie));
const restore = (cookie: string, id: string) =>
  restoring.POST(request('POST', `/api/documents/${id}/restore`, cookie), context(id));

let people = 0;
async function person() {
  const email = `owner${++people}@example.com`;
  const id = await createAccount(auth, email);
  const signedIn = async () => cookiesOf(await signIn(auth, email));
  return { id, email, signedIn, cookie: await signedIn() };
}
/** A document of this account, with a title no log may hold. */
async function documentOf(userId: string): Promise<string> {
  const { id } = await createDocument(userId);
  await db().document.update({ where: { id }, data: { title: TITLE } });
  return id;
}
const row = (id: string) => db().document.findUnique({ where: { id } });
const exists = async (id: string) => (await row(id)) !== null;
const logged = () =>
  db().securityLogEntry.findMany({ select: { kind: true, userId: true, documentId: true } });
/** Marks a document as deleted this long ago, as the deletion would have. */
const deletedAgo = (id: string, userId: string, ms: number) =>
  db().document.update({
    where: { id },
    data: { deletedAt: new Date(Date.now() - ms), deletedById: userId },
  });

/** Everything of a response that a caller can see. */
async function seen(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: Buffer.from(await response.arrayBuffer()).toString('hex'),
  };
}
async function idsOf(response: Response): Promise<string[]> {
  expect(response.status).toBe(200);
  return ((await response.json()).documents as { id: string }[]).map((each) => each.id);
}

// ── What is published ───────────────────────────────────────────────────────

// Every message on the channel, as a subscriber of this test's own hears it.
const heard: string[] = [];
const ear = new Redis(process.env.VALKEY_URL!);
await ear.subscribe(COLLAB_EVENTS_CHANNEL);
ear.on('message', (_channel, message) => heard.push(message));
const heardFor = (id: string) => heard.filter((message) => message.includes(id));

// ── The collaboration server: two processes ─────────────────────────────────

const children: ChildProcess[] = [];

async function startServer() {
  const child = spawn('node', ['src/collab/server.ts'], {
    env: { ...process.env, COLLAB_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const port = await new Promise<number>((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const match = /listening on (\d+)/.exec(stdout);
      if (match) resolve(Number(match[1]));
    });
    child.once('exit', () => reject(new Error(`the collaboration server did not start: ${stderr}`)));
  });
  return { port, child, stderr: () => stderr };
}

// NFR-SE-03 (d): "every collaboration server instance". Two, on one Valkey.
const [first, second] = await Promise.all([startServer(), startServer()]);

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
// The type of the frame that closes the connection to one document (@hocuspocus/server, types.ts).
const CLOSE = 7;
/** The rest of that frame: the reason, as a string with its length. */
const because = (reason: string) => Buffer.from([reason.length, ...Buffer.from(reason)]).toString('hex');

const sockets: HocuspocusProviderWebsocket[] = [];

/** One socket of a signed-in browser, and a document opened on it. */
function open(port: number, cookie: string, name: string) {
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
  const provider = new HocuspocusProvider({ websocketProvider: socket, name });
  const outcome = new Promise<{ scope?: string; refused?: string }>((resolve) => {
    provider.on('authenticated', ({ scope }: { scope: string }) => resolve({ scope }));
    provider.on('authenticationFailed', ({ reason }: { reason: string }) => resolve({ refused: reason }));
  });
  const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  // What the provider tells the editor when the server closes the document.
  const closedBecause: string[] = [];
  provider.on('close', ({ event }: { event: { reason?: string } }) => closedBecause.push(event.reason ?? ''));
  provider.attach();
  /** The frame that closed this document, once there is one. */
  const closed = () => frames.find((each) => each.name === name && each.type === CLOSE);
  return {
    provider,
    outcome,
    synced,
    closed,
    closedBecause,
    changes: provider.document.getArray<string>('changes'),
  };
}

async function until<T>(look: () => T | Promise<T>, within = 5000, every = 20): Promise<NonNullable<T>> {
  const end = Date.now() + within;
  for (;;) {
    const value = await look();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${within} ms`);
    await sleep(every);
  }
}

/** The changes in the stored state of a document, or null where none is stored. */
async function stored(id: string): Promise<string[] | null> {
  const found = await db().document.findUnique({ where: { id }, select: { yjsState: true } });
  if (!found?.yjsState) return null;
  const document = new Y.Doc();
  applyState(document, found.yjsState);
  return document.getArray<string>('changes').toArray();
}

/** Stores these changes as the state of a document, as a collaboration server would have. */
async function storedAs(id: string, changes: string[]) {
  const state = new Y.Doc();
  state.getArray('changes').push(changes);
  await db().document.update({
    where: { id },
    data: { yjsState: Y.encodeStateAsUpdate(state) as Uint8Array<ArrayBuffer> },
  });
}

/** The same server, in this process, for what cannot be seen from outside one. */
async function local() {
  const collab = createCollabServer(settings());
  await new Promise<void>((resolve) => collab.httpServer.listen(0, resolve));
  await collab.listenForEvents();
  return { ...collab, port: (collab.httpServer.address() as AddressInfo).port };
}

beforeEach(async () => {
  await db().securityLogEntry.deleteMany();
});
afterEach(() => {
  vi.restoreAllMocks();
  stale.clear();
  for (const socket of sockets.splice(0)) socket.destroy();
});
afterAll(async () => {
  for (const child of children) child.kill('SIGKILL');
  ear.disconnect();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

// ── Deleting ────────────────────────────────────────────────────────────────

describe('deleting a document (FR-ED-36, FR-ED-44)', () => {
  it('is the Owner’s: another account is answered as for a document that does not exist, byte for byte', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.id);

    const refused = await seen(await remove(other.cookie, id));
    expect(refused.status).toBe(404);
    expect(refused).toEqual(await seen(await remove(other.cookie, UNKNOWN)));
    expect((await row(id))!.deletedAt).toBeNull();
    expect(await logged()).toEqual([]);
    expect(heardFor(id)).toEqual([]);
  });

  it('marks the document, writes the entry, and answers a 204 with nothing in it', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const before = (await row(id))!;
    const from = Date.now();

    const response = await remove(owner.cookie, id);
    expect(response.status).toBe(204);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('');

    const after = (await row(id))!;
    expect(after.deletedAt!.getTime()).toBeGreaterThanOrEqual(from - 1000);
    expect(after.deletedAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(after.deletedById).toBe(owner.id);
    expect(after.deletionClaimedAt).toBeNull();
    // Nothing else of the row is touched: it is what a restore returns.
    expect({ ...after, deletedAt: null, deletedById: null }).toEqual(before);
    // NFR-SE-19: the time, the kind, the user, the document, and nothing else.
    expect(await logged()).toEqual([{ kind: 'document_deleted', userId: owner.id, documentId: id }]);
  });

  it('takes the document out of the list, and out of every request and handshake about it', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const kept = await documentOf(owner.id);
    expect(await idsOf(await list(owner.cookie))).toEqual([kept, id]);
    expect((await remove(owner.cookie, id)).status).toBe(204);

    expect(await idsOf(await list(owner.cookie))).toEqual([kept]);
    const gone = await seen(await read(owner.cookie, UNKNOWN));
    expect(gone.status).toBe(404);
    expect(await seen(await read(owner.cookie, id))).toEqual(gone);
    expect((await rename(owner.cookie, id)).status).toBe(404);
    expect((await row(id))!.title).toBe(TITLE);
    // A second deletion finds nothing to delete, and writes no second entry.
    expect((await remove(owner.cookie, id)).status).toBe(404);
    expect(await logged()).toHaveLength(1);
    // The handshake of the collaboration server asks the same function.
    expect(await authorise(owner.id, id, 'document.view')).toEqual({ outcome: 'not_found' });

    const refused = open(first.port, await owner.signedIn(), id);
    expect(await refused.outcome).toEqual({ refused: REFUSAL.NO_ACCESS });
  });

  it('answers the second of two deletions that run together as for a document that is gone', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const document = (await row(id))!;
    // Both were authorised while the document was there.
    const outcomes = await Promise.all([
      deleteDocument(document, owner.id),
      deleteDocument(document, owner.id),
    ]);
    expect(outcomes.sort()).toEqual([false, true]);
    expect(await logged()).toHaveLength(1);
    expect(heardFor(id)).toHaveLength(1);
  });

  it('reads the row of the session: an ended session deletes and restores nothing, although its signed copy still stands', async () => {
    const owner = await person();
    const live = await documentOf(owner.id);
    const gone = await documentOf(owner.id);
    expect((await remove(owner.cookie, gone)).status).toBe(204);
    const before = [await row(live), await row(gone)];
    await db().securityLogEntry.deleteMany();
    await db().session.deleteMany({ where: { userId: owner.id } });

    // A read is still answered from the signed copy, for up to a minute (NFR-SE-17 (c)).
    expect(await idsOf(await list(owner.cookie))).toEqual([live]);
    expect(await idsOf(await listDeleted(owner.cookie))).toEqual([gone]);
    // What changes state is refused at once.
    for (const response of [await remove(owner.cookie, live), await restore(owner.cookie, gone)]) {
      expect(response.status).toBe(401);
      expect((await response.json()).error.code).toBe('unauthenticated');
    }
    expect([await row(live), await row(gone)]).toEqual(before);
    expect(await logged()).toEqual([]);
  });

  // PINNED: neither handler reads a body, so nothing in one is refused and
  // nothing in one is used.
  it('reads no body: an Owner, a time and a title sent with a deletion or a restore change nothing', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.id);
    const before = (await row(id))!;
    const body = {
      ownerId: other.id,
      deletedAt: '2000-01-01T00:00:00.000Z',
      deletedById: other.id,
      title: 'Changed',
    };

    const from = Date.now();
    const path = `/api/documents/${id}`;
    expect((await one.DELETE(request('DELETE', path, owner.cookie, body), context(id))).status).toBe(204);
    const deleted = (await row(id))!;
    expect(deleted.deletedAt!.getTime()).toBeGreaterThanOrEqual(from - 1000);
    expect(deleted.deletedById).toBe(owner.id);
    expect({ ...deleted, deletedAt: null, deletedById: null }).toEqual(before);

    const restored = await restoring.POST(
      request('POST', `${path}/restore`, owner.cookie, body),
      context(id),
    );
    expect(restored.status).toBe(200);
    expect((await restored.json()).title).toBe(TITLE);
    expect(await row(id)).toEqual(before);
  });
});

describe('a deletion beside an edit (FR-ED-36: restored "as they were at deletion")', () => {
  it('leaves the time of a rename that committed beside it: authorised before the rename, written after', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    // The row as the DELETE request read it when it was authorised.
    const authorised = (await row(id))!;
    await sleep(20);
    const answered = await renameDocument(id, 'Renamed beside the deletion');
    const renamed = (await row(id))!;
    // A rename is an edit: it moves the time, and answers with the row it wrote.
    expect(renamed.updatedAt.getTime()).toBeGreaterThan(authorised.updatedAt.getTime());
    expect(answered).toMatchObject({ title: 'Renamed beside the deletion', updatedAt: renamed.updatedAt });

    await sleep(20);
    expect(await deleteDocument(authorised, owner.id)).toBe(true);
    const deleted = (await row(id))!;
    // A deletion is not: the time is not moved, forwards or back.
    expect({ ...deleted, deletedAt: null, deletedById: null }).toEqual(renamed);

    // Nor is a restore, and it answers with the row as it is, not as it was authorised.
    await sleep(20);
    expect(await restoreDocument(deleted)).toMatchObject({
      title: 'Renamed beside the deletion',
      updatedAt: renamed.updatedAt,
    });
    expect(await row(id)).toEqual(renamed);
  });

  it('renames nothing of a deleted document: authorised before the deletion, written after', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const allowed = await authorise(owner.id, id, 'document.rename');
    expect(allowed.outcome).toBe('allowed');
    expect((await remove(owner.cookie, id)).status).toBe(204);
    const deleted = (await row(id))!;
    await sleep(20);

    expect(await renameDocument(id, 'Renamed while deleted')).toBeNull();
    // The route: its authorisation is a moment older than the deletion.
    stale.set(`${owner.id} ${id}`, allowed);
    const refused = await seen(await rename(owner.cookie, id));
    expect(refused.status).toBe(404);
    expect(refused).toEqual(await seen(await rename(owner.cookie, UNKNOWN)));
    // Neither the title nor the time.
    expect(await row(id)).toEqual(deleted);

    // So a restore returns the row as it was at deletion, whole.
    expect((await restore(owner.cookie, id)).status).toBe(200);
    expect(await row(id)).toEqual({ ...deleted, deletedAt: null, deletedById: null });
    // And an edit of the restored document moves the time again.
    await sleep(20);
    expect((await rename(owner.cookie, id)).status).toBe(200);
    const edited = (await row(id))!;
    expect(edited.title).toBe('Another');
    expect(edited.updatedAt.getTime()).toBeGreaterThan(deleted.updatedAt.getTime());
  });
});

describe('the entry of a deletion (NFR-SE-19)', () => {
  it('is written in the transaction of the deletion: where it cannot be written, nothing is deleted', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The database refuses the entry, with an error that quotes the statement.
    database.sql('ALTER TABLE "SecurityLogEntry" RENAME TO "SecurityLogEntryAway"');
    let response: Response;
    try {
      response = await remove(owner.cookie, id);
    } finally {
      database.sql('ALTER TABLE "SecurityLogEntryAway" RENAME TO "SecurityLogEntry"');
    }
    expect(response.status).toBe(500);
    const after = (await row(id))!;
    expect(after.deletedAt).toBeNull();
    expect(after.deletedById).toBeNull();
    // Nothing was committed, so nothing was published.
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
    expect(await idsOf(await list(owner.cookie))).toEqual([id]);
    // One line, with the class and code of the fault and nothing of the row.
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]![0]).toMatch(/^documents: request failed \([A-Za-z0-9 ]+\)$/);
  });

  it('does not stand without the deletion: a transaction that is not committed leaves no entry', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const document = (await row(id))!;
    // The transaction of the deletion, undone after everything in it has run.
    const transact = db().$transaction.bind(db()) as unknown as (
      run: (client: never) => Promise<unknown>,
    ) => Promise<unknown>;
    vi.spyOn(db(), '$transaction').mockImplementation(((run: (client: never) => Promise<unknown>) =>
      transact(async (client) => {
        await run(client);
        throw new Error('not committed');
      })) as never);

    await expect(deleteDocument(document, owner.id)).rejects.toThrow('not committed');
    expect((await row(id))!.deletedAt).toBeNull();
    // An entry written outside the transaction would be here.
    expect(await logged()).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
  });

  it('rejects, and names nothing, for a kind outside the list', async () => {
    await expect(
      db().$transaction((transaction) =>
        securityLogIn(transaction, { kind: 'someone@example.com' as never }),
      ),
    ).rejects.toThrow('security log: unknown kind');
    expect(await logged()).toEqual([]);
  });

  it('is not written for a restore, which NFR-SE-19 does not list', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    await remove(owner.cookie, id);
    await db().securityLogEntry.deleteMany();
    expect((await restore(owner.cookie, id)).status).toBe(200);
    expect(await logged()).toEqual([]);
  });
});

// ── The channel ─────────────────────────────────────────────────────────────

describe('the notice of a deletion (NFR-SE-03 (d), NFR-SE-19)', () => {
  it('is published once, after the commit, and holds the kind and the identifier and nothing else', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    // Whether the deletion was committed when the notice was handed to Valkey.
    const committed: boolean[] = [];
    const publish = valkey().publish.bind(valkey());
    vi.spyOn(valkey(), 'publish').mockImplementation(async (...sent: unknown[]) => {
      // A second connection: it sees only what is committed.
      committed.push(
        database.sql(`SELECT "deletedAt" IS NOT NULL FROM "Document" WHERE id = '${id}'`).endsWith('t'),
      );
      return (publish as (...all: unknown[]) => Promise<number>)(...sent);
    });
    expect((await remove(owner.cookie, id)).status).toBe(204);
    await until(() => heardFor(id).length > 0);
    expect(committed).toEqual([true]);
    expect(heardFor(id)).toEqual([`{"kind":"document-deleted","documentId":"${id}"}`]);
  });

  it('that cannot be published leaves the deletion committed, and says so in one line', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fault = Object.assign(new Error(`connect ECONNREFUSED valkey.example.test:6379 ${TITLE}`), {
      code: 'ECONNREFUSED',
    });
    vi.spyOn(valkey(), 'publish').mockRejectedValue(fault);

    const response = await remove(owner.cookie, id);
    expect(response.status).toBe(204);
    expect((await row(id))!.deletedAt).not.toBeNull();
    expect(await logged()).toEqual([{ kind: 'document_deleted', userId: owner.id, documentId: id }]);
    // NFR-SE-19: the line names the document by its identifier, and nothing else of it.
    expect(errors.mock.calls).toEqual([
      [`collab events: document-deleted not published for document ${id} (Error ECONNREFUSED)`],
    ]);
  });

  it('is read as data: what is no event of the list is no event', () => {
    const id = UNKNOWN;
    expect(readEvent(`{"kind":"document-deleted","documentId":"${id}"}`)).toEqual({
      kind: 'document-deleted',
      documentId: id,
    });
    // Nothing else a message carries goes further.
    expect(readEvent(`{"kind":"document-deleted","documentId":"${id}","title":"${TITLE}"}`)).toEqual({
      kind: 'document-deleted',
      documentId: id,
    });
    for (const message of [
      '',
      'not json',
      'null',
      '[]',
      '{}',
      `{"kind":"document-restored","documentId":"${id}"}`,
      '{"kind":"document-deleted"}',
      '{"kind":"document-deleted","documentId":7}',
      `{"kind":"document-deleted","documentId":"${id.toUpperCase()}"}`,
      `{"kind":"document-deleted","documentId":"${id} "}`,
    ]) {
      expect(readEvent(message), message).toBeNull();
    }
  });

  it('reaches a subscriber again after its connection was lost, and survives a handler that throws or rejects', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const received: string[] = [];
    const subscription = subscribeCollabEvents((event) => {
      received.push('documentId' in event ? event.documentId : event.userId);
      const fault = new Error(`a handler that quotes ${TITLE}`);
      // The first throws, and every other rejects.
      if (received.length === 1) throw fault;
      return Promise.reject(fault);
    });
    try {
      await subscription.subscribed;
      const before = '11111111-1111-4111-8111-111111111111';
      const rejected = '33333333-3333-4333-8333-333333333333';
      const after = '22222222-2222-4222-8222-222222222222';
      expect(await publishCollabEvent({ kind: 'document-deleted', documentId: before })).toBe(true);
      await until(() => errors.mock.calls.length === 1);
      expect(await publishCollabEvent({ kind: 'document-deleted', documentId: rejected })).toBe(true);
      await until(() => errors.mock.calls.length === 2);
      expect(errors.mock.calls).toEqual([
        [`collab events: document-deleted not handled for document ${before} (Error)`],
        [`collab events: document-deleted not handled for document ${rejected} (Error)`],
      ]);

      // The connection is lost, as when Valkey restarts or the network drops it.
      const ready = new Promise<void>((resolve) => subscription.client.once('ready', () => resolve()));
      subscription.client.stream.destroy();
      await ready;
      // A notice published while it was away is lost; one published after is heard.
      await until(async () => {
        await publishCollabEvent({ kind: 'document-deleted', documentId: after });
        return received.includes(after);
      });
    } finally {
      subscription.client.disconnect();
    }
  });
});

// ── The open connections ────────────────────────────────────────────────────

describe('the connections to a deleted document (FR-ED-40 (c), NFR-SE-03 (b))', () => {
  it(
    'are closed within 5 seconds on every instance, with the reason; what was received is stored, and nothing after; a restore returns it',
    { timeout: 30_000 },
    async () => {
      const owner = await person();
      const id = await documentOf(owner.id);
      const other = await documentOf(owner.id);
      const onFirst = open(first.port, owner.cookie, id);
      const onSecond = open(second.port, await owner.signedIn(), id);
      const untouched = open(first.port, await owner.signedIn(), other);
      expect(await onFirst.outcome).toEqual({ scope: 'read-write' });
      expect(await onSecond.outcome).toEqual({ scope: 'read-write' });
      await Promise.all([onFirst.synced, onSecond.synced, untouched.synced]);

      onFirst.changes.push(['before']);
      await until(async () => (await stored(id))?.length === 1);
      // A change that is received, and acknowledged, and not yet stored when
      // the document is deleted: the deletion comes at once, long before the
      // store that was waiting for it (NFR-RE-07: up to 2 seconds).
      onFirst.changes.push([CONTENT]);
      await until(() => onFirst.provider.unsyncedChanges === 0, 1000, 5);
      expect(await stored(id)).toEqual(['before']);

      const at = Date.now();
      expect((await remove(owner.cookie, id)).status).toBe(204);
      await until(() => onFirst.closed() && onSecond.closed(), 5000);
      expect(Date.now() - at).toBeLessThan(5000);
      // FR-ED-41: "Changes already merged into the document before the close
      // remain". The instance that held the change stored it before it closed
      // the connection; the other, which held nothing new, stored nothing over it.
      expect(await stored(id)).toEqual(['before', CONTENT]);
      // The reason is all that tells the client why (src/lib/collab/protocol.ts).
      expect(onFirst.closed()!.rest).toBe(because(REFUSAL.ACCESS_ENDED));
      expect(onSecond.closed()!.rest).toBe(because('access-ended'));
      expect(onFirst.closedBecause).toContain('access-ended');
      expect(onSecond.closedBecause).toContain('access-ended');

      // Longer than both periods of the store (NFR-RE-07): nothing more was written.
      const deleted = (await row(id))!;
      await sleep(3000);
      expect(await stored(id)).toEqual(['before', CONTENT]);
      expect(await row(id)).toEqual(deleted);
      // The connection to another document of the same account was left alone.
      expect(untouched.closed()).toBeUndefined();
      untouched.changes.push(['still open']);
      await until(async () => (await stored(other))?.length === 1);

      // A reconnection is refused at the handshake of the document.
      expect(await open(second.port, await owner.signedIn(), id).outcome).toEqual({
        refused: REFUSAL.NO_ACCESS,
      });

      // FR-ED-36: restored, it is the document as it was at deletion, with
      // the change that had not been stored when it was deleted.
      const restored = await restore(owner.cookie, id);
      expect(restored.status).toBe(200);
      // The answer is the row as it is, the time of the last store among it.
      expect((await restored.json()).updatedAt).toBe(deleted.updatedAt.toISOString());
      expect(await row(id)).toEqual({ ...deleted, deletedAt: null, deletedById: null });
      expect(await stored(id)).toEqual(['before', CONTENT]);
      const again = open(second.port, await owner.signedIn(), id);
      expect(await again.outcome).toEqual({ scope: 'read-write' });
      await again.synced;
      expect(again.changes.toArray()).toEqual(['before', CONTENT]);
    },
  );

  it(
    'takes nothing a client sends between the last store and the close: it is neither stored nor acknowledged',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const client = open(collab.port, owner.cookie, id);
        await client.synced;
        client.changes.push(['received']);
        await until(() => client.provider.unsyncedChanges === 0);

        // The last store is slow, and a change arrives while it is being written.
        const write = db().document.updateMany.bind(db().document) as (query: unknown) => Promise<unknown>;
        const slow = vi.spyOn(db().document, 'updateMany').mockImplementationOnce((async (query: unknown) => {
          await sleep(500);
          return write(query);
        }) as never);
        expect((await remove(owner.cookie, id)).status).toBe(204);
        await until(() => slow.mock.calls.length === 1);
        const conditions = () => slow.mock.calls.map(([query]) => (query as { where: object }).where);
        // The condition of the one store that writes to a deleted document: that the row exists.
        expect(conditions()[0]).toEqual({ id });
        client.changes.push(['late']);

        await until(() => client.closed());
        expect(client.closed()!.rest).toBe(because(REFUSAL.ACCESS_ENDED));
        expect(client.provider.unsyncedChanges).toBeGreaterThan(0);
        await sleep(2500);
        expect(await stored(id)).toEqual(['received']);
        // One store for the deletion, and no other: the one that was waiting found a deleted document.
        expect(conditions().filter((where) => !('deletedAt' in where))).toHaveLength(1);
      } finally {
        await collab.stop();
      }
    },
  );

  it(
    'are closed all the same where the last store fails, with one line, and the state stored before stays',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const client = open(collab.port, owner.cookie, id);
        await client.synced;
        client.changes.push(['before']);
        await until(async () => (await stored(id))?.length === 1);
        client.changes.push([CONTENT]);
        await until(() => client.provider.unsyncedChanges === 0);

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        // The database fails at the last store, with an error that quotes the row.
        const lost = Object.assign(new Error(`connection lost ${TITLE} ${CONTENT}`), { code: 'P1001' });
        vi.spyOn(db().document, 'updateMany').mockRejectedValueOnce(lost);
        expect((await remove(owner.cookie, id)).status).toBe(204);
        await until(() => client.closed());
        expect(client.closed()!.rest).toBe(because(REFUSAL.ACCESS_ENDED));
        expect(errors.mock.calls).toEqual([[`collab: last store of document ${id} failed (Error P1001)`]]);
        // What is lost is what had not been stored, and nothing else.
        await sleep(2500);
        expect(await stored(id)).toEqual(['before']);
        expect(errors.mock.calls).toHaveLength(1);
      } finally {
        await collab.stop();
      }
    },
  );

  it(
    'are closed as unavailable where the row cannot be read: the client tries again, and its handshake reads the row',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const client = open(collab.port, owner.cookie, id);
        await client.synced;

        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const lost = Object.assign(new Error(`connection lost ${TITLE}`), { code: 'P1001' });
        const find = db().document.findUnique.bind(db().document) as (query: unknown) => Promise<unknown>;
        // The one query of a notice, and no other: it selects `deletedAt` alone.
        // And of THIS document's notice. The channel has one name in the
        // Valkey that every run on a machine shares, so this server also hears
        // the notices of whatever else is running, and of the test before
        // this one: were their query to fail too, each would print its line,
        // and the line counted below would not be the only one.
        type Query = { select?: object; where?: { id?: string } };
        vi.spyOn(db().document, 'findUnique').mockImplementation(((query: Query) =>
          Object.keys(query.select ?? {}).join() === 'deletedAt' && query.where?.id === id
            ? Promise.reject(lost)
            : find(query)) as never);
        // A notice for a document that is NOT deleted, which nothing can tell here.
        await publishCollabEvent({ kind: 'document-deleted', documentId: id });
        await until(() => client.closed());
        expect(client.closed()!.rest).toBe(because(REFUSAL.UNAVAILABLE));
        expect(errors.mock.calls).toEqual([[`collab: document ${id} not read for a notice (Error P1001)`]]);
        vi.restoreAllMocks();
        // The document is live: the handshake of a client that tries again admits it.
        expect(await open(collab.port, await owner.signedIn(), id).outcome).toEqual({ scope: 'read-write' });
      } finally {
        await collab.stop();
      }
    },
  );

  it(
    'are left alone by a notice for a document that is not deleted: forged, or delivered after a restore',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      // Anything that can reach Valkey: no session, no role, no deletion.
      const forger = new Redis(process.env.VALKEY_URL!);
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const marker = await documentOf(owner.id);
        const client = open(collab.port, owner.cookie, id);
        const witness = open(collab.port, await owner.signedIn(), marker);
        await Promise.all([client.synced, witness.synced]);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const notice = (documentId: string) =>
          forger.publish(COLLAB_EVENTS_CHANNEL, JSON.stringify({ kind: 'document-deleted', documentId }));
        /** A real deletion published after `publish`, and acted on: what was published before it was read before it. */
        const settled = async () => {
          expect((await remove(owner.cookie, marker)).status).toBe(204);
          await until(() => witness.closed());
          await sleep(200);
        };

        // Forged: the row says the document is live.
        await notice(id);
        await settled();
        expect(client.closed()).toBeUndefined();
        expect(client.closedBecause).toEqual([]);
        client.changes.push(['typed after the forged notice']);
        await until(async () => (await stored(id))?.length === 1);

        // Genuine, and late: the Owner has restored the document since. The
        // connection made after the restore is not closed by the old notice.
        expect((await remove(owner.cookie, id)).status).toBe(204);
        await until(() => client.closed());
        expect((await restore(owner.cookie, id)).status).toBe(200);
        const after = open(collab.port, await owner.signedIn(), id);
        await after.synced;
        await notice(id);
        await sleep(500);
        expect(after.closed()).toBeUndefined();
        after.changes.push(['typed after the late notice']);
        await until(async () => (await stored(id))?.length === 2);
        // Nothing is printed for a notice that the row does not bear out.
        expect(errors.mock.calls).toEqual([]);
      } finally {
        forger.disconnect();
        await collab.stop();
      }
    },
  );

  it(
    'remembers at most 1,000 deletions, whatever number of notices arrive',
    { timeout: 30_000 },
    async () => {
      const collab = await local();
      const flood = new Redis(process.env.VALKEY_URL!);
      try {
        expect(ENDED_MEMORY_MAX).toBe(1000);
        // Identifiers of no document: a row that is not there counts as deleted.
        const ids = Array.from({ length: ENDED_MEMORY_MAX + 200 }, () => crypto.randomUUID());
        const pipeline = flood.pipeline();
        for (const documentId of ids) {
          pipeline.publish(COLLAB_EVENTS_CHANNEL, JSON.stringify({ kind: 'document-deleted', documentId }));
        }
        await pipeline.exec();
        await until(() => collab.remembered() >= ENDED_MEMORY_MAX, 20_000);
        await sleep(1000);
        expect(collab.remembered()).toBe(ENDED_MEMORY_MAX);
      } finally {
        flood.disconnect();
        await collab.stop();
      }
    },
  );

  it('lets the document go from the memory of the instance', { timeout: 20_000 }, async () => {
    const collab = await local();
    try {
      const owner = await person();
      const id = await documentOf(owner.id);
      const client = open(collab.port, owner.cookie, id);
      await client.synced;
      client.changes.push([CONTENT]);
      await until(() => client.provider.unsyncedChanges === 0);
      expect(collab.hocuspocus.documents.has(id)).toBe(true);

      expect((await remove(owner.cookie, id)).status).toBe(204);
      await until(() => client.closed());
      await until(() => !collab.hocuspocus.documents.has(id));
      // With what it had received, which was stored before the close (FR-ED-41).
      expect(await stored(id)).toEqual([CONTENT]);
    } finally {
      await collab.stop();
    }
  });

  it(
    'closes a connection whose handshake crossed the deletion, and not one made after a restore',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        await storedAs(id, ['kept']);
        const allowed = await authorise(owner.id, id, 'document.view');
        expect(allowed.outcome).toBe('allowed');

        expect((await remove(owner.cookie, id)).status).toBe(204);
        await until(() => heardFor(id).length > 0);
        await sleep(100);
        // The handshake was authorised a moment before the deletion was
        // committed, and its connection is made a moment after the notice.
        stale.set(`${owner.id} ${id}`, allowed);
        const crossed = open(collab.port, owner.cookie, id);
        expect(await crossed.outcome).toEqual({ scope: 'read-write' });
        await until(() => crossed.closed());
        expect(crossed.closed()!.rest).toBe(because(REFUSAL.ACCESS_ENDED));
        // PINNED, with its reasoning in the `connected` hook: before it was
        // closed the connection was sent the state, which its account was
        // authorised to read when the handshake ran.
        expect(crossed.changes.toArray()).toEqual(['kept']);

        // Restored within the moments the instance remembers the deletion for:
        // the connection is asked again, is allowed, and stays.
        expect((await restore(owner.cookie, id)).status).toBe(200);
        const after = open(collab.port, await owner.signedIn(), id);
        expect(await after.outcome).toEqual({ scope: 'read-write' });
        await after.synced;
        after.changes.push(['after the restore']);
        await until(async () => (await stored(id))?.length === 2);
        expect(after.closed()).toBeUndefined();
      } finally {
        await collab.stop();
      }
    },
  );

  it(
    'forgets a deletion after 15 seconds: a connection made later is not asked a second time',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const allowed = await authorise(owner.id, id, 'document.view');
        expect((await remove(owner.cookie, id)).status).toBe(204);
        await until(() => heardFor(id).length > 0);
        await sleep(200);

        // The clock alone is moved: the timers and the sockets are the real ones.
        vi.useFakeTimers({ toFake: ['Date'] });
        const crossing = async (ms: number) => {
          vi.setSystemTime(Date.now() + ms);
          stale.set(`${owner.id} ${id}`, allowed);
          const made = open(collab.port, await owner.signedIn(), id);
          expect(await made.outcome).toEqual({ scope: 'read-write' });
          return made;
        };
        // A second short of 15 after the notice: still remembered, asked again, closed.
        const remembered = await crossing(14_000);
        await until(() => remembered.closed());
        // A second past it: forgotten. The answer of the handshake is all there was.
        const forgotten = await crossing(2000);
        await forgotten.synced;
        await sleep(500);
        expect(forgotten.closed()).toBeUndefined();
      } finally {
        vi.useRealTimers();
        await collab.stop();
      }
    },
  );

  it(
    'hears a deletion again after the instance lost its connection to Valkey',
    { timeout: 20_000 },
    async () => {
      const collab = await local();
      try {
        const owner = await person();
        const id = await documentOf(owner.id);
        const client = open(collab.port, owner.cookie, id);
        await client.synced;

        const subscriber = collab.eventsClient()!;
        const ready = new Promise<void>((resolve) => subscriber.once('ready', () => resolve()));
        subscriber.stream.destroy();
        await ready;
        await sleep(200);

        expect((await remove(owner.cookie, id)).status).toBe(204);
        await until(() => client.closed());
        expect(client.closed()!.rest).toBe(because(REFUSAL.ACCESS_ENDED));
      } finally {
        await collab.stop();
      }
    },
  );
});

// ── The list of deleted documents, and restoring ────────────────────────────

describe('the list of deleted documents (FR-ED-36; API design, "Documents")', () => {
  it('shows the Owner the documents within their retention, each with the day it is deleted permanently', async () => {
    const owner = await person();
    const other = await person();
    const live = await documentOf(owner.id);
    const earlier = await documentOf(owner.id);
    const later = await documentOf(owner.id);
    const ended = await documentOf(owner.id);
    const claimed = await documentOf(owner.id);
    const theirs = await documentOf(other.id);
    await deletedAgo(earlier, owner.id, 30 * DAY_MS - MINUTE_MS);
    await deletedAgo(ended, owner.id, 30 * DAY_MS + MINUTE_MS);
    await deletedAgo(claimed, owner.id, DAY_MS);
    await db().document.update({ where: { id: claimed }, data: { deletionClaimedAt: new Date() } });
    expect((await remove(owner.cookie, later)).status).toBe(204);
    expect((await remove(other.cookie, theirs)).status).toBe(204);

    const response = await listDeleted(owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const { documents } = await response.json();
    // The last deleted first; not one that is not deleted, whose retention has
    // ended, that the timer has claimed, or that is another account's.
    expect(documents.map((each: { id: string }) => each.id)).toEqual([later, earlier]);
    expect(Object.keys(documents[0])).toEqual([
      'id',
      'title',
      'recording',
      'createdAt',
      'updatedAt',
      'deletedAt',
      'permanentDeletionAt',
    ]);
    const { deletedAt } = (await row(later))!;
    expect(documents[0].deletedAt).toBe(deletedAt!.toISOString());
    // "Retained for 30 days (an initial value)".
    expect(documents[0].permanentDeletionAt).toBe(new Date(deletedAt!.getTime() + 30 * DAY_MS).toISOString());

    expect(await idsOf(await listDeleted(other.cookie))).toEqual([theirs]);
    expect(await idsOf(await list(owner.cookie))).toEqual([live]);
    expect((await listDeletedDocuments(owner.id)).map((each) => each.id)).toEqual([later, earlier]);
  });
});

describe('restoring a document (FR-ED-36, FR-ED-44)', () => {
  it('is the Owner’s: another account is answered as for a document that does not exist, byte for byte', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.id);
    expect((await remove(owner.cookie, id)).status).toBe(204);

    const refused = await seen(await restore(other.cookie, id));
    expect(refused.status).toBe(404);
    expect(refused).toEqual(await seen(await restore(other.cookie, UNKNOWN)));
    // And as the document routes answer it, to the byte.
    expect(refused).toEqual(await seen(await remove(other.cookie, UNKNOWN)));
    expect((await row(id))!.deletedAt).not.toBeNull();
    expect(await authoriseDeleted(other.id, id)).toEqual({ outcome: 'not_found' });
  });

  it('returns the document as it was at deletion', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const state = new Y.Doc();
    state.getArray('changes').push(['kept']);
    await db().document.update({
      where: { id },
      data: { yjsState: Y.encodeStateAsUpdate(state) as Uint8Array<ArrayBuffer> },
    });
    const before = (await row(id))!;
    expect((await remove(owner.cookie, id)).status).toBe(204);

    const response = await restore(owner.cookie, id);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      id,
      title: TITLE,
      recording: 'UNRECORDED',
      createdAt: before.createdAt.toISOString(),
      updatedAt: before.updatedAt.toISOString(),
    });
    // The whole row, the permission set and the two marks among it.
    expect(await row(id)).toEqual(before);
    expect(await stored(id)).toEqual(['kept']);
    expect(await idsOf(await list(owner.cookie))).toEqual([id]);
    expect(await idsOf(await listDeleted(owner.cookie))).toEqual([]);
    expect((await read(owner.cookie, id)).status).toBe(200);
  });

  it('is refused for a document that is not deleted, as for one that does not exist', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    const refused = await seen(await restore(owner.cookie, id));
    expect(refused.status).toBe(404);
    expect(refused).toEqual(await seen(await restore(owner.cookie, UNKNOWN)));
  });

  it('is refused once the retention has ended, and allowed a minute before', async () => {
    const owner = await person();
    const ended = await documentOf(owner.id);
    const inTime = await documentOf(owner.id);
    await deletedAgo(ended, owner.id, 30 * DAY_MS + MINUTE_MS);
    await deletedAgo(inTime, owner.id, 30 * DAY_MS - MINUTE_MS);

    const refused = await seen(await restore(owner.cookie, ended));
    expect(refused.status).toBe(404);
    expect(refused).toEqual(await seen(await restore(owner.cookie, UNKNOWN)));
    expect((await row(ended))!.deletedAt).not.toBeNull();
    // Refused twice over: at the authorisation, and at the write (the next test).
    expect(await authoriseDeleted(owner.id, ended)).toEqual({ outcome: 'not_found' });
    expect((await authoriseDeleted(owner.id, inTime)).outcome).toBe('allowed');
    expect((await restore(owner.cookie, inTime)).status).toBe(200);
  });

  it('cannot take a document back from the permanent deletion: not at the authorisation, and not at the write', async () => {
    const owner = await person();
    const id = await documentOf(owner.id);
    expect((await remove(owner.cookie, id)).status).toBe(204);
    const authorised = (await row(id))!;

    await db().document.update({ where: { id }, data: { deletionClaimedAt: new Date() } });
    expect((await restore(owner.cookie, id)).status).toBe(404);
    expect(await authoriseDeleted(owner.id, id)).toEqual({ outcome: 'not_found' });
    // Authorised before the timer claimed it: the write itself refuses.
    expect(await restoreDocument(authorised)).toBeNull();
    expect((await row(id))!.deletedAt).not.toBeNull();

    // And one whose retention ended between the authorisation and the write.
    await db().document.update({ where: { id }, data: { deletionClaimedAt: null } });
    expect(await restoreDocument(authorised, new Date(Date.now() + 30 * DAY_MS))).toBeNull();
    expect(await restoreDocument(authorised)).not.toBeNull();
  });
});

// ── The permanent deletion ──────────────────────────────────────────────────

describe('the permanent deletion (FR-ED-36, NFR-RE-15; contract IC-50)', () => {
  let owner: Awaited<ReturnType<typeof person>>;
  /** A document of the owner whose retention ended a minute ago. */
  async function due(recording: 'RECORDED' | 'UNRECORDED' = 'UNRECORDED') {
    const id = await documentOf(owner.id);
    await db().document.update({ where: { id }, data: { recording } });
    await deletedAgo(id, owner.id, 30 * DAY_MS + MINUTE_MS);
    return id;
  }
  /** The port, reporting the erasure capability, which the no-op adapter never does. */
  function erasing() {
    const port = istorico();
    vi.spyOn(port, 'capabilities').mockReturnValue({ ...port.capabilities(), erasure: true });
    return vi.spyOn(port, 'erase');
  }

  beforeEach(async () => {
    // Each test begins with no deleted document of an earlier one.
    await db().document.deleteMany({ where: { deletedAt: { not: null } } });
    owner = await person();
  });

  it('deletes the documents whose retention has ended, with their state, and no other', async () => {
    const live = await documentOf(owner.id);
    const recent = await documentOf(owner.id);
    await deletedAgo(recent, owner.id, 30 * DAY_MS - MINUTE_MS);
    const ended = await due();
    const erase = vi.spyOn(istorico(), 'erase');

    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(ended)).toBe(false);
    expect((await row(live))!.deletedAt).toBeNull();
    expect((await row(recent))!.deletionClaimedAt).toBeNull();
    expect((await restore(owner.cookie, recent)).status).toBe(200);
    // The no-op adapter reports no erasure capability: no request is made.
    expect(erase).not.toHaveBeenCalled();
    // NFR-SE-19; R47 (register row D161, pending): "An entry of its own, with
    // the document's identifier and no user, written with the deletion."
    const entry = { kind: 'document_deleted_permanently', userId: null, documentId: ended };
    expect(await logged()).toEqual([entry]);
    // Idempotent: a second run finds nothing, fails nothing, and writes nothing.
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });
    expect(await logged()).toEqual([entry]);
  });

  // FR-ED-42: the notifications of a change of role and of a removal have no subject once the document is gone.
  it('takes the notifications that name the document with it, and no other', async () => {
    const ended = await due();
    const live = await documentOf(owner.id);
    const other = await person();
    const named = (documentId: string) => ({
      recipientId: other.id,
      payload: { documentId, role: 'viewer' },
    });
    await db().notification.createMany({
      data: [
        { ...named(ended), kind: 'role_changed' },
        { ...named(ended), kind: 'removed' },
        { ...named(live), kind: 'role_changed' },
      ],
    });
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    const left = await db().notification.findMany({
      where: { recipientId: other.id },
      select: { payload: true },
    });
    expect(left).toEqual([{ payload: { documentId: live, role: 'viewer' } }]);
  });

  it('leaves the entry when the document is gone, beside the entry of the Owner’s deletion, until the log’s own retention', async () => {
    const id = await documentOf(owner.id);
    expect((await remove(owner.cookie, id)).status).toBe(204);
    await deletedAgo(id, owner.id, 30 * DAY_MS + MINUTE_MS);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(id)).toBe(false);
    // The column refers to no row: nothing of the log went with the document.
    const both = [
      { kind: 'document_deleted', userId: owner.id, documentId: id },
      { kind: 'document_deleted_permanently', userId: null, documentId: id },
    ];
    expect(await logged()).toEqual(both);
    // The log deletes by the time alone (NFR-RE-15): nothing yet.
    expect(await deleteExpiredSecurityLog()).toBe(0);
    expect(await logged()).toEqual(both);
  });

  /**
   * Makes the next transaction fail where it writes its entry: before the
   * entry is written, or, with `written`, after it. Either way everything the
   * transaction did must be undone, the deletion of the row and the entry.
   */
  function faultAtEntry(written: boolean) {
    type Work = (tx: Record<string, unknown>) => Promise<unknown>;
    const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
    const original = client.$transaction.bind(client);
    vi.spyOn(client, '$transaction').mockImplementationOnce((work) =>
      original((tx) => {
        const entries = tx.securityLogEntry as { create: (...args: unknown[]) => Promise<unknown> };
        const failing = new Proxy(entries, {
          get: (target, key) =>
            key === 'create'
              ? async (...args: unknown[]) => {
                  if (written) await target.create(...args);
                  throw new Error('the transaction failed at its entry');
                }
              : Reflect.get(target, key),
        });
        return work(
          new Proxy(tx, {
            get: (target, key) => (key === 'securityLogEntry' ? failing : Reflect.get(target, key)),
          }),
        );
      }),
    );
  }

  it.each([
    ['where the entry cannot be written, the document is not deleted', false],
    ['where the transaction fails after the entry, neither the deletion nor the entry stands', true],
  ])('writes the entry in the transaction of the deletion: %s', async (_name, written) => {
    const id = await due();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    faultAtEntry(written);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 1 });
    expect(errors.mock.calls).toEqual([[`permanent deletion: document ${id} kept (Error)`]]);
    // The row stands, with its state and its claim, and there is no entry.
    expect((await row(id))!.deletionClaimedAt).not.toBeNull();
    expect(await logged()).toEqual([]);
    // The run that finds the claim an hour old deletes it, and writes the one entry.
    expect(await deleteExpiredDocuments(new Date(Date.now() + CLAIM_STALE_MS + MINUTE_MS))).toEqual({
      deleted: 1,
      kept: 0,
    });
    expect(await exists(id)).toBe(false);
    expect(await logged()).toEqual([{ kind: 'document_deleted_permanently', userId: null, documentId: id }]);
  });

  it('makes no request to Istorico for a recorded document either, while the adapter reports no erasure', async () => {
    const id = await due('RECORDED');
    const erase = vi.spyOn(istorico(), 'erase');
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    expect(erase).not.toHaveBeenCalled();
    expect(await exists(id)).toBe(false);
  });

  it('asks Istorico first where it reports the capability and the document is recorded, and only then deletes', async () => {
    const recorded = await due('RECORDED');
    const unrecorded = await due('UNRECORDED');
    const erase = erasing();
    // Whether the row was still there when Istorico was asked.
    const there: boolean[] = [];
    erase.mockImplementation(async (input) => {
      there.push(await exists(input.documents[0]!.documentId));
      return { ok: true, value: [{ documentId: input.documents[0]!.documentId, outcome: 'erased' }] };
    });

    expect(await deleteExpiredDocuments()).toEqual({ deleted: 2, kept: 0 });
    // FR-ED-36: "for an unrecorded document … Ekdotico makes no request".
    expect(erase.mock.calls).toEqual([
      [
        {
          requestId: recorded,
          subjectUserId: owner.id,
          documents: [{ documentId: recorded, role: 'owner', workspaceKind: 'personal' }],
        },
      ],
    ]);
    expect(there).toEqual([true]);
    expect(await exists(recorded)).toBe(false);
    expect(await exists(unrecorded)).toBe(false);
  });

  it.each([
    ['is unavailable', async () => ({ ok: false, error: 'unavailable', retryable: true }) as const],
    [
      'holds the document',
      async (id: string) => ({ ok: true, value: [{ documentId: id, outcome: 'held' }] }) as const,
    ],
    // IC-29: only `erased` and `no-record` are followed by the deletion of the rows.
    [
      'pseudonymises and does not erase',
      async (id: string) => ({ ok: true, value: [{ documentId: id, outcome: 'pseudonymised' }] }) as const,
    ],
    [
      'answers with an outcome this version does not know',
      async (id: string) => ({ ok: true, value: [{ documentId: id, outcome: 'erased-in-part' }] }) as const,
    ],
    [
      'answers for another document',
      async () => ({ ok: true, value: [{ documentId: UNKNOWN, outcome: 'erased' }] }) as const,
    ],
    ['answers nothing', async () => ({ ok: true, value: [] }) as const],
    [
      'throws, which the port does not',
      async () => {
        throw new Error(`istorico quotes ${TITLE}`);
      },
    ],
  ])('keeps the document where Istorico %s, and asks again at the next run', async (_case, answer) => {
    const id = await due('RECORDED');
    const other = await due('UNRECORDED');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const erase = erasing();
    erase.mockImplementation((input) => answer(input.documents[0]!.documentId) as never);

    // One document that is kept does not hold the other back.
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 1 });
    expect(await exists(other)).toBe(false);
    const kept = (await row(id))!;
    expect(kept.deletedAt).not.toBeNull();
    // The claim is released at once, so the next run need not wait an hour.
    expect(kept.deletionClaimedAt).toBeNull();
    // NFR-SE-19: the line names the document by its identifier, and holds
    // nothing else of it: not its title, which the thrown error quoted.
    expect(errors.mock.calls).toHaveLength(1);
    expect([
      `permanent deletion: document ${id} kept (Istorico did not erase)`,
      `permanent deletion: document ${id} kept (Error)`,
    ]).toContain(errors.mock.calls[0]![0]);

    erase.mockImplementation(async (input) => ({
      ok: true,
      value: [{ documentId: input.documents[0]!.documentId, outcome: 'no-record' }],
    }));
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    expect(await exists(id)).toBe(false);
    expect(erase).toHaveBeenCalledTimes(2);
  });

  it('marks each claim with the moment it was made, and not with the start of the run', async () => {
    await due('RECORDED');
    await due('RECORDED');
    const erase = erasing();
    // The mark of each claim, read while Istorico, which is slow, is being asked.
    const marks: number[] = [];
    erase.mockImplementation(async (input) => {
      const id = input.documents[0]!.documentId;
      marks.push((await row(id))!.deletionClaimedAt!.getTime());
      await sleep(300);
      return { ok: true, value: [{ documentId: id, outcome: 'erased' }] };
    });
    const from = Date.now();
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 2, kept: 0 });
    expect(marks).toHaveLength(2);
    expect(marks[0]).toBeGreaterThanOrEqual(from - 5);
    // A claim marked with the start of a long run would be an hour old, and
    // another instance's to take over, while the run was still at work on it.
    expect(marks[1]! - marks[0]!).toBeGreaterThanOrEqual(250);
    expect(marks[1]).toBeLessThanOrEqual(Date.now());
  });

  it('deletes each document once under two runs at the same moment', async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => due('RECORDED')));
    const erase = erasing();
    const outcomes = await Promise.all([deleteExpiredDocuments(), deleteExpiredDocuments()]);
    // Together they deleted every document, and neither failed or kept one.
    expect(outcomes[0].deleted + outcomes[1].deleted).toBe(ids.length);
    expect(outcomes[0].kept + outcomes[1].kept).toBe(0);
    for (const id of ids) expect(await exists(id)).toBe(false);
    // The claim: each document was one run's, so Istorico was asked once for each.
    expect(erase.mock.calls.map(([input]) => input.requestId).sort()).toEqual([...ids].sort());
    // And one entry for each, whichever run deleted it.
    expect((await logged()).map((each) => each.documentId).sort()).toEqual([...ids].sort());
  });

  it('writes one entry where two runs reach the deletion of one document together', async () => {
    const id = await due('RECORDED');
    // Both hold the claim: the second took it over while the first waited for Istorico.
    const erase = erasing();
    let second: Promise<{ deleted: number; kept: number }> | undefined;
    erase.mockImplementation(async (input) => {
      const answer = {
        ok: true as const,
        value: [{ documentId: input.documents[0]!.documentId, outcome: 'erased' as const }],
      };
      if (second) return answer;
      second = deleteExpiredDocuments(new Date(Date.now() + CLAIM_STALE_MS + MINUTE_MS));
      await second;
      return answer;
    });
    const first = await deleteExpiredDocuments();
    expect(first.deleted + (await second!).deleted).toBe(1);
    expect(await exists(id)).toBe(false);
    expect(await logged()).toEqual([{ kind: 'document_deleted_permanently', userId: null, documentId: id }]);
  });

  it('deletes each document once under two processes, and neither fails', { timeout: 30_000 }, async () => {
    const ids = await Promise.all(Array.from({ length: 12 }, () => due()));
    const run = () =>
      new Promise<{ code: number | null; deleted: number; kept: number; stderr: string }>((resolve) => {
        const child = spawn('node', ['tests/integration/delete-expired.ts'], { env: process.env });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.once('exit', (code) => resolve({ code, ...JSON.parse(stdout.trim() || '{}'), stderr }));
      });
    const outcomes = await Promise.all([run(), run()]);
    expect(outcomes.map((each) => each.code)).toEqual([0, 0]);
    expect(outcomes.map((each) => each.stderr)).toEqual(['', '']);
    expect(outcomes[0]!.deleted + outcomes[1]!.deleted).toBe(ids.length);
    expect(outcomes[0]!.kept + outcomes[1]!.kept).toBe(0);
    for (const id of ids) expect(await exists(id)).toBe(false);
    // One entry for each document, whichever process deleted it.
    expect(await logged()).toHaveLength(ids.length);
    expect((await logged()).map((each) => each.documentId).sort()).toEqual([...ids].sort());
  });

  it('leaves a document another run has claimed, and takes over a claim that was never finished', async () => {
    const id = await due('RECORDED');
    const erase = erasing();
    const claimedAgo = (ms: number) =>
      db().document.update({ where: { id }, data: { deletionClaimedAt: new Date(Date.now() - ms) } });

    // Claimed a moment ago: it is that run's.
    await claimedAgo(MINUTE_MS);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(id)).toBe(true);
    // A minute short of an hour: still.
    await claimedAgo(CLAIM_STALE_MS - MINUTE_MS);
    const { deletionClaimedAt } = (await row(id))!;
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });
    expect((await row(id))!.deletionClaimedAt).toEqual(deletionClaimedAt);
    expect(erase).not.toHaveBeenCalled();

    // An hour old: its process stopped before it finished. The run begins
    // again from the first step, which can be repeated.
    await claimedAgo(CLAIM_STALE_MS + MINUTE_MS);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 1, kept: 0 });
    expect(erase).toHaveBeenCalledTimes(1);
    expect(await exists(id)).toBe(false);
  });

  it('finishes at the next run a deletion that was interrupted after Istorico erased', async () => {
    const id = await due('RECORDED');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const erase = erasing();
    // The database fails at the last step, with an error that quotes a row.
    const lost = Object.assign(new Error(`connection lost ${TITLE}`), { code: 'P1001' });
    // The last step is a transaction since it writes its entry with the deletion.
    vi.spyOn(db(), '$transaction').mockRejectedValueOnce(lost);

    const from = Date.now();
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 1 });
    expect(errors.mock.calls).toEqual([[`permanent deletion: document ${id} kept (Error P1001)`]]);
    // Istorico has erased, so the claim is kept: no other run begins beside this one.
    const { deletionClaimedAt } = (await row(id))!;
    expect(deletionClaimedAt!.getTime()).toBeGreaterThanOrEqual(from - 1000);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });

    // The run that finds the claim an hour old finishes the deletion.
    expect(await deleteExpiredDocuments(new Date(Date.now() + CLAIM_STALE_MS + MINUTE_MS))).toEqual({
      deleted: 1,
      kept: 0,
    });
    expect(erase).toHaveBeenCalledTimes(2);
    expect(await exists(id)).toBe(false);
  });

  it('does not delete a document that was restored after the run had listed it', async () => {
    const id = await due();
    const listed = await db().document.findMany({
      where: { id },
      select: { id: true, ownerId: true, recording: true },
    });
    // Restored a minute before its retention ended, as the run was beginning.
    await db().document.update({ where: { id }, data: { deletedAt: null, deletedById: null } });
    vi.spyOn(db().document, 'findMany').mockResolvedValueOnce(listed as never);
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });
    expect((await row(id))!.deletionClaimedAt).toBeNull();
  });

  it('does not delete what a run that took the claim over is deleting', async () => {
    const id = await due('RECORDED');
    const erase = erasing();
    // While this run waits for Istorico, its claim is taken over by another.
    erase.mockImplementation(async (input) => {
      await db().document.update({
        where: { id },
        data: { deletionClaimedAt: new Date(Date.now() + MINUTE_MS) },
      });
      return { ok: true, value: [{ documentId: input.documents[0]!.documentId, outcome: 'erased' }] };
    });
    expect(await deleteExpiredDocuments()).toEqual({ deleted: 0, kept: 0 });
    expect(await exists(id)).toBe(true);
  });
});

// ── What was written ────────────────────────────────────────────────────────

describe('what was said of it all (NFR-SE-19)', () => {
  it('holds no title and no content: not a message, and not a line of either collaboration server', () => {
    expect(heard.length).toBeGreaterThan(0);
    for (const text of [...heard, first.stderr(), second.stderr()]) {
      expect(text).not.toContain(TITLE);
      expect(text).not.toContain(CONTENT);
      expect(text).not.toContain('example.com');
    }
    for (const message of heard) {
      expect(message).toMatch(/^\{"kind":"document-deleted","documentId":"[0-9a-f-]{36}"\}$/);
    }
    expect(first.child.exitCode).toBeNull();
    expect(second.child.exitCode).toBeNull();
  });
});
