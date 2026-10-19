// Changing a role, removing a collaborator, and leaving a document (FR-ED-38,
// FR-ED-44 (b); NFR-SE-04, NFR-SE-19; D163; FR-ED-37's limit of ten people):
// the routes as Next.js calls them, against a provisioned database and the real
// Valkey, whose channel (FR-ED-40; NFR-SE-03 (d)) a subscriber of the test
// listens on. Each test of a security rule names the weakening that makes it
// fail. What a change does to an open connection is in collab-events.test.ts.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('collaborators', { RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600' });
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { createInvitations, deliverInvitations, lockDocument } =
  await import('../../src/lib/documents/sharing.ts');
const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const people = await import('../../src/app/api/documents/[id]/collaborators/route.ts');
const one = await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
const leaving = await import('../../src/app/api/documents/[id]/leave/route.ts');
const notifications = await import('../../src/app/api/notifications/route.ts');
const notification = await import('../../src/app/api/notifications/[id]/route.ts');
const byId = await import('../../src/app/api/invitations/received/[invitationId]/[answer]/route.ts');

// ── Valkey: what is published ───────────────────────────────────────────────

const heard: string[] = [];
const subscriber = new Redis(process.env.VALKEY_URL!);
beforeAll(async () => {
  subscriber.on('message', (_channel, message) => void heard.push(message));
  await subscriber.subscribe(COLLAB_EVENTS_CHANNEL);
});
afterAll(async () => {
  subscriber.disconnect();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
afterEach(() => vi.restoreAllMocks());

/** The messages about this document that were published, in order. The channel is shared by every run on the machine. */
const heardFor = (documentId: string) => heard.filter((message) => message.includes(documentId));
async function until<T>(read: () => T | Promise<T>, within = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + within;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`not within ${within} ms`);
    await sleep(20);
  }
}

// ── Requests ────────────────────────────────────────────────────────────────

const request = (method: string, path: string, cookie: string, body?: unknown, origin = ORIGIN) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { origin }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

const change = (cookie: string, id: string, collaboratorId: string, body: unknown = { role: 'viewer' }) =>
  one.PATCH(
    request('PATCH', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie, body),
    at({ id, collaboratorId }),
  );
const remove = (cookie: string, id: string, collaboratorId: string) =>
  one.DELETE(
    request('DELETE', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie),
    at({ id, collaboratorId }),
  );
const leave = (cookie: string, id: string) =>
  leaving.POST(request('POST', `/api/documents/${id}/leave`, cookie), at({ id }));
const peopleOf = (cookie: string, id: string) =>
  people.GET(request('GET', `/api/documents/${id}/collaborators`, cookie), at({ id }));
const listOf = async (cookie: string) =>
  (
    (await (await collection.GET(request('GET', '/api/documents', cookie))).json()) as {
      documents: { id: string }[];
    }
  ).documents;
const answerById = (cookie: string, invitationId: string, answer: string) =>
  byId.POST(
    request('POST', `/api/invitations/received/${invitationId}/${answer}`, cookie),
    at({ invitationId, answer }),
  );

// ── Accounts, documents, roles ──────────────────────────────────────────────

let count = 0;
async function person(name?: string) {
  const email = `roles${++count}@example.com`;
  const id = await createAccount(auth, email);
  if (name) await db().user.update({ where: { id }, data: { name } });
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;

const documentOf = async (owner: Person) => (await createDocument(owner.id)).id;
/** A collaborator as an accepted invitation makes one, and the identifier of its row. */
async function grant(documentId: string, who: Person, role: 'EDITOR' | 'VIEWER' | 'REVIEWER') {
  const row = await db().documentCollaborator.create({ data: { documentId, userId: who.id, role } });
  return row.id;
}
const roleOf = async (collaboratorId: string) =>
  (await db().documentCollaborator.findUnique({ where: { id: collaboratorId } }))?.role ?? null;
/** The Owner gives the Editor the permissions to act (FR-ED-45). */
async function giveEditors(documentId: string, ...cells: ('roles' | 'remove' | 'invite')[]) {
  const set = defaultPermissionSet();
  for (const cell of cells) set[`document.collaborators.${cell}`].editor = true;
  await db().document.update({ where: { id: documentId }, data: { permissionSet: set } });
}
const logged = (documentId: string) =>
  db().securityLogEntry.findMany({
    where: { documentId },
    select: { kind: true, userId: true },
    orderBy: { createdAt: 'asc' },
  });
const code = async (response: Response) => (await response.json()).error.code as string;

/** An Owner with an Editor and a Viewer on one document, and the identifiers of their rows. */
async function three() {
  const owner = await person();
  const editor = await person();
  const viewer = await person();
  const id = await documentOf(owner);
  const rows = { editor: await grant(id, editor, 'EDITOR'), viewer: await grant(id, viewer, 'VIEWER') };
  return { owner, editor, viewer, id, rows };
}

/**
 * Holds the document's row for the length of `during`, as a request that is
 * on its way would, and runs `during` once it does. What `then` writes is
 * written under that hold and committed when it returns.
 */
async function holding<T>(
  documentId: string,
  during: () => Promise<T>,
  then: (tx: Parameters<Parameters<ReturnType<typeof db>['$transaction']>[0]>[0]) => Promise<void>,
): Promise<T> {
  let locked!: () => void;
  let release!: () => void;
  const holds = new Promise<void>((resolve) => (locked = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const transaction = db().$transaction(
    async (tx) => {
      expect(await lockDocument(tx, documentId)).toBe(true);
      locked();
      await gate;
      await then(tx);
    },
    { timeout: 20_000 },
  );
  await holds;
  const pending = during();
  // The request has authorised and now waits for the row: the database says one statement waits on a lock.
  await until(() =>
    /(^|\n)[1-9]\d*$/.test(
      database.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'`),
    ),
  );
  release();
  await transaction;
  return pending;
}

// ── Changing a role ─────────────────────────────────────────────────────────

describe('changing a role (FR-ED-38)', () => {
  it('lets the Owner change an Editor to a Viewer and back, states it, writes the entry in the transaction, and publishes after the commit', async () => {
    const { owner, editor, id, rows } = await three();
    await db().user.update({ where: { id: editor.id }, data: { name: 'Bea Editor' } });
    const before = await db().documentCollaborator.findUniqueOrThrow({ where: { id: rows.editor } });

    const response = await change(owner.cookie, id, rows.editor, { role: 'viewer' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({ message: 'Role of Bea Editor changed to Viewer.' });
    const now = await db().documentCollaborator.findUniqueOrThrow({ where: { id: rows.editor } });
    expect(now.role).toBe('VIEWER');
    // "The role was granted": FR-AU-92 reads it.
    expect(now.roleSince.getTime()).toBeGreaterThan(before.roleSince.getTime());
    expect(now.addedAt).toEqual(before.addedAt);

    // NFR-SE-19: who acted and on what, and nothing of the person it affects.
    expect(await logged(id)).toEqual([{ kind: 'collaborators_changed', userId: owner.id }]);
    // NFR-SE-03 (d): published, by kind and identifiers, once the change had committed.
    await until(() => heardFor(id).length === 1);
    expect(heardFor(id)).toEqual([
      `{"kind":"collaborator-changed","documentId":"${id}","userId":"${editor.id}"}`,
    ]);

    expect((await change(owner.cookie, id, rows.editor, { role: 'editor' })).status).toBe(200);
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    await until(() => heardFor(id).length === 2);
  });

  // Weakening: the notice published inside the transaction, before the commit.
  it('publishes only once the change is committed: what another connection reads of the row at that moment', async () => {
    const { owner, editor, id, rows } = await three();
    const publish = valkey().publish.bind(valkey());
    const seen: (string | null)[] = [];
    vi.spyOn(valkey(), 'publish').mockImplementation((async (...given: Parameters<typeof publish>) => {
      seen.push(await roleOf(rows.editor));
      seen.push(await roleOf(rows.viewer));
      return publish(...given);
    }) as never);
    expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(200);
    // The role is the new one; the row of the other collaborator is as it was.
    expect(seen).toEqual(['VIEWER', 'VIEWER']);
    expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(200);
    expect(seen.slice(2)).toEqual(['VIEWER', null]);
    expect((await leave(editor.cookie, id)).status).toBe(204);
    expect(seen.slice(4)).toEqual([null, null]);
  });

  it('answers the role already held with a statement, and writes, logs and publishes nothing (S15-4)', async () => {
    const { owner, id, rows } = await three();
    const before = await db().documentCollaborator.findUniqueOrThrow({ where: { id: rows.viewer } });
    const response = await change(owner.cookie, id, rows.viewer, { role: 'viewer' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Role of A Person is already Viewer.' });
    expect(await db().documentCollaborator.findUniqueOrThrow({ where: { id: rows.viewer } })).toEqual(before);
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
  });

  it('refuses the Reviewer, a body that is no role, a field more, and a body that is not JSON, and changes nothing', async () => {
    const { owner, id, rows } = await three();
    const refuse = async (body: unknown, status: number, error: string) => {
      const response = await change(owner.cookie, id, rows.viewer, body);
      expect(response.status, JSON.stringify(body)).toBe(status);
      expect(await code(response), JSON.stringify(body)).toBe(error);
    };
    // Weakening: the Reviewer accepted, as it is stored.
    await refuse({ role: 'reviewer' }, 422, 'role_not_offered');
    await refuse({ role: 'owner' }, 422, 'invalid_request');
    await refuse({ role: 'Editor' }, 422, 'invalid_request');
    await refuse({ role: 7 }, 422, 'invalid_request');
    await refuse({}, 422, 'invalid_request');
    await refuse([], 422, 'invalid_request');
    await refuse({ role: 'editor', userId: 'someone-else' }, 422, 'invalid_request');
    await refuse({ role: 'editor', permissions: [] }, 422, 'invalid_request');
    const text = await one.PATCH(
      new Request(`${ORIGIN}/api/documents/${id}/collaborators/${rows.viewer}`, {
        method: 'PATCH',
        headers: { origin: ORIGIN, cookie: owner.cookie, 'content-type': 'text/plain' },
        body: '{"role":"editor"}',
      }),
      at({ id, collaboratorId: rows.viewer }),
    );
    expect(text.status).toBe(415);
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect(await logged(id)).toEqual([]);
  });

  it('leaves the people to the Owner, and to an Editor only when the permission is given, on Viewers and never on an Editor, the Owner, or oneself', async () => {
    const { owner, editor, viewer, id, rows } = await three();
    // By default an Editor does not hold the permission: a 403, logged.
    const denied = await change(editor.cookie, id, rows.viewer, { role: 'editor' });
    expect(denied.status).toBe(403);
    expect(await code(denied)).toBe('forbidden');
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect(await logged(id)).toEqual([{ kind: 'forbidden', userId: editor.id }]);

    await giveEditors(id, 'roles', 'remove');
    // The Editor raises a Viewer to Editor (FR-ED-44 (b))...
    expect((await change(editor.cookie, id, rows.viewer, { role: 'editor' })).status).toBe(200);
    expect(await roleOf(rows.viewer)).toBe('EDITOR');
    // ... and once that person is an Editor, only the Owner can lower or remove them.
    // Weakening: no rule on the target's role.
    const lower = await change(editor.cookie, id, rows.viewer, { role: 'viewer' });
    expect(lower.status).toBe(403);
    expect((await lower.json()).error.message).toBe(
      'The role of this account on the document can act on a Reviewer or a Viewer and never on an Editor. The Owner of the document can act on an Editor.',
    );
    expect((await remove(editor.cookie, id, rows.viewer)).status).toBe(403);
    expect(await roleOf(rows.viewer)).toBe('EDITOR');
    // Not on oneself: "a holder who wants to go leaves the document".
    // Weakening: no rule on oneself.
    const myself = await change(editor.cookie, id, rows.editor, { role: 'viewer' });
    expect(myself.status).toBe(403);
    expect((await myself.json()).error.message).toBe(
      'This account cannot change its own role or remove itself. To go, leave the document.',
    );
    expect((await remove(editor.cookie, id, rows.editor)).status).toBe(403);
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    // The Owner has no row to name, and the Owner may lower an Editor.
    expect((await change(owner.cookie, id, rows.viewer, { role: 'viewer' })).status).toBe(200);
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    // Every refusal was written to the log, with the one who asked and the document.
    const kinds = (await logged(id)).filter(({ kind }) => kind === 'forbidden');
    expect(kinds).toHaveLength(5);
    expect(kinds.every(({ userId }) => userId === editor.id)).toBe(true);
    // Neither a Viewer nor a Reviewer ever may, whatever the stored set says.
    const reviewer = await person();
    const reviewerRow = await grant(id, reviewer, 'REVIEWER');
    const forged = defaultPermissionSet();
    for (const role of ['viewer', 'reviewer'] as const) {
      forged['document.collaborators.roles'][role] = true;
      forged['document.collaborators.remove'][role] = true;
    }
    await db().document.update({ where: { id }, data: { permissionSet: forged } });
    for (const who of [viewer, reviewer]) {
      expect((await change(who.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(403);
      expect((await remove(who.cookie, id, rows.editor)).status).toBe(403);
    }
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    expect(await roleOf(reviewerRow)).toBe('REVIEWER');
  });

  it('answers an account with no role on the document as one that does not exist, and logs nothing', async () => {
    const { id, rows } = await three();
    const stranger = await person();
    for (const call of [
      () => change(stranger.cookie, id, rows.viewer),
      () => remove(stranger.cookie, id, rows.viewer),
      () => leave(stranger.cookie, id),
      () => change(stranger.cookie, randomUUID(), rows.viewer),
    ]) {
      const response = await call();
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('not_found');
    }
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect(await logged(id)).toEqual([]);
  });

  it('acts on the collaborators of the document in the path alone: an identifier of another document is no one', async () => {
    const { owner, id, rows } = await three();
    const { owner: other, id: elsewhere, rows: theirs } = await three();
    // Weakening: the collaborator found by its identifier alone.
    for (const [cookie, document, target] of [
      [owner.cookie, id, theirs.viewer],
      [other.cookie, elsewhere, rows.viewer],
    ] as const) {
      const lowered = await change(cookie, document, target, { role: 'editor' });
      expect(lowered.status).toBe(404);
      expect(await code(lowered)).toBe('not_found');
      expect((await remove(cookie, document, target)).status).toBe(404);
    }
    // The Owner of one document has no role on the other: its path is no path.
    expect((await change(owner.cookie, elsewhere, theirs.viewer)).status).toBe(404);
    expect((await remove(owner.cookie, elsewhere, theirs.viewer)).status).toBe(404);
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect(await roleOf(theirs.viewer)).toBe('VIEWER');
    expect(await db().documentCollaborator.count()).toBeGreaterThanOrEqual(4);
    expect(heardFor(id)).toEqual([]);
    expect(heardFor(elsewhere)).toEqual([]);
    // What is no identifier of a row names no one, and is not looked up.
    for (const odd of ['x', "'; DROP TABLE x; --", 'a'.repeat(65), '%00']) {
      expect((await remove(owner.cookie, id, odd)).status).toBe(404);
    }
  });
});

// ── Removing ────────────────────────────────────────────────────────────────

describe('removing a collaborator (FR-ED-38)', () => {
  it('ends all of the person’s access, keeps what they wrote, states it, logs it in the transaction, and publishes after the commit', async () => {
    const { owner, viewer, id, rows } = await three();
    await db().user.update({ where: { id: viewer.id }, data: { name: 'Cy Viewer' } });
    expect((await listOf(viewer.cookie)).map((each) => each.id)).toEqual([id]);
    // What the person contributed is the document's, and is not touched.
    const state = Buffer.from('what the collaborators wrote');
    await db().document.update({ where: { id }, data: { yjsState: state } });

    const response = await remove(owner.cookie, id, rows.viewer);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: 'Cy Viewer removed from this document.' });
    // The Editor stays, the Viewer is gone.
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(1);
    const kept = await db().document.findUniqueOrThrow({ where: { id }, select: { yjsState: true } });
    expect(Buffer.from(kept.yjsState!).toString()).toBe(state.toString());
    expect(await logged(id)).toEqual([{ kind: 'collaborators_changed', userId: owner.id }]);
    await until(() => heardFor(id).length === 1);
    expect(heardFor(id)).toEqual([
      `{"kind":"collaborator-changed","documentId":"${id}","userId":"${viewer.id}"}`,
    ]);

    // The document leaves the person's list, and the next request for it is answered as for no document.
    expect(await listOf(viewer.cookie)).toEqual([]);
    expect((await peopleOf(viewer.cookie, id)).status).toBe(404);
    expect((await leave(viewer.cookie, id)).status).toBe(404);
    // The row is gone, so the removal is not repeated.
    expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(404);
    expect(await logged(id)).toHaveLength(1);
  });

  it('frees a place of the ten people at once, and the person may be invited again and accept (a new grant)', async () => {
    const owner = await person();
    const id = await documentOf(owner);
    const collaborators = await Promise.all([person(), person(), person(), person(), person()]);
    const rows = await Promise.all(collaborators.map((each) => grant(id, each, 'VIEWER')));
    const document = { id, ownerId: owner.id };
    // The Owner, five collaborators, and four pending: ten people (FR-ED-37).
    const four = await createInvitations(
      document,
      owner.id,
      ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'],
      'viewer',
    );
    expect(four.outcome).toBe('created');
    expect((await createInvitations(document, owner.id, ['e@example.com'], 'viewer')).outcome).toBe('limit');

    expect((await remove(owner.cookie, id, rows[0]!)).status).toBe(200);
    const sent = await createInvitations(document, owner.id, ['e@example.com'], 'viewer');
    expect(sent.outcome).toBe('created');

    // The removed person: invited again at its address, which the refusal of FR-ED-37 does not hold
    // (it is for an address at which a person who HOLDS a role accepted).
    const gone = collaborators[0]!;
    await db().documentCollaborator.deleteMany({ where: { documentId: id, userId: { not: gone.id } } });
    await db().documentInvitation.updateMany({
      where: { documentId: id, state: 'PENDING' },
      data: { state: 'REVOKED' },
    });
    const first = await createInvitations(document, owner.id, [gone.email], 'editor');
    expect(first.outcome).toBe('created');
    if (first.outcome !== 'created') return;
    const delivered: string[] = [];
    await deliverInvitations(id, owner.id, first.invitations, async ({ to }) => void delivered.push(to));
    expect(delivered).toEqual([gone.email]);
    // It accepts, from the list, and holds the role the new invitation gave, as a new grant.
    expect((await answerById(gone.cookie, first.invitations[0]!.id, 'accept')).status).toBe(200);
    expect(
      (
        await db().documentCollaborator.findUniqueOrThrow({
          where: { documentId_userId: { documentId: id, userId: gone.id } },
        })
      ).role,
    ).toBe('EDITOR');
    // And is refused as a collaborator whose address accepted (FR-ED-37) while the role is held.
    expect((await createInvitations(document, owner.id, [gone.email], 'viewer')).outcome).toBe(
      'collaborator_address',
    );
  });

  it('is the Owner’s, or the Editor’s on a Viewer when the permission is given, and no one else’s', async () => {
    const { owner, editor, viewer, id, rows } = await three();
    // A Viewer who holds a role but not the permission.
    expect((await remove(viewer.cookie, id, rows.editor)).status).toBe(403);
    expect((await remove(editor.cookie, id, rows.viewer)).status).toBe(403);
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(2);
    await giveEditors(id, 'remove');
    // The permission to remove is not the permission to change a role.
    expect((await change(editor.cookie, id, rows.viewer, { role: 'editor' })).status).toBe(403);
    expect((await remove(editor.cookie, id, rows.viewer)).status).toBe(200);
    expect(await roleOf(rows.viewer)).toBeNull();
    // The Owner removes an Editor.
    expect((await remove(owner.cookie, id, rows.editor)).status).toBe(200);
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(0);
  });
});

// ── Leaving ─────────────────────────────────────────────────────────────────

describe('leaving a document (FR-ED-38)', () => {
  it('lets each role but the Owner’s go, removes only its own row, and logs the leaver', async () => {
    const owner = await person();
    const id = await documentOf(owner);
    const [editor, reviewer, viewer] = [await person(), await person(), await person()];
    await grant(id, editor, 'EDITOR');
    await grant(id, reviewer, 'REVIEWER');
    const viewerRow = await grant(id, viewer, 'VIEWER');

    for (const who of [editor, reviewer]) {
      const response = await leave(who.cookie, id);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe('');
      expect(await listOf(who.cookie)).toEqual([]);
    }
    expect(await db().documentCollaborator.findMany({ where: { documentId: id } })).toMatchObject([
      { id: viewerRow, userId: viewer.id },
    ]);
    expect(await logged(id)).toEqual([
      { kind: 'collaborators_changed', userId: editor.id },
      { kind: 'collaborators_changed', userId: reviewer.id },
    ]);
    await until(() => heardFor(id).length === 2);
    expect(heardFor(id)).toEqual([
      `{"kind":"collaborator-changed","documentId":"${id}","userId":"${editor.id}"}`,
      `{"kind":"collaborator-changed","documentId":"${id}","userId":"${reviewer.id}"}`,
    ]);
    // Gone: it cannot leave twice, and the document is no document to it.
    expect((await leave(editor.cookie, id)).status).toBe(404);
    // Weakening: the permission of the Owner read as held.
    const owned = await leave(owner.cookie, id);
    expect(owned.status).toBe(403);
    expect((await owned.clone().json()).error.message).toBe(
      'You are the Owner. You must transfer ownership before leaving.',
    );
    expect(await code(owned)).toBe('forbidden');
    expect((await db().document.findUniqueOrThrow({ where: { id } })).ownerId).toBe(owner.id);
    expect(await logged(id)).toHaveLength(3);
    expect((await logged(id)).at(-1)).toEqual({ kind: 'forbidden', userId: owner.id });
  });

  it('removes the row of the document in the path and no other', async () => {
    const owner = await person();
    const [a, b] = [await documentOf(owner), await documentOf(owner)];
    const editor = await person();
    await grant(a, editor, 'EDITOR');
    await grant(b, editor, 'EDITOR');
    expect((await leave(editor.cookie, a)).status).toBe(204);
    expect((await listOf(editor.cookie)).map((each) => each.id)).toEqual([b]);
    // Leaving a document one holds no role on is a 404, and touches nothing of the other.
    expect((await leave(editor.cookie, a)).status).toBe(404);
    expect(await db().documentCollaborator.count({ where: { documentId: b } })).toBe(1);
  });
});

// ── What every action asks ──────────────────────────────────────────────────

describe('the request (NFR-SE-17 (c), NFR-SE-02, NFR-SE-19)', () => {
  // Weakening: the signed copy of the session used for a request that changes state.
  it('reads the row of the session, and never the copy a cookie carries', async () => {
    const { owner, editor, id, rows } = await three();
    await db().session.deleteMany({ where: { userId: owner.id } });
    for (const response of [
      await change(owner.cookie, id, rows.editor),
      await remove(owner.cookie, id, rows.editor),
    ]) {
      expect(response.status).toBe(401);
    }
    await db().session.deleteMany({ where: { userId: editor.id } });
    expect((await leave(editor.cookie, id)).status).toBe(401);
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    expect(await logged(id)).toEqual([]);
    expect(heardFor(id)).toEqual([]);
  });

  it('checks the origin before anything of the request, and a request that is refused changes nothing', async () => {
    const { owner, id, rows } = await three();
    const foreign = 'https://elsewhere.example';
    const asked = [
      await one.PATCH(
        request(
          'PATCH',
          `/api/documents/${id}/collaborators/${rows.editor}`,
          owner.cookie,
          { role: 'viewer' },
          foreign,
        ),
        at({ id, collaboratorId: rows.editor }),
      ),
      await one.DELETE(
        request(
          'DELETE',
          `/api/documents/${id}/collaborators/${rows.editor}`,
          owner.cookie,
          undefined,
          foreign,
        ),
        at({ id, collaboratorId: rows.editor }),
      ),
      await leaving.POST(
        request('POST', `/api/documents/${id}/leave`, owner.cookie, undefined, foreign),
        at({ id }),
      ),
    ];
    for (const response of asked) expect(response.status).toBe(403);
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    expect(heardFor(id)).toEqual([]);
  });

  // Weakening: the entry written outside the transaction of the change.
  it('leaves nothing changed, and tells no one, where the entry of the security log cannot be written (D163)', async () => {
    const { owner, editor, id, rows } = await three();
    database.sql(
      `CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
       CREATE TRIGGER refuse_for_test BEFORE INSERT ON "SecurityLogEntry" FOR EACH ROW WHEN (NEW.kind = 'collaborators_changed') EXECUTE FUNCTION refuse_for_test();`,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(500);
      expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(500);
      expect((await leave(editor.cookie, id)).status).toBe(500);
    } finally {
      database.sql(`DROP TRIGGER refuse_for_test ON "SecurityLogEntry"; DROP FUNCTION refuse_for_test();`);
    }
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
  });

  it('stands where the notice cannot be published, says so in one line that names no person, and answers', async () => {
    const { owner, viewer, id, rows } = await three();
    const lines = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(valkey(), 'publish').mockRejectedValue(
      Object.assign(new Error(`down ${viewer.email}`), { code: 'ECONNREFUSED' }),
    );
    const response = await remove(owner.cookie, id, rows.viewer);
    expect(response.status).toBe(200);
    expect(await roleOf(rows.viewer)).toBeNull();
    expect(lines.mock.calls).toEqual([
      [`collab events: collaborator-changed not published for document ${id} (Error ECONNREFUSED)`],
    ]);
    expect(JSON.stringify(lines.mock.calls)).not.toContain(viewer.email);
    expect(JSON.stringify(lines.mock.calls)).not.toContain(viewer.id);
  });

  it('marks the caller’s own entry in the people of a document, and holds no account identifier', async () => {
    const { owner, editor, viewer, id } = await three();
    const seen = async (who: Person) => (await (await peopleOf(who.cookie, id)).json()).collaborators;
    for (const who of [editor, viewer]) {
      const list = (await seen(who)) as { self: boolean }[];
      expect(list.map(({ self }) => self).sort()).toEqual([false, true]);
    }
    expect(((await seen(owner)) as { self: boolean }[]).every(({ self }) => !self)).toBe(true);
    const text = JSON.stringify(await (await peopleOf(owner.cookie, id)).json());
    for (const who of [owner, editor, viewer]) expect(text).not.toContain(who.id);
  });
});

// ── The notification of the person affected (FR-ED-42; S15-2) ───────────────

describe('the notification of a change of role and of a removal (FR-ED-42, S15-2)', () => {
  type Listed = {
    kind: string;
    id: string;
    read: boolean;
    title?: string;
    role?: string;
    documentId?: string;
  };
  const listFor = async (who: Person) =>
    (await (await notifications.GET(request('GET', '/api/notifications', who.cookie))).json()) as {
      unread: number;
      notifications: Listed[];
    };
  const rowsFor = (documentId: string) =>
    db().notification.findMany({
      where: {
        kind: { in: ['role_changed', 'removed'] },
        payload: { path: ['documentId'], equals: documentId },
      },
      select: { recipientId: true, kind: true, payload: true },
    });

  // Weakening: the notification not written, or written to the actor, or written outside the transaction.
  it('tells the person whose role it is, in the transaction of the change, and no one else, the Owner who acted least', async () => {
    const { owner, editor, viewer, id, rows } = await three();
    await db().document.update({ where: { id }, data: { title: 'Thesis, chapter two' } });

    expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(200);
    // The payload holds identifiers and the role, never the title or a name (FR-ED-42).
    expect(await rowsFor(id)).toEqual([
      { recipientId: editor.id, kind: 'role_changed', payload: { documentId: id, role: 'viewer' } },
    ]);
    const told = await listFor(editor);
    expect(told.unread).toBe(1);
    expect(told.notifications).toEqual([
      expect.objectContaining({
        kind: 'role_changed',
        read: false,
        // The title is read when the list is, and the person holds a role on the document.
        title: 'Thesis, chapter two',
        role: 'viewer',
        documentId: id,
      }),
    ]);
    // The Owner who acted, and the other collaborator, are told nothing.
    expect(await listFor(owner)).toEqual({ unread: 0, notifications: [] });
    expect(await listFor(viewer)).toEqual({ unread: 0, notifications: [] });

    // And back: a second notification, newest first, each in the role it gave.
    expect((await change(owner.cookie, id, rows.editor, { role: 'editor' })).status).toBe(200);
    const again = await listFor(editor);
    expect(again.notifications.map(({ role }) => role)).toEqual(['editor', 'viewer']);
  });

  it('writes nothing where the role is the one held, and nothing for a leave', async () => {
    const { owner, editor, id, rows } = await three();
    expect((await change(owner.cookie, id, rows.viewer, { role: 'viewer' })).status).toBe(200);
    expect(await rowsFor(id)).toEqual([]);
    // A leave is the person's own act: no one is told, the leaver least.
    expect((await leave(editor.cookie, id)).status).toBe(204);
    expect(await rowsFor(id)).toEqual([]);
  });

  it('tells the person removed that they were removed, naming no document, and no one else', async () => {
    const { owner, editor, viewer, id, rows } = await three();
    expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(200);
    expect(await rowsFor(id)).toEqual([
      { recipientId: viewer.id, kind: 'removed', payload: { documentId: id } },
    ]);
    const told = await listFor(viewer);
    expect(told.unread).toBe(1);
    // It names no title and links to nothing (register row PR-5): no document is in it.
    expect(told.notifications).toEqual([expect.objectContaining({ kind: 'removed', read: false })]);
    expect(JSON.stringify(told)).not.toContain(id);
    expect(await listFor(owner)).toEqual({ unread: 0, notifications: [] });
    expect(await listFor(editor)).toEqual({ unread: 0, notifications: [] });
  });

  // Weakening: the guard that refuses the actor as the recipient taken out.
  it('never writes one for the person who acted, whoever calls the writers', async () => {
    const { owner, id } = await three();
    const { notifyRemoved, notifyRoleChanged } =
      await import('../../src/lib/documents/access-notifications.ts');
    await db().$transaction(async (tx) => {
      await notifyRoleChanged(tx, {
        recipientId: owner.id,
        actorId: owner.id,
        documentId: id,
        role: 'viewer',
      });
      await notifyRemoved(tx, { recipientId: owner.id, actorId: owner.id, documentId: id });
    });
    expect(await rowsFor(id)).toEqual([]);
  });

  // Weakening: the notification written after the commit, or outside the transaction.
  it('leaves the change unmade where the notification cannot be written, and tells no one', async () => {
    const { owner, editor, id, rows } = await three();
    database.sql(
      `CREATE FUNCTION refuse_notification_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
       CREATE TRIGGER refuse_notification_for_test BEFORE INSERT ON "Notification" FOR EACH ROW WHEN (NEW.kind IN ('role_changed', 'removed')) EXECUTE FUNCTION refuse_notification_for_test();`,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(500);
      expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(500);
    } finally {
      database.sql(
        `DROP TRIGGER refuse_notification_for_test ON "Notification"; DROP FUNCTION refuse_notification_for_test();`,
      );
    }
    expect(await roleOf(rows.editor)).toBe('EDITOR');
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    // Neither the entry of the log nor the notice to the collaboration server came out of a change that was not made.
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
    expect(await listFor(editor)).toEqual({ unread: 0, notifications: [] });
  });

  it('shows a change of role while the person holds a role on the document, with its title as it stands, and not after', async () => {
    const { owner, editor, id, rows } = await three();
    expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(200);
    await db().document.update({ where: { id }, data: { title: 'Renamed since' } });
    expect((await listFor(editor)).notifications[0]).toMatchObject({ title: 'Renamed since' });
    // Removed: the subject (the role) is gone, and the change of role with it; the removal is there instead.
    expect((await remove(owner.cookie, id, rows.editor)).status).toBe(200);
    expect((await listFor(editor)).notifications.map(({ kind }) => kind)).toEqual(['removed']);
    // And a document that is deleted is shown in no notification.
    const second = await documentOf(owner);
    const row = await grant(second, editor, 'EDITOR');
    expect((await change(owner.cookie, second, row, { role: 'viewer' })).status).toBe(200);
    expect((await listFor(editor)).notifications.map(({ kind }) => kind)).toEqual([
      'role_changed',
      'removed',
    ]);
    await db().document.update({
      where: { id: second },
      data: { deletedAt: new Date(), deletedById: owner.id },
    });
    expect((await listFor(editor)).notifications.map(({ kind }) => kind)).toEqual(['removed']);
  });

  it('keeps the notification of a removal for 30 days', async () => {
    const { owner, viewer, id, rows } = await three();
    expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(200);
    const { listAccessNotifications } = await import('../../src/lib/documents/access-notifications.ts');
    const DAY = 24 * 60 * 60 * 1000;
    expect(await listAccessNotifications(viewer.id, new Date(Date.now() + 29 * DAY))).toHaveLength(1);
    expect(await listAccessNotifications(viewer.id, new Date(Date.now() + 31 * DAY))).toEqual([]);
  });

  it('is marked read by its recipient alone, and stays in the list as read', async () => {
    const { owner, editor, viewer, id, rows } = await three();
    expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(200);
    expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(200);
    const mark = (who: Person, notificationId: string) =>
      notification.PATCH(
        request('PATCH', `/api/notifications/${notificationId}`, who.cookie),
        at({ id: notificationId }),
      );
    const [theirs] = (await listFor(editor)).notifications;
    // Another account's notification is no notification: a 404, and still unread.
    expect((await mark(viewer, theirs!.id)).status).toBe(404);
    expect((await listFor(editor)).unread).toBe(1);
    expect((await mark(editor, theirs!.id)).status).toBe(204);
    expect(await listFor(editor)).toMatchObject({
      unread: 0,
      notifications: [{ kind: 'role_changed', read: true }],
    });
    const [removed] = (await listFor(viewer)).notifications;
    expect((await mark(viewer, removed!.id)).status).toBe(204);
    expect((await listFor(viewer)).unread).toBe(0);
  });

  it('is taken with the document when its retention ends and it is deleted for good', async () => {
    const { owner, id, rows } = await three();
    expect((await change(owner.cookie, id, rows.editor, { role: 'viewer' })).status).toBe(200);
    expect((await remove(owner.cookie, id, rows.viewer)).status).toBe(200);
    expect(await rowsFor(id)).toHaveLength(2);
    const { deleteAccessNotificationsOf } = await import('../../src/lib/documents/access-notifications.ts');
    await db().$transaction((tx) => deleteAccessNotificationsOf(tx, id));
    expect(await rowsFor(id)).toEqual([]);
  });
});

// ── Under the lock ──────────────────────────────────────────────────────────

describe('what authorises a request is read again under the lock of the document', () => {
  // Weakening: the caller's role and permission not read again in the transaction.
  it('refuses an Editor who was removed after the request was authorised, and removes no one', async () => {
    const { editor, id, rows } = await three();
    await giveEditors(id, 'remove');
    const response = await holding(
      id,
      () => remove(editor.cookie, id, rows.viewer),
      // The Owner's removal of the Editor, committed first.
      async (tx) => void (await tx.documentCollaborator.delete({ where: { id: rows.editor } })),
    );
    expect(response.status).toBe(404);
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect(heardFor(id)).toEqual([]);
  });

  it('refuses an Editor whose permission was taken away after the request was authorised', async () => {
    const { editor, id, rows } = await three();
    await giveEditors(id, 'roles');
    const response = await holding(
      id,
      () => change(editor.cookie, id, rows.viewer, { role: 'editor' }),
      async (tx) =>
        void (await tx.document.update({ where: { id }, data: { permissionSet: defaultPermissionSet() } })),
    );
    expect(response.status).toBe(403);
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
    expect((await logged(id)).filter(({ kind }) => kind === 'forbidden')).toHaveLength(1);
  });

  // Weakening: the role of the target read before the lock.
  it('refuses an Editor who meets a Viewer that was made an Editor while it waited', async () => {
    const { editor, id, rows } = await three();
    await giveEditors(id, 'remove');
    const response = await holding(
      id,
      () => remove(editor.cookie, id, rows.viewer),
      async (tx) =>
        void (await tx.documentCollaborator.update({ where: { id: rows.viewer }, data: { role: 'EDITOR' } })),
    );
    expect(response.status).toBe(403);
    expect(await roleOf(rows.viewer)).toBe('EDITOR');
  });

  it('stops a change of role for a document deleted while it waited', async () => {
    const { owner, id, rows } = await three();
    const response = await holding(
      id,
      () => change(owner.cookie, id, rows.viewer, { role: 'editor' }),
      async (tx) =>
        void (await tx.document.update({
          where: { id },
          data: { deletedAt: new Date(), deletedById: owner.id },
        })),
    );
    expect(response.status).toBe(404);
    expect(await roleOf(rows.viewer)).toBe('VIEWER');
  });
});

describe('requests at once', () => {
  // Weakening: no lock on the document.
  it('a change of role and a removal of one person at once are one after the other, and never a fault', async () => {
    for (let round = 0; round < 6; round++) {
      const { owner, id, rows } = await three();
      const [changed, removed] = await Promise.all([
        change(owner.cookie, id, rows.viewer, { role: 'editor' }),
        remove(owner.cookie, id, rows.viewer),
      ]);
      // The removal always stands. The change stood first (200) or found no one (404); never a 500.
      expect(removed.status).toBe(200);
      expect([200, 404]).toContain(changed.status);
      expect(await roleOf(rows.viewer)).toBeNull();
      expect((await logged(id)).filter(({ kind }) => kind === 'collaborators_changed')).toHaveLength(
        changed.status === 200 ? 2 : 1,
      );
    }
  });

  it('a change of role and an acceptance at once both stand, and the ten people are counted whole', async () => {
    const { owner, id, rows } = await three();
    const invitee = await person();
    const document = { id, ownerId: owner.id };
    const made = await createInvitations(document, owner.id, [invitee.email], 'viewer');
    if (made.outcome !== 'created') throw new Error('not created');
    await deliverInvitations(id, owner.id, made.invitations, async () => {});
    const [changed, accepted] = await Promise.all([
      change(owner.cookie, id, rows.viewer, { role: 'editor' }),
      answerById(invitee.cookie, made.invitations[0]!.id, 'accept'),
    ]);
    expect(changed.status).toBe(200);
    expect(accepted.status).toBe(200);
    expect(await roleOf(rows.viewer)).toBe('EDITOR');
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(3);
  });
});
