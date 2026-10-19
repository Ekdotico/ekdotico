// Changing a document's permission set (FR-ED-45, FR-ED-46; NFR-SE-04,
// NFR-SE-19; D163): the routes as Next.js calls them, against a provisioned
// database and the real Valkey, whose channel (FR-ED-40 (g); NFR-SE-03 (d)) a
// subscriber of the test listens on. Each test of a security rule names the
// weakening that makes it fail. What a change does to an open connection is in
// collab-permissions.test.ts; what every permission and role does through
// `authorise` and the routes is in permissions-matrix.test.ts.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('permissionsettings', { RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600' });
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { defaultPermissionSet, PERMISSIONS, ROLES } = await import('../../src/lib/documents/permissions.ts');
const { cellState } = await import('../../src/lib/documents/permission-rules.ts');
const { lockDocument } = await import('../../src/lib/documents/sharing.ts');
const { COLLAB_EVENTS_CHANNEL } = await import('../../src/lib/collab/events.ts');
const permissions = await import('../../src/app/api/documents/[id]/permissions/route.ts');
const documentRoute = await import('../../src/app/api/documents/[id]/route.ts');
const restoring = await import('../../src/app/api/documents/[id]/restore/route.ts');
type Permission = keyof ReturnType<typeof defaultPermissionSet>;

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
const EVENT = (id: string) => `{"kind":"permission-set-changed","documentId":"${id}"}`;

// ── Requests ────────────────────────────────────────────────────────────────

const request = (
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
  origin = ORIGIN,
  type: string | null = 'application/json',
) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { origin }),
      ...(body === undefined || type === null ? {} : { 'content-type': type }),
      cookie,
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

const put = (cookie: string, id: string, body: unknown) =>
  permissions.PUT(request('PUT', `/api/documents/${id}/permissions`, cookie, body), at({ id }));
const read = (cookie: string, id: string) =>
  permissions.GET(request('GET', `/api/documents/${id}/permissions`, cookie), at({ id }));
const setCell = (cookie: string, id: string, permission: string, role: string, allowed = true) =>
  put(cookie, id, { changes: { [permission]: { [role]: allowed } } });
const rename = (cookie: string, id: string) =>
  documentRoute.PATCH(request('PATCH', `/api/documents/${id}`, cookie, { title: 'A new title' }), at({ id }));
const code = async (response: Response) => (await response.json()).error.code as string;

// ── Accounts, documents, roles ──────────────────────────────────────────────

let count = 0;
async function person() {
  const email = `settings${++count}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;

async function grant(documentId: string, who: Person, role: 'EDITOR' | 'VIEWER' | 'REVIEWER') {
  const row = await db().documentCollaborator.create({ data: { documentId, userId: who.id, role } });
  return row.id;
}
const stored = async (id: string) =>
  (await db().document.findUniqueOrThrow({ where: { id }, select: { permissionSet: true } })).permissionSet;
const logged = (documentId: string) =>
  db().securityLogEntry.findMany({
    where: { documentId },
    select: { kind: true, userId: true },
    orderBy: { createdAt: 'asc' },
  });

/** An Owner with an Editor, a Viewer and a Reviewer on one document. */
async function four() {
  const owner = await person();
  const editor = await person();
  const viewer = await person();
  const reviewer = await person();
  const id = (await createDocument(owner.id)).id;
  await grant(id, editor, 'EDITOR');
  await grant(id, viewer, 'VIEWER');
  await grant(id, reviewer, 'REVIEWER');
  return { owner, editor, viewer, reviewer, id };
}

/** Holds the document's row for the length of `during`, as a request that is on its way would (see collaborators.test.ts). */
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
  await until(() =>
    /(^|\n)[1-9]\d*$/.test(
      database.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'`),
    ),
  );
  release();
  await transaction;
  return pending;
}

const ALL = Object.keys(PERMISSIONS) as Permission[];
const cells = ALL.flatMap((permission) => ROLES.map((role) => [permission, role] as const));

// ── The Owner changes the set ───────────────────────────────────────────────

describe('changing a cell (FR-ED-45)', () => {
  it('lets the Owner give and take away a permission, answers with the whole set, logs it in the transaction, and publishes after the commit', async () => {
    const { owner, id } = await four();
    const response = await setCell(owner.cookie, id, 'document.rename', 'editor', true);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = (await response.json()) as { message: string; set: Record<string, Record<string, boolean>> };
    expect(body.message).toBe('Saved.');
    // Whole: every permission of the table and every role, the cells that are fixed among them.
    expect(Object.keys(body.set).sort()).toEqual([...ALL].sort());
    for (const permission of ALL)
      expect(Object.keys(body.set[permission]!).sort()).toEqual([...ROLES].sort());
    expect(body.set['document.rename']!.editor).toBe(true);
    expect(body.set).toEqual(await stored(id));
    expect(await stored(id)).toEqual({
      ...defaultPermissionSet(),
      'document.rename': { owner: true, editor: true, reviewer: false, viewer: false },
    });

    // NFR-SE-19: the user who made it and the document, and nothing else; FR-ED-45: "each change".
    expect(await logged(id)).toEqual([{ kind: 'permission_set_changed', userId: owner.id }]);
    // NFR-SE-03 (d): published by kind and document, once the change had committed.
    await until(() => heardFor(id).length === 1);
    expect(heardFor(id)).toEqual([EVENT(id)]);

    expect((await setCell(owner.cookie, id, 'document.rename', 'editor', false)).status).toBe(200);
    expect(await stored(id)).toEqual(defaultPermissionSet());
    await until(() => heardFor(id).length === 2);
    expect(await logged(id)).toHaveLength(2);
  });

  // Weakening: the request answered from a copy of the set, or the next request of the role served from one.
  it('takes effect on the next request of every user who holds the role, with the same session (NFR-SE-04)', async () => {
    const { owner, editor, viewer, id } = await four();
    expect((await rename(editor.cookie, id)).status).toBe(403);
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(200);
    // The Editor does not sign in again.
    expect((await rename(editor.cookie, id)).status).toBe(200);
    // The Viewer's cell is its own: the Editor's was the one given.
    expect((await rename(viewer.cookie, id)).status).toBe(403);
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor', false)).status).toBe(200);
    expect((await rename(editor.cookie, id)).status).toBe(403);
  });

  // Weakening: publish before the commit.
  it('publishes only once the change is committed: what another connection reads of the row at that moment', async () => {
    const { owner, id } = await four();
    const publish = valkey().publish.bind(valkey());
    const seen: unknown[] = [];
    vi.spyOn(valkey(), 'publish').mockImplementation((async (...given: Parameters<typeof publish>) => {
      seen.push(((await stored(id)) as Record<string, { editor: boolean }>)['document.rename']!.editor);
      return publish(...given);
    }) as never);
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(200);
    expect(seen).toEqual([true]);
  });

  // Weakening: a cell that is already as asked written, logged and published again.
  it('answers the value already stored with a statement, and writes, logs and publishes nothing', async () => {
    const { owner, id } = await four();
    const before = await db().document.findUniqueOrThrow({ where: { id } });
    const response = await setCell(owner.cookie, id, 'document.rename', 'editor', false);
    expect(response.status).toBe(200);
    expect((await response.json()).message).toBe(
      'Nothing changed. The permissions are already as requested.',
    );
    expect(await db().document.findUniqueOrThrow({ where: { id } })).toEqual(before);
    const defaults = await put(owner.cookie, id, { defaults: true });
    expect(defaults.status).toBe(200);
    expect((await defaults.json()).message).toBe('The permissions are already the defaults.');
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
  });

  it('changes several cells in one request, with one entry and one notice', async () => {
    const { owner, id } = await four();
    const response = await put(owner.cookie, id, {
      changes: {
        'document.rename': { editor: true },
        'document.export.draft': { editor: false, viewer: true },
        'document.collaborators.view': { viewer: false },
      },
    });
    expect(response.status).toBe(200);
    const set = (await stored(id)) as Record<string, Record<string, boolean>>;
    expect(set['document.rename']!.editor).toBe(true);
    expect(set['document.export.draft']).toMatchObject({ editor: false, viewer: true });
    expect(set['document.collaborators.view']!.viewer).toBe(false);
    expect(await logged(id)).toEqual([{ kind: 'permission_set_changed', userId: owner.id }]);
    await until(() => heardFor(id).length === 1);
    expect(heardFor(id)).toEqual([EVENT(id)]);
  });

  // Weakening: the cells written one at a time past a refused one.
  it('refuses the whole request where one cell is refused, and writes none of the others', async () => {
    const { owner, id } = await four();
    for (const body of [
      { changes: { 'document.rename': { editor: true }, 'document.view': { viewer: false } } },
      { changes: { 'document.rename': { editor: true }, 'document.comments.resolve': { editor: true } } },
      { changes: { 'document.rename': { editor: true }, 'document.rename2': { editor: true } } },
    ]) {
      expect((await put(owner.cookie, id, body)).status).toBe(422);
    }
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await logged(id)).toEqual([]);
    await sleep(100);
    expect(heardFor(id)).toEqual([]);
  });

  // Weakening: the reset leaves the cells of the Reviewer, or of the comment rows, as they were.
  it('returns the whole set to its defaults in one action, the cells that are not shown included, with an entry and a notice', async () => {
    const { owner, id } = await four();
    const changed = defaultPermissionSet();
    changed['document.rename'].editor = true;
    changed['document.collaborators.view'].viewer = false;
    changed['document.comments.resolve'].reviewer = true;
    changed['document.comments.resolve'].editor = false;
    changed['document.collaborators.view'].reviewer = false;
    await db().document.update({ where: { id }, data: { permissionSet: changed } });
    const response = await put(owner.cookie, id, { defaults: true });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.message).toBe('Permissions reset to the defaults.');
    expect(body.set).toEqual(defaultPermissionSet());
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await logged(id)).toEqual([{ kind: 'permission_set_changed', userId: owner.id }]);
    await until(() => heardFor(id).length === 1);
  });

  it('is the table’s on every document: a stored set altered by hand is never the answer for a fixed cell, and a change writes it whole', async () => {
    const { owner, editor, viewer, id } = await four();
    const odd = JSON.parse(JSON.stringify(defaultPermissionSet()));
    odd['document.content.edit'].viewer = true;
    odd['document.rename'].editor = 'true';
    odd['document.delete'].editor = true;
    delete odd['document.leave'];
    await db().document.update({ where: { id }, data: { permissionSet: odd } });
    // A value that is not exactly true refuses; a fixed cell is the table's.
    expect((await rename(editor.cookie, id)).status).toBe(403);
    expect(
      (await documentRoute.DELETE(request('DELETE', `/api/documents/${id}`, editor.cookie), at({ id })))
        .status,
    ).toBe(403);
    expect((await read(viewer.cookie, id)).status).toBe(200);
    expect(
      ((await (await read(viewer.cookie, id)).json()) as { permissions: string[] }).permissions,
    ).not.toContain('document.content.edit');
    expect((await setCell(owner.cookie, id, 'document.export.draft', 'viewer')).status).toBe(200);
    const whole = (await stored(id)) as Record<string, Record<string, unknown>>;
    expect(whole['document.rename']!.editor).toBe(false);
    expect(whole['document.content.edit']!.viewer).toBe(false);
    expect(whole['document.delete']!.editor).toBe(false);
    expect(whole['document.leave']).toEqual({ owner: false, editor: true, reviewer: true, viewer: true });
  });

  it('is the document’s and not its Owner’s: a deletion and a restoration leave the set as it was (FR-ED-45)', async () => {
    const { owner, id } = await four();
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(200);
    const before = await stored(id);
    expect(
      (await documentRoute.DELETE(request('DELETE', `/api/documents/${id}`, owner.cookie), at({ id })))
        .status,
    ).toBe(204);
    expect(
      (await restoring.POST(request('POST', `/api/documents/${id}/restore`, owner.cookie), at({ id })))
        .status,
    ).toBe(200);
    expect(await stored(id)).toEqual(before);
  });
});

// ── Which cells ─────────────────────────────────────────────────────────────

describe('every cell of the table, asked of the route', () => {
  // One document for the cells, set back to the defaults before each.
  let shared: Awaited<ReturnType<typeof four>>;
  beforeAll(async () => {
    shared = await four();
  });
  // Weakening: a fixed cell, a "never" cell, the Owner's column, or the Reviewer's allowed.
  it.each(cells)(
    '%s for the %s, with each value: changed if the Owner may change it, refused with a 422 if not',
    async (permission, role) => {
      const { owner, id } = shared;
      await db().document.update({ where: { id }, data: { permissionSet: defaultPermissionSet() } });
      const state = cellState(permission, role);
      for (const allowed of [true, false]) {
        const before = await stored(id);
        const response = await setCell(owner.cookie, id, permission, role, allowed);
        if (state === 'adjustable') {
          expect(response.status, `${permission} ${role} ${allowed}`).toBe(200);
          const set = (await stored(id)) as Record<string, Record<string, boolean>>;
          expect(set[permission]![role]).toBe(allowed);
          // No other cell was written.
          const was = before as Record<string, Record<string, boolean>>;
          for (const other of ALL)
            for (const who of ROLES) {
              if (other !== permission || who !== role) expect(set[other]![who]).toBe(was[other]![who]);
            }
        } else {
          expect(response.status, `${permission} ${role} ${allowed}`).toBe(422);
          expect(await code(response)).toBe(state === 'not_offered' ? 'not_offered' : 'cell_fixed');
          expect(await stored(id)).toEqual(before);
        }
      }
    },
  );
});

describe('the body', () => {
  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['no cell', '{}'],
    ['defaults that is not true', '{"defaults":false}'],
    ['both', '{"defaults":true,"changes":{"document.rename":{"editor":true}}}'],
    ['a key more', '{"changes":{"document.rename":{"editor":true}},"owner":"x"}'],
    ['a value that is the text "true"', '{"changes":{"document.rename":{"editor":"true"}}}'],
    ['an unknown permission', '{"changes":{"document.nothing":{"editor":true}}}'],
    ['the name of a prototype', '{"changes":{"__proto__":{"editor":true}}}'],
    ['an unknown role', '{"changes":{"document.rename":{"king":true}}}'],
    ['text that is not JSON', '{"changes":'],
  ])('is refused with a 422 and changes nothing: %s', async (_, text) => {
    const { owner, id } = await four();
    const response = await put(owner.cookie, id, text);
    expect(response.status).toBe(422);
    expect(await code(response)).toBe('invalid_request');
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await logged(id)).toEqual([]);
  });

  it('is refused with a 415 where it is not sent as JSON, and with a 422 where it is longer than any honest request', async () => {
    const { owner, id } = await four();
    const text = await permissions.PUT(
      request(
        'PUT',
        `/api/documents/${id}/permissions`,
        owner.cookie,
        '{"defaults":true}',
        ORIGIN,
        'text/plain',
      ),
      at({ id }),
    );
    expect(text.status).toBe(415);
    const long = await put(owner.cookie, id, {
      changes: { 'document.rename': { editor: true } },
      padding: 'x'.repeat(5000),
    });
    expect(long.status).toBe(422);
    expect(await stored(id)).toEqual(defaultPermissionSet());
  });

  it('says on a 422 that nothing was changed, in the words for the owner’s approval', async () => {
    const { owner, id } = await four();
    const fixed = await setCell(owner.cookie, id, 'document.view', 'viewer', false);
    expect((await fixed.json()).error.message).toBe(
      'The permissions were not changed. A permission that is fixed, or never given, for a role cannot be changed.',
    );
    const hidden = await setCell(owner.cookie, id, 'document.comments.resolve', 'editor', false);
    expect((await hidden.json()).error.message).toBe(
      'The permissions were not changed. This role or this permission is not offered in this release.',
    );
    const bad = await put(owner.cookie, id, {});
    expect((await bad.json()).error.message).toBe(
      'The permissions were not changed. Send the cells to change, or ask for the defaults.',
    );
  });
});

// ── Who ─────────────────────────────────────────────────────────────────────

describe('who may change the set (FR-ED-45)', () => {
  // Weakening: the permission of the Owner read as held by another role; a non-Owner allowed.
  it('is the Owner alone: every other role is refused every cell with a 403, logged, whatever the set gives it and whatever is asked', async () => {
    const { editor, viewer, reviewer, id } = await four();
    // The most that any role can be given: every adjustable cell on, and the fixed ones forged on.
    const forged = JSON.parse(JSON.stringify(defaultPermissionSet()));
    for (const permission of ALL) for (const role of ROLES) forged[permission][role] = true;
    await db().document.update({ where: { id }, data: { permissionSet: forged } });
    let refused = 0;
    for (const who of [editor, viewer, reviewer]) {
      for (const [permission, role] of cells) {
        for (const body of [
          { changes: { [permission]: { [role]: false } } },
          { changes: { [permission]: { [role]: true } } },
        ]) {
          const response = await put(who.cookie, id, body);
          // A fixed cell asked by a non-Owner is a 403, and not a 422: authorisation first (Q8).
          expect(response.status, `${permission} ${role}`).toBe(403);
          expect(await code(response.clone())).toBe('forbidden');
          // S16-7 (the owner's decision of 19 October 2026): it does not say that the Owner can give it.
          expect((await response.json()).error.message).toBe('Only the Owner of the document can do this.');
          refused++;
        }
      }
      expect((await put(who.cookie, id, { defaults: true })).status).toBe(403);
      expect((await put(who.cookie, id, {})).status).toBe(403);
      refused += 2;
    }
    expect(await stored(id)).toEqual(forged);
    const entries = await logged(id);
    expect(entries).toHaveLength(refused);
    expect(entries.every(({ kind }) => kind === 'forbidden')).toBe(true);
    expect(new Set(entries.map(({ userId }) => userId))).toEqual(
      new Set([editor.id, viewer.id, reviewer.id]),
    );
    await sleep(100);
    expect(heardFor(id)).toEqual([]);
  });

  it('answers an account with no role, a document that does not exist, and an identifier that is none as one that does not exist', async () => {
    const { id } = await four();
    const stranger = await person();
    for (const call of [
      () => setCell(stranger.cookie, id, 'document.rename', 'editor'),
      () => put(stranger.cookie, id, { defaults: true }),
      () => read(stranger.cookie, id),
      () => setCell(stranger.cookie, randomUUID(), 'document.rename', 'editor'),
      () => put(stranger.cookie, 'x', {}),
    ]) {
      const response = await call();
      expect(response.status).toBe(404);
      expect(await code(response)).toBe('not_found');
    }
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await logged(id)).toEqual([]);
  });

  // Weakening: the document read from the body or looked up without the path's.
  it('acts on the document in the path alone: the Owner of one document has no role on another', async () => {
    const { owner, id } = await four();
    const { owner: other, id: elsewhere } = await four();
    expect((await setCell(owner.cookie, elsewhere, 'document.rename', 'editor')).status).toBe(404);
    expect((await setCell(other.cookie, id, 'document.rename', 'editor')).status).toBe(404);
    expect((await put(owner.cookie, elsewhere, { defaults: true })).status).toBe(404);
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await stored(elsewhere)).toEqual(defaultPermissionSet());
    expect(heardFor(id)).toEqual([]);
    expect(heardFor(elsewhere)).toEqual([]);
    // A change of the one leaves the other as it was.
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(200);
    expect(await stored(elsewhere)).toEqual(defaultPermissionSet());
  });

  it('stops a change for a document that was deleted: it has no set to change', async () => {
    const { owner, id } = await four();
    await db().document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: owner.id } });
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(404);
    expect(await stored(id)).toEqual(defaultPermissionSet());
  });
});

// ── What every request asks ─────────────────────────────────────────────────

describe('the request (NFR-SE-17 (c), NFR-SE-02, NFR-SE-19)', () => {
  // Weakening: the signed copy of the session used for a request that changes state.
  it('reads the row of the session, and never the copy a cookie carries', async () => {
    const { owner, id } = await four();
    await db().session.deleteMany({ where: { userId: owner.id } });
    expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(401);
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await logged(id)).toEqual([]);
    expect(heardFor(id)).toEqual([]);
  });

  // Weakening: the origin not checked before the session and the document.
  it('checks the origin before anything of the request, and a request that is refused changes nothing', async () => {
    const { owner, id } = await four();
    const response = await permissions.PUT(
      request(
        'PUT',
        `/api/documents/${id}/permissions`,
        owner.cookie,
        { changes: { 'document.rename': { editor: true } } },
        'https://elsewhere.example',
      ),
      at({ id }),
    );
    expect(response.status).toBe(403);
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(heardFor(id)).toEqual([]);
  });

  // Weakening: the entry written outside the transaction of the change.
  it('leaves nothing changed, and tells no one, where the entry of the security log cannot be written (D163)', async () => {
    const { owner, id } = await four();
    database.sql(
      `CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
       CREATE TRIGGER refuse_for_test BEFORE INSERT ON "SecurityLogEntry" FOR EACH ROW WHEN (NEW.kind = 'permission_set_changed') EXECUTE FUNCTION refuse_for_test();`,
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await setCell(owner.cookie, id, 'document.rename', 'editor')).status).toBe(500);
      expect((await put(owner.cookie, id, { defaults: true })).status).toBe(200);
    } finally {
      database.sql(`DROP TRIGGER refuse_for_test ON "SecurityLogEntry"; DROP FUNCTION refuse_for_test();`);
    }
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect(await logged(id)).toEqual([]);
    await sleep(200);
    expect(heardFor(id)).toEqual([]);
  });

  it('stands where the notice cannot be published, says so in one line that names no person, and answers', async () => {
    const { owner, editor, id } = await four();
    const lines = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(valkey(), 'publish').mockRejectedValue(
      Object.assign(new Error(`down ${editor.email}`), { code: 'ECONNREFUSED' }),
    );
    const response = await setCell(owner.cookie, id, 'document.rename', 'editor');
    expect(response.status).toBe(200);
    expect(((await stored(id)) as Record<string, { editor: boolean }>)['document.rename']!.editor).toBe(true);
    expect(lines.mock.calls).toEqual([
      [`collab events: permission-set-changed not published for document ${id} (Error ECONNREFUSED)`],
    ]);
    expect(JSON.stringify(lines.mock.calls)).not.toContain(editor.email);
    expect(JSON.stringify(lines.mock.calls)).not.toContain(editor.id);
  });

  it('writes no name, no address and no cell to the log or to the channel', async () => {
    const { owner, editor, id } = await four();
    await setCell(owner.cookie, id, 'document.rename', 'editor');
    await until(() => heardFor(id).length === 1);
    const text = JSON.stringify([await logged(id), heardFor(id)]);
    for (const who of [owner, editor]) {
      expect(text).not.toContain(who.email);
    }
    expect(text).not.toContain('document.rename');
    expect(text).not.toContain('editor');
  });
});

// ── Under the lock ──────────────────────────────────────────────────────────

describe('what authorises a request is read again under the lock of the document', () => {
  // Weakening: the caller's role not read again in the transaction.
  it('refuses an Owner who was replaced after the request was authorised, and changes nothing', async () => {
    const { owner, editor, id } = await four();
    const response = await holding(
      id,
      () => setCell(owner.cookie, id, 'document.rename', 'editor'),
      // The transfer of ownership, committed first: the Editor becomes the Owner and the Owner an Editor.
      async (tx) => {
        await tx.documentCollaborator.deleteMany({ where: { documentId: id, userId: editor.id } });
        await tx.document.update({ where: { id }, data: { ownerId: editor.id } });
        await tx.documentCollaborator.create({ data: { documentId: id, userId: owner.id, role: 'EDITOR' } });
      },
    );
    expect(response.status).toBe(403);
    // The refusal made under the lock says it too (S16-7).
    expect((await response.json()).error.message).toBe('Only the Owner of the document can do this.');
    expect(await stored(id)).toEqual(defaultPermissionSet());
    expect((await logged(id)).map(({ kind }) => kind)).toEqual(['forbidden']);
    expect(heardFor(id)).toEqual([]);
  });

  it('stops a change for a document deleted while it waited', async () => {
    const { owner, id } = await four();
    const response = await holding(
      id,
      () => setCell(owner.cookie, id, 'document.rename', 'editor'),
      async (tx) =>
        void (await tx.document.update({
          where: { id },
          data: { deletedAt: new Date(), deletedById: owner.id },
        })),
    );
    expect(response.status).toBe(404);
    expect(await stored(id)).toEqual(defaultPermissionSet());
  });

  // Weakening: the stored set read before the lock.
  it('is made on the set that a change committed first left, and not on the set it was authorised against', async () => {
    const { owner, id } = await four();
    const response = await holding(
      id,
      () => setCell(owner.cookie, id, 'document.rename', 'editor'),
      async (tx) => {
        const set = defaultPermissionSet();
        set['document.export.draft'].viewer = true;
        await tx.document.update({ where: { id }, data: { permissionSet: set } });
      },
    );
    expect(response.status).toBe(200);
    // Both stand: the change that waited did not write back the set it first saw.
    const set = (await stored(id)) as Record<string, Record<string, boolean>>;
    expect(set['document.rename']!.editor).toBe(true);
    expect(set['document.export.draft']!.viewer).toBe(true);
  });
});

describe('requests at once', () => {
  // Weakening: no lock on the document.
  it('two changes at once are one after the other, and both stand', async () => {
    for (let round = 0; round < 8; round++) {
      const { owner, id } = await four();
      const [a, b, c] = await Promise.all([
        setCell(owner.cookie, id, 'document.rename', 'editor'),
        setCell(owner.cookie, id, 'document.export.draft', 'viewer'),
        setCell(owner.cookie, id, 'document.collaborators.invite', 'editor'),
      ]);
      expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
      const set = (await stored(id)) as Record<string, Record<string, boolean>>;
      expect(set['document.rename']!.editor).toBe(true);
      expect(set['document.export.draft']!.viewer).toBe(true);
      expect(set['document.collaborators.invite']!.editor).toBe(true);
      expect(await logged(id)).toHaveLength(3);
    }
  });
});

// ── Reading ─────────────────────────────────────────────────────────────────

describe('reading the permissions (FR-ED-46)', () => {
  it('gives the Owner the whole stored set, and any other role its own name and what it may do, and nothing of the set', async () => {
    const { owner, editor, viewer, reviewer, id } = await four();
    await setCell(owner.cookie, id, 'document.rename', 'editor');
    const mine = await read(owner.cookie, id);
    expect(mine.headers.get('cache-control')).toBe('no-store');
    const ownerBody = await mine.json();
    expect(ownerBody.role).toBe('owner');
    expect(ownerBody.set).toEqual(await stored(id));

    const held = async (who: Person) => await (await read(who.cookie, id)).json();
    const editorBody = await held(editor);
    expect(editorBody).toEqual({
      role: 'editor',
      permissions: [
        'document.view',
        'document.content.edit',
        'document.collaborators.view',
        'document.rename',
        'document.export.draft',
        'document.leave',
      ],
    });
    expect(await held(viewer)).toEqual({
      role: 'viewer',
      permissions: ['document.view', 'document.collaborators.view', 'document.leave'],
    });
    expect((await held(reviewer)).role).toBe('reviewer');
    for (const who of [editor, viewer, reviewer])
      expect(Object.keys(await held(who)).sort()).toEqual(['permissions', 'role']);
  });

  it('follows a change of the set with no new sign-in', async () => {
    const { owner, viewer, id } = await four();
    expect(
      ((await (await read(viewer.cookie, id)).json()) as { permissions: string[] }).permissions,
    ).not.toContain('document.export.draft');
    await setCell(owner.cookie, id, 'document.export.draft', 'viewer');
    expect(
      ((await (await read(viewer.cookie, id)).json()) as { permissions: string[] }).permissions,
    ).toContain('document.export.draft');
  });
});
