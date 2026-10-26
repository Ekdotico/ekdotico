// What a clearing does to the open connections of a shared document (FR-ED-40 (i), FR-ED-41, FR-AU-91;
// NFR-SE-03, NFR-SE-04; register D117, A103): every connection becomes read-only IN PLACE within 5 SECONDS of the
// confirmation, the Owner's included, by the notice on the channel; a connection opened during the period is
// read-only from its handshake; no change of role or of the permission set makes one editable while the period
// lasts; a cancellation or a transfer gives each back what its role allows; the re-check is the backstop of a
// lost notice; and the day closes them all. The real collaboration server in this process, the real provider of the
// editor over Node's own WebSocket, the application's own routes, the real database and Valkey.
import type { AddressInfo } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, json, MAIL, world } from './clearing.ts';
import { until } from './channel.ts';
import { MemoryStorage } from './image-storage.ts';
import { load, ORIGIN, PASSWORD, prepare } from './identity.ts';

const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const database = prepare('collabclearing', { TRUSTED_PROXY_COUNT: '1', EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey, settings } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { carryOutClearings } = await import('../../src/lib/clearing/deletion.ts');
const { countScope } = await import('../../src/lib/clearing/clearing.ts');
const { answerOffer, makeOffer } = await import('../../src/lib/documents/ownership.ts');
const { COLLAB_PATH, readRoleNotice, REFUSAL } = await import('../../src/lib/collab/protocol.ts');
const { publishCollabEvent } = await import('../../src/lib/collab/events.ts');
const { createCollabServer } = await import('../../src/collab/server.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, share, clear, cancelOne, deletedAgo } = w;

/** What the requirements allow between the commit of a change and its effect on a connection. */
const FIVE_SECONDS = 5000;
const sockets: HocuspocusProviderWebsocket[] = [];

function connect(port: number, cookie: string, documentId: string) {
  class Socket extends WebSocket {
    constructor(url: string) {
      super(url, { headers: { cookie, origin: ORIGIN } } as never);
    }
  }
  const socket = new HocuspocusProviderWebsocket({
    url: `ws://127.0.0.1:${port}${COLLAB_PATH}`,
    WebSocketPolyfill: Socket,
  });
  sockets.push(socket);
  const provider = new HocuspocusProvider({ websocketProvider: socket, name: documentId });
  const synced = new Promise<void>((resolve) => provider.on('synced', () => resolve()));
  const notices: string[] = [];
  const closed: string[] = [];
  provider.on('stateless', ({ payload }: { payload: string }) => {
    if (!payload.startsWith('{"kind":"people"')) notices.push(payload);
  });
  provider.on('close', ({ event }: { event: { reason: string } }) => closed.push(event.reason));
  const refused: string[] = [];
  provider.on('authenticationFailed', ({ reason }: { reason: string }) => refused.push(reason));
  provider.attach();
  return {
    socket,
    provider,
    synced,
    notices,
    closed,
    refused,
    changes: provider.document.getArray<string>('changes'),
  };
}

async function inProcess(recheckMs = 3_600_000) {
  const collab = createCollabServer({ ...settings(), limits: settings().limits }, { recheckMs });
  await new Promise<void>((resolve) => collab.httpServer.listen(0, resolve));
  await collab.listenForEvents();
  return { ...collab, port: (collab.httpServer.address() as AddressInfo).port };
}
type Local = Awaited<ReturnType<typeof inProcess>>;
const connectionOf = (local: Local, id: string, userId: string) =>
  (local.hocuspocus.documents.get(id)?.getConnections() ?? []).find((each) => each.context.userId === userId);

/** A shared document with its Owner, an Editor and a Viewer, each connected once. */
async function shared(local: Local) {
  const owner = await person('owner');
  const editor = await person('editor');
  const viewer = await person('viewer');
  const id = await documentOf(owner.id);
  const rows = {
    editor: (await share(id, editor.id, 'EDITOR')).id,
    viewer: (await share(id, viewer.id, 'VIEWER')).id,
  };
  const clients = {
    owner: connect(local.port, owner.cookie, id),
    editor: connect(local.port, editor.cookie, id),
    viewer: connect(local.port, viewer.cookie, id),
  };
  for (const client of Object.values(clients)) {
    await client.synced;
    await until(() => client.notices.length === 1);
  }
  return { id, owner, editor, viewer, rows, clients };
}
const everything = async (userId: string) => ({
  scope: 'all' as const,
  documentIds: (await countScope(userId, 'all')).documentIds,
  password: PASSWORD,
});
const noticeOf = (text: string | undefined) => readRoleNotice(text!);

beforeEach(async () => {
  later.length = 0;
  useImageStorage(new MemoryStorage());
  await db().documentClearing.updateMany({
    where: { completedAt: null },
    data: { completedAt: new Date(Date.now() + 365 * DAY_MS) },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const socket of sockets.splice(0)) socket.destroy();
});
afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the confirmation of a clearing (FR-ED-40 (i))', () => {
  // Mutation E01: the event is not published after the commit, or the server does not look at `clearing-changed`.
  it('makes every connection read-only in place within 5 seconds, the Owner’s too, and tells each the day', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, clients } = await shared(local);
      const connections = [owner, editor, viewer].map((who) => connectionOf(local, id, who.id)!);
      expect(connections.map((each) => each.readOnly)).toEqual([false, false, true]);

      const response = await clear(owner.cookie, await everything(owner.id));
      expect(response.status).toBe(200);
      const committed = Date.now();
      const day = (await json(response)).deleteOn as string;
      await until(() => connections.every((each) => each.readOnly), FIVE_SECONDS);
      expect(Date.now() - committed).toBeLessThan(FIVE_SECONDS);
      // The same connections, still open: "read-only in place".
      expect([owner, editor, viewer].map((who) => connectionOf(local, id, who.id))).toEqual(connections);
      for (const client of Object.values(clients)) expect(client.closed).toEqual([]);
      // Each is told the day: the Owner and the Editor lost the right to edit, the Viewer had none and is told all the same.
      await until(() => Object.values(clients).every((client) => client.notices.length === 2));
      expect(noticeOf(clients.owner.notices[1])).toEqual({ role: 'owner', canEdit: false, deletedOn: day });
      expect(noticeOf(clients.editor.notices[1])).toEqual({ role: 'editor', canEdit: false, deletedOn: day });
      expect(noticeOf(clients.viewer.notices[1])).toEqual({ role: 'viewer', canEdit: false, deletedOn: day });
      // What the Owner writes after is discarded.
      const held = local.hocuspocus.documents.get(id)!;
      clients.owner.changes.push(['written in the period']);
      await sleep(600);
      expect(held.getArray('changes').toArray()).not.toContain('written in the period');
    } finally {
      await local.stop();
    }
  });

  // Mutation E02: `recordConnection` does not read the column at a handshake.
  it('opens a connection during the period read-only from its handshake, with the day', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor } = await shared(local);
      const response = await clear(owner.cookie, await everything(owner.id));
      const day = (await json(response)).deleteOn as string;
      const late = connect(local.port, editor.cookie, id);
      await late.synced;
      await until(() => late.notices.length >= 1);
      const connection = [...(local.hocuspocus.documents.get(id)?.getConnections() ?? [])].filter(
        (each) => each.context.userId === editor.id,
      );
      expect(connection.every((each) => each.readOnly)).toBe(true);
      expect(noticeOf(late.notices[0])).toEqual({ role: 'editor', canEdit: false, deletedOn: day });
    } finally {
      await local.stop();
    }
  });

  // Mutation E03: a role raised to Editor, or a permission set changed, makes a connection editable in the period.
  it('is not made editable by a role raised to Editor, nor by a change of the permission set, while the period lasts', async () => {
    const local = await inProcess();
    try {
      const { id, owner, viewer, rows, clients } = await shared(local);
      await clear(owner.cookie, await everything(owner.id));
      const connection = connectionOf(local, id, viewer.id)!;
      await until(() => clients.viewer.notices.length === 2);
      // The Owner raises the Viewer to Editor, and gives every role every permission.
      await db().documentCollaborator.update({ where: { id: rows.viewer }, data: { role: 'EDITOR' } });
      await publishCollabEvent({ kind: 'collaborator-changed', documentId: id, userId: viewer.id });
      await until(() => connection.context.role === 'editor', FIVE_SECONDS);
      expect(connection.readOnly).toBe(true);
      expect(connection.context.permissions).not.toContain('document.content.edit');
      await publishCollabEvent({ kind: 'permission-set-changed', documentId: id });
      await sleep(600);
      expect(connection.readOnly).toBe(true);
      // The recheck of the rows says the same: nothing the Owner did makes it editable.
      clients.viewer.changes.push(['a would-be Editor writes']);
      await sleep(600);
      expect(local.hocuspocus.documents.get(id)!.getArray('changes').toArray()).toEqual([]);
    } finally {
      await local.stop();
    }
  });
});

describe('the end of the period without the deletion', () => {
  // Mutation E04: the cancellation publishes nothing, or the record keeps the day.
  it('gives each connection back what its role allows, in place, within 5 seconds, when the clearing is cancelled for the document', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, clients } = await shared(local);
      await clear(owner.cookie, await everything(owner.id));
      const connections = [owner, editor, viewer].map((who) => connectionOf(local, id, who.id)!);
      await until(() => connections.every((each) => each.readOnly));
      await until(() => Object.values(clients).every((client) => client.notices.length === 2));

      const cancelled = await cancelOne(owner.cookie, id);
      expect(cancelled.status).toBe(200);
      const committed = Date.now();
      await until(() => !connections[0]!.readOnly && !connections[1]!.readOnly, FIVE_SECONDS);
      expect(Date.now() - committed).toBeLessThan(FIVE_SECONDS);
      expect(connections[2]!.readOnly).toBe(true);
      expect([owner, editor, viewer].map((who) => connectionOf(local, id, who.id))).toEqual(connections);
      // Told that the document is editable again, and that there is no day: the Viewer too.
      await until(() => Object.values(clients).every((client) => client.notices.length === 3));
      expect(noticeOf(clients.owner.notices[2])).toEqual({ role: 'owner', canEdit: true });
      expect(noticeOf(clients.editor.notices[2])).toEqual({ role: 'editor', canEdit: true });
      expect(noticeOf(clients.viewer.notices[2])).toEqual({ role: 'viewer', canEdit: false });
      clients.editor.changes.push(['written again']);
      await until(() =>
        local.hocuspocus.documents.get(id)!.getArray('changes').toArray().includes('written again'),
      );
    } finally {
      await local.stop();
    }
  });

  // Mutation E05: the acceptance of an offer publishes nothing for the clearing.
  it('ends the period for every connection when the ownership passes (FR-ED-40 (h), (i))', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, rows, clients } = await shared(local);
      expect((await makeOffer(id, owner.id, rows.editor)).outcome).toBe('offered');
      const offer = await db().ownershipOffer.findFirstOrThrow({ where: { documentId: id } });
      await clear(owner.cookie, await everything(owner.id));
      // A second Editor, whom the transfer does not name: only the event of the clearing reaches this connection.
      const another = await person('another');
      await share(id, another.id, 'EDITOR');
      const bystander = connect(local.port, another.cookie, id);
      await bystander.synced;
      await until(() => bystander.notices.length === 1);
      const connections = [owner, editor, viewer, another].map((who) => connectionOf(local, id, who.id)!);
      await until(() => connections.every((each) => each.readOnly));
      await answerOffer(editor.id, offer.id, 'accept');
      // The new Owner and the former Owner, now an Editor, write again; the Viewer reads.
      await until(
        () => connections.slice(0, 2).every((each) => !each.readOnly) && !connections[3]!.readOnly,
        FIVE_SECONDS,
      );
      expect(connections[0]!.context.role).toBe('editor');
      expect(connections[1]!.context.role).toBe('owner');
      expect(connections[2]!.readOnly).toBe(true);
      expect(clients.viewer.closed).toEqual([]);
    } finally {
      await local.stop();
    }
  });

  // Mutation E06: the re-check does not read the column (and a lost notice is never made good).
  it('is made good by the re-check when the notice is lost', async () => {
    const local = await inProcess(1000);
    try {
      const { id, owner, editor, clients } = await shared(local);
      const connection = connectionOf(local, id, editor.id)!;
      // The change is committed and nothing is published: the notice is lost.
      await db().document.update({ where: { id }, data: { clearingAt: new Date(Date.now() + 5 * DAY_MS) } });
      await until(() => connection.readOnly, 10_000);
      expect(connection.context.deletedOn).not.toBeNull();
      await until(() => clients.editor.notices.length === 2);
      expect(noticeOf(clients.editor.notices[1])?.canEdit).toBe(false);
      expect(clients.owner.closed).toEqual([]);
      void owner;
    } finally {
      await local.stop();
    }
  });
});

describe('the day (FR-ED-40 (c))', () => {
  // Mutation E07: the claim does not tell the servers, so the connections are left open on a document that is going.
  it('closes every connection when the timer claims the document, with the reason the client shows', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, clients } = await shared(local);
      const response = await clear(owner.cookie, await everything(owner.id));
      const day = new Date((await json(response)).deleteOn as string);
      await until(() => Object.values(clients).every((client) => client.notices.length === 2));
      await carryOutClearings(day);
      await until(() => Object.values(clients).every((client) => client.closed.length > 0), FIVE_SECONDS);
      for (const client of Object.values(clients)) expect(client.closed).toContain(REFUSAL.ACCESS_ENDED);
      expect([owner, editor, viewer].map((who) => connectionOf(local, id, who.id))).toEqual([
        undefined,
        undefined,
        undefined,
      ]);
    } finally {
      await local.stop();
    }
  });
});

describe('a document deleted before the clearing, read by those who held a role on it (S23-1)', () => {
  /** A document its Owner deleted a day ago, with an Editor and a Viewer, in the period of a clearing. */
  async function deletedThenCleared() {
    const owner = await person('owner');
    const editor = await person('editor');
    const viewer = await person('viewer');
    const stranger = await person('stranger');
    const id = await documentOf(owner.id);
    await share(id, editor.id, 'EDITOR');
    await share(id, viewer.id, 'VIEWER');
    await deletedAgo(id, owner.id, DAY_MS);
    const response = await clear(owner.cookie, await everything(owner.id));
    expect(response.status).toBe(200);
    return { owner, editor, viewer, stranger, id, day: (await json(response)).deleteOn as string };
  }

  // Mutation V13: the handshake does not read the column (`recordConnection`), or the collaboration server asks for another
  // permission than `document.view`; V01 to V05 are the same rule at the routes.
  it('opens a connection for each of them, read-only from the handshake, and discards what an Editor writes', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, stranger, day } = await deletedThenCleared();
      const editing = connect(local.port, editor.cookie, id);
      const reading = connect(local.port, viewer.cookie, id);
      await editing.synced;
      await reading.synced;
      await until(() => editing.notices.length >= 1 && reading.notices.length >= 1);
      expect(noticeOf(editing.notices[0])).toEqual({ role: 'editor', canEdit: false, deletedOn: day });
      expect(noticeOf(reading.notices[0])).toEqual({ role: 'viewer', canEdit: false, deletedOn: day });
      for (const who of [editor, viewer]) {
        const connection = connectionOf(local, id, who.id)!;
        expect(connection.readOnly, who.email).toBe(true);
        expect(connection.context.permissions).not.toContain('document.content.edit');
      }
      // Yjs: what an Editor's client writes is discarded by the server (NFR-SE-03 (a)), as for a live document.
      editing.changes.push(['written by a former Editor']);
      reading.changes.push(['written by a former Viewer']);
      await sleep(600);
      const held = local.hocuspocus.documents.get(id)!.getArray('changes').toArray();
      expect(held).not.toContain('written by a former Editor');
      expect(held).not.toContain('written by a former Viewer');
      // Not the Owner's view, nor a person who never held a role: the refusal of a document that is not there.
      const refused = [connect(local.port, owner.cookie, id), connect(local.port, stranger.cookie, id)];
      await until(() => refused.every((each) => each.refused.length > 0));
      for (const each of refused) expect(each.refused).toEqual([REFUSAL.NO_ACCESS]);
    } finally {
      await local.stop();
    }
  });

  // Mutation V14: a handshake is admitted after the day, or once the timer has claimed the document.
  it('refuses a handshake after the day, and once the timer has claimed the document', async () => {
    const local = await inProcess();
    try {
      const { id, viewer } = await deletedThenCleared();
      await db().document.update({ where: { id }, data: { deletionClaimedAt: new Date() } });
      const claimed = connect(local.port, viewer.cookie, id);
      await until(() => claimed.refused.length > 0);
      expect(claimed.refused).toEqual([REFUSAL.NO_ACCESS]);
      await db().document.update({
        where: { id },
        data: { deletionClaimedAt: null, clearingAt: new Date(Date.now() - 1000) },
      });
      const late = connect(local.port, viewer.cookie, id);
      await until(() => late.refused.length > 0);
      expect(late.refused).toEqual([REFUSAL.NO_ACCESS]);
    } finally {
      await local.stop();
    }
  });

  // Mutation V15: the day closes nothing for a former collaborator (the re-check asks for another permission, or the claim does not tell).
  it('closes their connection at the day (the re-check), when the timer claims the document, and when the clearing is cancelled for it', async () => {
    const local = await inProcess(1000);
    try {
      const { id, owner, editor, viewer } = await deletedThenCleared();
      const viewing = connect(local.port, viewer.cookie, id);
      const editing = connect(local.port, editor.cookie, id);
      await viewing.synced;
      await editing.synced;
      // The cancellation: the clearing is cancelled for the document, which stays deleted.
      const cancelled = await cancelOne(owner.cookie, id);
      expect(cancelled.status).toBe(200);
      await until(() => viewing.closed.length > 0 && editing.closed.length > 0, FIVE_SECONDS);
      expect(viewing.closed).toContain(REFUSAL.ACCESS_ENDED);
      expect(editing.closed).toContain(REFUSAL.ACCESS_ENDED);
      // The day, with no notice published: the re-check is what closes it.
      await db().document.update({ where: { id }, data: { clearingAt: new Date(Date.now() + 3600_000) } });
      const again = connect(local.port, viewer.cookie, id);
      await again.synced;
      await db().document.update({ where: { id }, data: { clearingAt: new Date(Date.now() - 1000) } });
      await until(() => again.closed.length > 0, 10_000);
      expect(again.closed).toContain(REFUSAL.ACCESS_ENDED);
    } finally {
      await local.stop();
    }
  });

  // Mutation V16: the claim of a document that was deleted before does not tell the servers (the hour's wait for the re-check is not the day).
  it('closes their connection when the timer claims the document, by the notice of the servers and not the re-check', async () => {
    const local = await inProcess();
    try {
      const { id, viewer, day } = await deletedThenCleared();
      const claimed = connect(local.port, viewer.cookie, id);
      await claimed.synced;
      await carryOutClearings(new Date(day));
      await until(() => claimed.closed.length > 0, FIVE_SECONDS);
      expect(claimed.closed).toContain(REFUSAL.ACCESS_ENDED);
    } finally {
      await local.stop();
    }
  });
});
