// What a change of a document's permission set does to an open connection
// (FR-ED-40 (g); FR-ED-45; NFR-SE-03 (b) to (d), NFR-SE-04): the new set is
// applied IN PLACE to every open connection of the document within 5 SECONDS
// of the change being committed, by the notice on the channel and not by the
// re-check, whose period is made an hour here so that nothing but an event can
// act. No connection is closed, none changes between editable and read-only,
// and each whose role's permissions changed is told.
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

const database = prepare('collabpermissions', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey, settings } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { COLLAB_PATH, readPeopleNotice, readPermissionsNotice, readRoleNotice } =
  await import('../../src/lib/collab/protocol.ts');
const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
const { createCollabServer } = await import('../../src/collab/server.ts');
const permissions = await import('../../src/app/api/documents/[id]/permissions/route.ts');

/** What the requirements allow between the commit of a change and its effect on a connection. */
const FIVE_SECONDS = 5000;
const sockets: HocuspocusProviderWebsocket[] = [];

/** One socket of a signed-in browser, with one document opened on it. */
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
  // The list of the people present is another message (FR-ED-17); it is not what these tests count.
  const lists: string[] = [];
  provider.on('stateless', ({ payload }: { payload: string }) => {
    (payload.startsWith('{"kind":"people"') ? lists : notices).push(payload);
  });
  provider.on('close', ({ event }: { event: { reason: string } }) => closed.push(event.reason));
  provider.attach();
  return {
    socket,
    provider,
    synced,
    notices,
    lists,
    closed,
    changes: provider.document.getArray<string>('changes'),
  };
}

// ── Accounts and documents ──────────────────────────────────────────────────

let count = 0;
let addresses = 0;
const net = () => ({ 'x-forwarded-for': `10.30.${Math.floor(++addresses / 250)}.${addresses % 250}` });
async function person(name = 'A Person') {
  const email = `permsevents${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email, undefined, net())) };
}
type Person = Awaited<ReturnType<typeof person>>;
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

/** A document with an Owner, an Editor and a Viewer, each with one connection. */
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

// ── What the Owner does ─────────────────────────────────────────────────────

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
const setCell = (cookie: string, id: string, permission: string, role: string, allowed = true) =>
  permissions.PUT(
    request('PUT', `/api/documents/${id}/permissions`, cookie, {
      changes: { [permission]: { [role]: allowed } },
    }),
    at({ id }),
  );
const reset = (cookie: string, id: string) =>
  permissions.PUT(request('PUT', `/api/documents/${id}/permissions`, cookie, { defaults: true }), at({ id }));

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
const holds = (connection: { context: { permissions: readonly string[] } }, permission: string) =>
  connection.context.permissions.includes(permission);

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

// ── FR-ED-40 (g) ────────────────────────────────────────────────────────────

describe('a change of the permission set (FR-ED-40 (g))', () => {
  it('applies it in place to every open connection of the role within 5 seconds, closes none, keeps the Editor editable, and tells it once', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, clients } = await three(local);
      // The same person in a second tab, which is told as well.
      const second = connect(local.port, await anotherSession(editor), id);
      await second.synced;
      await until(() => second.notices.length === 1);
      const held = local.hocuspocus.documents.get(id)!;
      const connection = connectionOf(local, id, editor.id)!;
      expect(holds(connection, 'document.rename')).toBe(false);
      clients.editor.changes.push(['written before']);
      await until(() => held.getArray('changes').length === 1);

      const took = await within(
        () => setCell(owner.cookie, id, 'document.rename', 'editor', true),
        () => holds(connection, 'document.rename'),
      );
      expect(took).toBeLessThan(FIVE_SECONDS);
      // The same connection, still open and still editable: what edits is fixed by role (FR-ED-44).
      expect(connectionOf(local, id, editor.id)).toBe(connection);
      expect(connection.readOnly).toBe(false);
      expect(connection.context.role).toBe('editor');
      // Told once, each of its two tabs, in the words of the notice: the role, and nothing of the set.
      await until(() => clients.editor.notices.length === 2 && second.notices.length === 2);
      for (const client of [clients.editor, second]) {
        expect(readPermissionsNotice(client.notices[1]!)).toEqual({ role: 'editor' });
        expect(readRoleNotice(client.notices[1]!)).toBeNull();
        expect(client.notices[1]).toBe('{"kind":"permissions","role":"editor"}');
        expect(client.closed).toEqual([]);
      }
      // It still writes, and what it writes is applied.
      clients.editor.changes.push(['written after']);
      await until(() => held.getArray('changes').toArray().includes('written after'));

      // Taken away again: in place, and told again.
      await within(
        () => setCell(owner.cookie, id, 'document.rename', 'editor', false),
        () => !holds(connection, 'document.rename'),
      );
      await until(() => clients.editor.notices.length === 3);
      expect(readPermissionsNotice(clients.editor.notices[2]!)).toEqual({ role: 'editor' });
      expect(connection.readOnly).toBe(false);
      // One notice for each change, and none was sent twice.
      await sleep(300);
      expect(clients.editor.notices).toHaveLength(3);
      expect(second.notices).toHaveLength(3);
    } finally {
      await local.stop();
    }
  });

  // Weakening: the notice sent to the connections of a role that did not change, or to the Owner.
  it('tells no connection whose own role’s permissions did not change: not the Owner, not the other role', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, viewer, clients } = await three(local);
      const editorConnection = connectionOf(local, id, editor.id)!;
      await within(
        () => setCell(owner.cookie, id, 'document.rename', 'editor', true),
        () => holds(editorConnection, 'document.rename'),
      );
      await sleep(400);
      expect(clients.owner.notices).toHaveLength(1);
      expect(clients.viewer.notices).toHaveLength(1);
      expect(holds(connectionOf(local, id, viewer.id)!, 'document.rename')).toBe(false);
      // A change to the Viewer's column tells the Viewer, and not the Editor.
      const viewerConnection = connectionOf(local, id, viewer.id)!;
      await within(
        () => setCell(owner.cookie, id, 'document.export.draft', 'viewer', true),
        () => holds(viewerConnection, 'document.export.draft'),
      );
      await until(() => clients.viewer.notices.length === 2);
      expect(readPermissionsNotice(clients.viewer.notices[1]!)).toEqual({ role: 'viewer' });
      await sleep(300);
      expect(clients.editor.notices).toHaveLength(2);
      expect(clients.owner.notices).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });

  // Weakening: a change of the set read as a change of editability, or the cell of a Viewer given from the stored set.
  it('leaves a Viewer read-only and open whatever it is given: editing is fixed by role, and what a Viewer sends is discarded', async () => {
    const local = await inProcess();
    try {
      const { id, owner, viewer, clients } = await three(local);
      const held = local.hocuspocus.documents.get(id)!;
      const connection = connectionOf(local, id, viewer.id)!;
      expect(connection.readOnly).toBe(true);
      // Every cell the Owner may give the Viewer, by the route; and the fixed cell forged into the stored set.
      for (const permission of ['document.export.draft']) {
        await within(
          () => setCell(owner.cookie, id, permission, 'viewer', true),
          () => holds(connection, permission),
        );
      }
      const forged = JSON.parse(JSON.stringify(defaultPermissionSet()));
      forged['document.content.edit'].viewer = true;
      forged['document.export.draft'].viewer = true;
      await db().document.update({ where: { id }, data: { permissionSet: forged } });
      await forger.publish(COLLAB_EVENTS_CHANNEL, `{"kind":"permission-set-changed","documentId":"${id}"}`);
      await sleep(500);
      expect(connection.readOnly).toBe(true);
      expect(holds(connection, 'document.content.edit')).toBe(false);
      clients.viewer.changes.push(['written as a Viewer']);
      await sleep(400);
      expect(held.getArray('changes').toArray()).toEqual([]);
      expect(clients.viewer.closed).toEqual([]);
      expect(connectionOf(local, id, viewer.id)).toBe(connection);
    } finally {
      await local.stop();
    }
  });

  it('applies a reset to the defaults in place, closes nothing, and tells each role that lost or gained a permission', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      await within(
        () => setCell(owner.cookie, id, 'document.collaborators.invite', 'editor', true),
        () => holds(connection, 'document.collaborators.invite'),
      );
      await until(() => clients.editor.notices.length === 2);
      await within(
        () => reset(owner.cookie, id),
        () => !holds(connection, 'document.collaborators.invite'),
      );
      await until(() => clients.editor.notices.length === 3);
      expect(readPermissionsNotice(clients.editor.notices[2]!)).toEqual({ role: 'editor' });
      expect(connection.readOnly).toBe(false);
      for (const client of Object.values(clients)) expect(client.closed).toEqual([]);
      expect(connectionsOf(local, id)).toHaveLength(3);
    } finally {
      await local.stop();
    }
  });

  it('tells a change of role of the same moment by the role alone: the new role’s permissions are what its notice speaks of', async () => {
    const local = await inProcess();
    try {
      const { id, editor, rows, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      // The set changed for the Viewer's column, and the Editor lowered, in one commit; one event looks at both.
      const set = defaultPermissionSet();
      set['document.export.draft'].viewer = true;
      await db().$transaction([
        db().document.update({ where: { id }, data: { permissionSet: set } }),
        db().documentCollaborator.update({ where: { id: rows.editor }, data: { role: 'VIEWER' } }),
      ]);
      await forger.publish(COLLAB_EVENTS_CHANNEL, `{"kind":"permission-set-changed","documentId":"${id}"}`);
      await until(() => connection.readOnly);
      await until(() => clients.editor.notices.length === 2);
      await sleep(300);
      expect(readRoleNotice(clients.editor.notices[1]!)).toEqual({ role: 'viewer', canEdit: false });
      expect(clients.editor.notices).toHaveLength(2);
      expect(holds(connection, 'document.export.draft')).toBe(true);
    } finally {
      await local.stop();
    }
  });

  it('is told to a connection opened after the change as the set stands then, with no notice of a change', async () => {
    const local = await inProcess();
    try {
      const { id, owner } = await three(local);
      const late = await person('Di Late');
      await grant(id, late, 'EDITOR');
      expect((await setCell(owner.cookie, id, 'document.rename', 'editor', true)).status).toBe(200);
      const client = connect(local.port, late.cookie, id);
      await client.synced;
      await until(() => client.notices.length === 1);
      expect(readRoleNotice(client.notices[0]!)).toEqual({ role: 'editor', canEdit: true });
      expect(holds(connectionOf(local, id, late.id)!, 'document.rename')).toBe(true);
      await sleep(300);
      expect(client.notices).toHaveLength(1);
    } finally {
      await local.stop();
    }
  });

  // Weakening: the event not handled, or handled for every document.
  it('looks at the document it names and no other', async () => {
    const local = await inProcess();
    try {
      const a = await three(local);
      const b = await three(local);
      const bConnection = connectionOf(local, b.id, b.editor.id)!;
      const aConnection = connectionOf(local, a.id, a.editor.id)!;
      await within(
        () => setCell(a.owner.cookie, a.id, 'document.rename', 'editor', true),
        () => holds(aConnection, 'document.rename'),
      );
      await sleep(400);
      expect(holds(bConnection, 'document.rename')).toBe(false);
      expect(b.clients.editor.notices).toHaveLength(1);
      expect(a.clients.editor.notices).toHaveLength(2);
    } finally {
      await local.stop();
    }
  });

  it('is told once, whichever run applies it: two events for one change tell the connection once', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      expect((await setCell(owner.cookie, id, 'document.rename', 'editor', true)).status).toBe(200);
      const event = `{"kind":"permission-set-changed","documentId":"${id}"}`;
      await Promise.all([
        forger.publish(COLLAB_EVENTS_CHANNEL, event),
        forger.publish(COLLAB_EVENTS_CHANNEL, event),
      ]);
      await until(() => holds(connection, 'document.rename'));
      await until(() => clients.editor.notices.length === 2);
      await sleep(600);
      expect(clients.editor.notices).toHaveLength(2);
    } finally {
      await local.stop();
    }
  });

  // Weakening: the server obeys the event instead of reading the rows.
  it('changes nothing for an event that is forged, late, or about a document that is not open', async () => {
    const local = await inProcess();
    try {
      const { id, editor, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      const before = [...connection.context.permissions];
      for (const documentId of [id, '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b']) {
        await forger.publish(
          COLLAB_EVENTS_CHANNEL,
          JSON.stringify({
            kind: 'permission-set-changed',
            documentId,
            set: { 'document.rename': { editor: true } },
            userId: editor.id,
          }),
        );
      }
      await forger.publish(COLLAB_EVENTS_CHANNEL, '{"kind":"permission-set-changed","documentId":"x"}');
      await sleep(600);
      expect(connection.context.permissions).toEqual(before);
      expect(connection.readOnly).toBe(false);
      for (const client of Object.values(clients)) {
        expect(client.notices).toHaveLength(1);
        expect(client.closed).toEqual([]);
      }
      expect(connectionsOf(local, id)).toHaveLength(3);
    } finally {
      await local.stop();
    }
  });

  it('reads the set the rows hold now: an event that arrives after the change was undone changes nothing', async () => {
    const local = await inProcess();
    try {
      const { id, owner, editor, clients } = await three(local);
      const connection = connectionOf(local, id, editor.id)!;
      expect((await setCell(owner.cookie, id, 'document.rename', 'editor', true)).status).toBe(200);
      await until(() => holds(connection, 'document.rename'));
      await until(() => clients.editor.notices.length === 2);
      // Undone by a write the events do not hear (the re-check's own hour is away), and then a late event.
      await db().document.update({ where: { id }, data: { permissionSet: defaultPermissionSet() } });
      await forger.publish(COLLAB_EVENTS_CHANNEL, `{"kind":"permission-set-changed","documentId":"${id}"}`);
      await until(() => !holds(connection, 'document.rename'));
      // It is what the rows say, and the connection is told of that.
      await until(() => clients.editor.notices.length === 3);
    } finally {
      await local.stop();
    }
  });
});

// ── The edit permission through the collaboration server (NFR-SE-04) ───────

describe('the permission to edit content, for each role, at the handshake and after a change of the set', () => {
  it('is held by the Owner and the Editor and by no other role, on every document, whatever the set is made to say', async () => {
    const local = await inProcess();
    try {
      const owner = await person('Ada Owner');
      const editor = await person('Ben Editor');
      const reviewer = await person('Rae Reviewer');
      const viewer = await person('Cy Viewer');
      const id = (await createDocument(owner.id)).id;
      await grant(id, editor, 'EDITOR');
      await db().documentCollaborator.create({
        data: { documentId: id, userId: reviewer.id, role: 'REVIEWER' },
      });
      await grant(id, viewer, 'VIEWER');
      // The most a stored set can be made to say: every cell true.
      const forged = JSON.parse(JSON.stringify(defaultPermissionSet()));
      for (const permission of Object.keys(forged))
        for (const role of Object.keys(forged[permission])) forged[permission][role] = true;
      await db().document.update({ where: { id }, data: { permissionSet: forged } });
      const clients = new Map<string, ReturnType<typeof connect>>();
      for (const [name, who] of [
        ['owner', owner],
        ['editor', editor],
        ['reviewer', reviewer],
        ['viewer', viewer],
      ] as const) {
        const client = connect(local.port, who.cookie, id);
        await client.synced;
        clients.set(name, client);
      }
      const held = local.hocuspocus.documents.get(id)!;
      for (const [name, who] of [
        ['owner', owner],
        ['editor', editor],
        ['reviewer', reviewer],
        ['viewer', viewer],
      ] as const) {
        const connection = connectionOf(local, id, who.id)!;
        expect(connection.readOnly, name).toBe(name !== 'owner' && name !== 'editor');
        expect(holds(connection, 'document.content.edit'), name).toBe(name === 'owner' || name === 'editor');
        clients.get(name)!.changes.push([`written as ${name}`]);
      }
      await sleep(600);
      expect(held.getArray('changes').toArray().sort()).toEqual(['written as editor', 'written as owner']);
    } finally {
      await local.stop();
    }
  });
});

// ── FR-ED-17: who is present, and the permission that hides the people ─────

describe('the people present and the permission that hides the people (register row PR-2)', () => {
  const lastList = (client: { lists: string[] }) => readPeopleNotice(client.lists.at(-1) ?? '');
  /** The last list as name to role, which is the same whatever order the three handshakes arrived in. */
  const rolesIn = (client: { lists: string[] }) =>
    Object.fromEntries((lastList(client) ?? []).map(({ name, role }) => [name, role]));
  const SEEN = { 'Ada Owner': 'owner', 'Ben Editor': 'editor', 'Cy Viewer': 'viewer' };
  const HIDDEN = { 'Ada Owner': undefined, 'Ben Editor': undefined, 'Cy Viewer': undefined };

  it('leaves the roles out of the list of a role that may not see the people, sends the lists again at the change, and puts them back', async () => {
    const local = await inProcess();
    try {
      const { id, owner, clients } = await three(local);
      // By default every role sees the people, and each list marks its recipient's own entry.
      await until(() => lastList(clients.viewer)?.length === 3);
      expect(rolesIn(clients.viewer)).toEqual(SEEN);
      expect(
        lastList(clients.viewer)!
          .filter(({ you }) => you)
          .map(({ name }) => name),
      ).toEqual(['Cy Viewer']);
      expect(new Set(lastList(clients.viewer)!.map(({ slot }) => slot)).size).toBe(3);

      await within(
        () => setCell(owner.cookie, id, 'document.collaborators.view', 'viewer', false),
        () => Object.values(rolesIn(clients.viewer)).every((role) => role === undefined),
      );
      // The Viewer is shown who is there and in which colour, and no one's role.
      expect(rolesIn(clients.viewer)).toEqual(HIDDEN);
      expect(lastList(clients.viewer)).toHaveLength(3);
      // The Editor's role still sees them.
      expect(rolesIn(clients.editor)).toEqual(SEEN);

      await within(
        () => setCell(owner.cookie, id, 'document.collaborators.view', 'viewer', true),
        () => Object.values(rolesIn(clients.viewer)).every((role) => role !== undefined),
      );
      expect(rolesIn(clients.viewer)).toEqual(SEEN);
    } finally {
      await local.stop();
    }
  });
});
