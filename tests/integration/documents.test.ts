// Documents on the server (FR-ED-35, FR-ED-43, FR-ED-39, FR-AU-12, FR-AU-13,
// NFR-SE-04, NFR-SE-08): the four routes, called as Next.js calls them, and the
// one function that authorises a request about a document, against a
// provisioned database.
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('documents', { TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey } = await load();
const { proxy } = await import('../../src/proxy.ts');
const { istorico } = await import('../../src/lib/istorico/index.ts');
const { ensurePersonalWorkspace } = await import('../../src/lib/workspace.ts');
const { authorise, refusal } = await import('../../src/lib/documents/access.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const one = await import('../../src/app/api/documents/[id]/route.ts');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNKNOWN = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const NOT_FOUND =
  'No document was found at this address for this account. Check the address, or open the list of documents.';

const request = (method: string, path: string, cookie?: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { 'content-type': 'application/json', origin: ORIGIN }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
const context = (id: string) => ({ params: Promise.resolve({ id }) });

const list = (cookie?: string) => collection.GET(request('GET', '/api/documents', cookie));
const create = (cookie?: string, body: unknown = {}) =>
  collection.POST(request('POST', '/api/documents', cookie, body));
const read = (cookie: string | undefined, id: string) =>
  one.GET(request('GET', `/api/documents/${id}`, cookie), context(id));
const rename = (cookie: string | undefined, id: string, body: unknown) =>
  one.PATCH(request('PATCH', `/api/documents/${id}`, cookie, body), context(id));

let people = 0;
async function person() {
  const email = `writer${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
/** A document of this person, made through the route. */
async function documentOf(cookie: string): Promise<string> {
  const response = await create(cookie);
  expect(response.status).toBe(201);
  return (await response.json()).id;
}
const row = (id: string) => db().document.findUniqueOrThrow({ where: { id } });
/** The personal workspace of an account, made where the account has none yet (FR-AU-09). */
const workspaceOf = (userId: string) => ensurePersonalWorkspace(userId);
/** One value, read as the administrator. `database.sql` prints the answer to its `SET` first. */
const value = (statement: string) => database.sql(statement).split('\n').at(-1);
const logged = () =>
  db().securityLogEntry.findMany({ select: { kind: true, userId: true, documentId: true } });

async function expectError(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json();
  expect(Object.keys(body)).toEqual(['error']);
  expect(body.error.code).toBe(code);
  return body.error as { code: string; message: string; fields?: Record<string, string> };
}

/** Everything of a response that a caller can see. */
async function seen(response: Response) {
  return {
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: Buffer.from(await response.arrayBuffer()).toString('hex'),
  };
}

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('creating a document (FR-ED-35, FR-AU-12, FR-ED-45)', () => {
  it('creates it for the account of the session, in its personal workspace, with the defaults', async () => {
    const owner = await person();
    const before = Date.now();
    const response = await create(owner.cookie);
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answer = await response.json();
    expect(Object.keys(answer)).toEqual(['id', 'title', 'recording', 'createdAt', 'updatedAt']);
    // A UUID in canonical lower-case text, version 4.
    expect(answer.id).toMatch(UUID_V4);
    expect(answer.title).toBe('Untitled document');
    expect(answer.recording).toBe('UNRECORDED');

    const stored = await row(answer.id);
    expect(stored.ownerId).toBe(owner.id);
    expect(stored.workspaceId).toBe(await workspaceOf(owner.id));
    expect(stored.title).toBe('Untitled document');
    expect(stored.recording).toBe('UNRECORDED');
    expect(stored.deletedAt).toBeNull();
    expect(stored.createdAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(answer.createdAt).toBe(stored.createdAt.toISOString());
    // FR-ED-45: the set is stored whole, with the defaults of FR-ED-44.
    expect(stored.permissionSet).toEqual(defaultPermissionSet());
    expect(Object.keys(stored.permissionSet as object)).toHaveLength(15);
  });

  it('has the database issue the identifier, and never reuses one', async () => {
    expect(
      value(
        `SELECT column_default FROM information_schema.columns WHERE table_schema = 'ekdotico' AND table_name = 'Document' AND column_name = 'id'`,
      ),
    ).toBe('gen_random_uuid()');
    const owner = await person();
    const ids = [
      await documentOf(owner.cookie),
      await documentOf(owner.cookie),
      await documentOf(owner.cookie),
    ];
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('uses the personal workspace without a selection, and creates it where it is missing (FR-AU-09)', async () => {
    const owner = await person();
    expect(await db().workspace.count({ where: { ownerId: owner.id } })).toBe(0);
    const id = await documentOf(owner.cookie);
    expect(await db().workspace.count({ where: { ownerId: owner.id } })).toBe(1);
    expect((await row(id)).workspaceId).toBe(await workspaceOf(owner.id));
  });

  it('accepts the account’s own workspace by name, and refuses every other with one 403', async () => {
    const owner = await person();
    const other = await person();
    await documentOf(other.cookie);
    const own = await workspaceOf(owner.id);
    const theirs = await workspaceOf(other.id);

    const named = await create(owner.cookie, { workspaceId: own });
    expect(named.status).toBe(201);
    expect((await row((await named.json()).id)).workspaceId).toBe(own);

    const documents = await db().document.count();
    const refusals = [];
    for (const body of [
      { workspaceId: theirs },
      { workspaceId: 'no-such-workspace' },
      { workspaceId: '' },
      { workspaceId: 7 },
      { workspaceId: null },
      { workspaceId: [own] },
      // Authorisation before validation: the 403 comes before the 422 of the extra field.
      { workspaceId: theirs, title: 'A title' },
    ]) {
      const response = await create(owner.cookie, body);
      const error = await expectError(response.clone(), 403, 'forbidden');
      expect(error.message).toBe(
        'A document is created in a workspace of the account that creates it. This request named another workspace, and no document was created.',
      );
      refusals.push(await seen(response));
    }
    // Another account's workspace is answered exactly as one that does not exist.
    for (const refused of refusals) expect(refused).toEqual(refusals[0]);
    expect(await db().document.count()).toBe(documents);
    expect(await db().document.count({ where: { workspaceId: theirs, ownerId: owner.id } })).toBe(0);
    // NFR-SE-19: each 403 is logged, with the user and nothing of the request.
    expect((await logged()).filter((entry) => entry.userId === owner.id)).toEqual(
      refusals.map(() => ({ kind: 'forbidden', userId: owner.id, documentId: null })),
    );
  });

  it('takes nothing else from the request: not the mark, the title, the Owner, the identifier, or the set', async () => {
    const owner = await person();
    const other = await person();
    for (const body of [
      { recording: 'RECORDED' },
      { recording: 'UNRECORDED' },
      { recorded: true },
      { title: 'A title' },
      { ownerId: other.id },
      { userId: other.id },
      { id: UNKNOWN },
      { permissionSet: {} },
      { deletedAt: null },
      { createdAt: '2020-01-01T00:00:00.000Z' },
      [],
      [{}],
      'null',
      '7',
      '"text"',
      '{"workspaceId":',
      '',
    ]) {
      const error = await expectError(await create(owner.cookie, body), 422, 'invalid_request');
      expect(Object.keys(error)).toEqual(['code', 'message']);
      expect(error.message).toBe(
        'The request may name the workspace of the document, and nothing else. No document was created.',
      );
    }
    expect(await db().document.count({ where: { ownerId: { in: [owner.id, other.id] } } })).toBe(0);
  });

  it('refuses a body longer than the route expects, and creates nothing', async () => {
    const owner = await person();
    await expectError(
      await create(owner.cookie, `{"workspaceId":"${'a'.repeat(2000)}"}`),
      422,
      'invalid_request',
    );
    expect(await db().document.count({ where: { ownerId: owner.id } })).toBe(0);
  });
});

describe('the mark of a document (FR-ED-43; contract IC-16, IC-49, IC-50)', () => {
  it('reads the capability before the insert, marks the document unrecorded, and does not register it', async () => {
    const owner = await person();
    const port = istorico();
    const capabilities = vi.spyOn(port, 'capabilities');
    const register = vi.spyOn(port, 'registerDocument');
    const erase = vi.spyOn(port, 'erase');
    const insert = vi.spyOn(db().document, 'create');

    const id = await documentOf(owner.cookie);

    expect(capabilities).toHaveBeenCalledTimes(1);
    expect(capabilities.mock.results[0]!.value).toMatchObject({ adapter: 'noop', recording: false });
    expect(insert).toHaveBeenCalledTimes(1);
    expect(capabilities.mock.invocationCallOrder[0]!).toBeLessThan(insert.mock.invocationCallOrder[0]!);
    expect(insert.mock.calls[0]![0].data.recording).toBe('UNRECORDED');
    expect((await row(id)).recording).toBe('UNRECORDED');
    // The port is asked nothing else (IC-49: "makes no other call").
    expect(register).not.toHaveBeenCalled();
    expect(erase).not.toHaveBeenCalled();
  });

  it('decides from the capability and not from the adapter’s name: behind the check, the call registers a recorded document after the commit', async () => {
    const owner = await person();
    const port = istorico();
    // The no-op adapter, reporting the one capability it does not have: the
    // call site of IC-50 is exercised against it, as IC-49 asks.
    const reported = port.capabilities();
    vi.spyOn(port, 'capabilities').mockReturnValue({ ...reported, recording: true });
    const register = vi.spyOn(port, 'registerDocument');
    const insert = vi.spyOn(db().document, 'create');

    const response = await create(owner.cookie);
    expect(response.status).toBe(201);
    const answer = await response.json();
    expect(answer.recording).toBe('RECORDED');

    const stored = await row(answer.id);
    expect(stored.recording).toBe('RECORDED');
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]).toEqual([
      {
        documentId: answer.id,
        ownerUserId: owner.id,
        workspaceKind: 'personal',
        workspaceId: stored.workspaceId,
        createdAt: stored.createdAt.toISOString(),
      },
    ]);
    expect(insert.mock.invocationCallOrder[0]!).toBeLessThan(register.mock.invocationCallOrder[0]!);
    expect(await register.mock.results[0]!.value).toEqual({ ok: true, value: undefined });
  });

  it('never fails or waits because Istorico is unavailable (FR-ED-35)', async () => {
    const owner = await person();
    const port = istorico();
    vi.spyOn(port, 'capabilities').mockReturnValue({ ...port.capabilities(), recording: true });
    // A registration that never settles, and one that reports the port unavailable.
    const register = vi
      .spyOn(port, 'registerDocument')
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce({ ok: false, error: 'unavailable', retryable: true });
    expect((await create(owner.cookie)).status).toBe(201);
    expect((await create(owner.cookie)).status).toBe(201);
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('is permanent: no request changes it', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    for (const body of [
      { recording: 'RECORDED' },
      { title: 'A title', recording: 'RECORDED' },
      { title: 'A title', recorded: true },
    ]) {
      await expectError(await rename(owner.cookie, id, body), 422, 'invalid_request');
    }
    const stored = await row(id);
    expect(stored.recording).toBe('UNRECORDED');
    expect(stored.title).toBe('Untitled document');
    expect((await (await read(owner.cookie, id)).json()).recording).toBe('UNRECORDED');
  });
});

describe('the list of documents (FR-ED-35; API design, "Documents")', () => {
  it('holds the documents of the account of the session, the newest first, and no other account’s', async () => {
    const owner = await person();
    const other = await person();
    const first = await documentOf(owner.cookie);
    const theirs = await documentOf(other.cookie);
    const second = await documentOf(owner.cookie);
    // Two created within one millisecond would be told apart by nothing but the identifier.
    await db().document.update({
      where: { id: first },
      data: { createdAt: new Date('2026-01-01T00:00:00Z') },
    });

    const response = await list(owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const answer = await response.json();
    expect(Object.keys(answer)).toEqual(['documents']);
    expect(answer.documents.map((document: { id: string }) => document.id)).toEqual([second, first]);
    for (const document of answer.documents) {
      expect(Object.keys(document)).toEqual(['id', 'title', 'recording', 'createdAt', 'updatedAt']);
      expect(document.recording).toBe('UNRECORDED');
    }
    expect(answer.documents[1].createdAt).toBe('2026-01-01T00:00:00.000Z');

    const others = await (await list(other.cookie)).json();
    expect(others.documents.map((document: { id: string }) => document.id)).toEqual([theirs]);
  });

  it('is empty for an account without a document, and takes no account from the request', async () => {
    const owner = await person();
    const other = await person();
    await documentOf(owner.cookie);
    expect(await (await list(other.cookie)).json()).toEqual({ documents: [] });
    const asked = await collection.GET(
      request('GET', `/api/documents?ownerId=${owner.id}&userId=${owner.id}`, other.cookie),
    );
    expect(await asked.json()).toEqual({ documents: [] });
  });

  it('leaves a deleted document out (FR-ED-36)', async () => {
    const owner = await person();
    const kept = await documentOf(owner.cookie);
    const deleted = await documentOf(owner.cookie);
    await db().document.update({ where: { id: deleted }, data: { deletedAt: new Date() } });
    const answer = await (await list(owner.cookie)).json();
    expect(answer.documents.map((document: { id: string }) => document.id)).toEqual([kept]);
  });
});

describe('another account’s document (NFR-SE-04, FR-ED-39; the answer to Q8)', () => {
  it('cannot be listed, read, or renamed by a second account', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    expect((await rename(owner.cookie, id, { title: 'The Owner’s title' })).status).toBe(200);

    expect(await (await list(other.cookie)).json()).toEqual({ documents: [] });
    const error = await expectError(await read(other.cookie, id), 404, 'not_found');
    expect(error.message).toBe(NOT_FOUND);
    await expectError(await rename(other.cookie, id, { title: 'Taken' }), 404, 'not_found');

    expect((await row(id)).title).toBe('The Owner’s title');
    expect((await row(id)).ownerId).toBe(owner.id);
    // The Owner still reads it.
    expect((await (await read(owner.cookie, id)).json()).title).toBe('The Owner’s title');
  });

  it('is answered as a document that does not exist is, byte for byte, with the same work of the database', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    const gone = await documentOf(owner.cookie);
    await db().document.update({ where: { id: gone }, data: { deletedAt: new Date() } });
    const title = (await row(id)).title;

    const lookups = vi.spyOn(db().document, 'findUnique');
    const writes = vi.spyOn(db().document, 'update');
    // Another account's document; an unknown identifier; a deleted document,
    // to its own Owner and to another account; and identifiers that are not one.
    const cases: [string, string][] = [
      [other.cookie, id],
      [other.cookie, UNKNOWN],
      [owner.cookie, UNKNOWN],
      [owner.cookie, gone],
      [other.cookie, gone],
      [other.cookie, id.toUpperCase()],
      [owner.cookie, id.toUpperCase()],
      [owner.cookie, `{${id}}`],
      [owner.cookie, id.replaceAll('-', '')],
      [owner.cookie, `${id} `],
      [owner.cookie, `${id}\n`],
      [owner.cookie, 'not-an-identifier'],
      [owner.cookie, "' OR 1=1 --"],
      [owner.cookie, '00000000-0000-0000-0000-000000000000'],
      [owner.cookie, ''],
    ];
    const reads = [];
    const renames = [];
    for (const [cookie, asked] of cases) {
      lookups.mockClear();
      reads.push(await seen(await read(cookie, asked)));
      expect(lookups).toHaveBeenCalledTimes(1);
      lookups.mockClear();
      // A body that would be a 422 if it were looked at: it is not.
      renames.push(await seen(await rename(cookie, asked, { title: 7, recording: 'RECORDED' })));
      expect(lookups).toHaveBeenCalledTimes(1);
    }
    expect(reads[0]!.status).toBe(404);
    expect(Buffer.from(reads[0]!.body, 'hex').toString()).toBe(
      JSON.stringify({ error: { code: 'not_found', message: NOT_FOUND } }),
    );
    for (const each of [...reads, ...renames]) expect(each).toEqual(reads[0]);
    expect(writes).not.toHaveBeenCalled();
    expect((await row(id)).title).toBe(title);
    // A 404 is no 403: nothing is written to the security log for it.
    expect((await logged()).filter((entry) => [owner.id, other.id].includes(entry.userId!))).toEqual([]);
  });

  it('asks for the nil identifier where the request’s is not one, so nothing a caller wrote reaches the query', async () => {
    const owner = await person();
    const lookups = vi.spyOn(db().document, 'findUnique');
    for (const asked of ['not-an-identifier', '\'; DROP TABLE "Document"; --', 'A'.repeat(5000)]) {
      await expectError(await read(owner.cookie, asked), 404, 'not_found');
    }
    expect(lookups.mock.calls.map(([query]) => query.where.id)).toEqual(
      Array(3).fill('00000000-0000-0000-0000-000000000000'),
    );
  });
});

describe('the authorisation of a request about a document (NFR-SE-04, FR-ED-39, FR-ED-44)', () => {
  it('allows the Owner what the table gives the Owner, and forbids what it does not', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    for (const permission of [
      'document.view',
      'document.rename',
      'document.content.edit',
      'document.delete',
      'document.permissions.edit',
      'document.ownership.transfer',
    ] as const) {
      const access = await authorise(owner.id, id, permission);
      expect(access.outcome).toBe('allowed');
      if (access.outcome === 'allowed') {
        expect(access.role).toBe('owner');
        expect(access.document.id).toBe(id);
      }
    }
    // The one permission the Owner never holds: a role without the permission is a 403.
    expect(await authorise(owner.id, id, 'document.leave')).toEqual({ outcome: 'forbidden' });
    // A permission that is not in the table is held by no one.
    expect(await authorise(owner.id, id, 'document.everything' as never)).toEqual({ outcome: 'forbidden' });
  });

  it('finds nothing for an account without a role, whatever the permission', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    for (const permission of ['document.view', 'document.rename', 'document.leave'] as const) {
      expect(await authorise(other.id, id, permission)).toEqual({ outcome: 'not_found' });
    }
    for (const user of ['', 'no-such-user', owner.id.toUpperCase(), `${owner.id} `]) {
      expect(await authorise(user, id, 'document.view')).toEqual({ outcome: 'not_found' });
    }
  });

  it('finds nothing for an identifier that is not one, and does not fail', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    for (const asked of [undefined, null, 7, {}, [id], '', id.toUpperCase(), `${id}x`, ` ${id}`, UNKNOWN]) {
      expect(await authorise(owner.id, asked, 'document.view')).toEqual({ outcome: 'not_found' });
    }
  });

  it('finds nothing for a deleted document, for its Owner too (FR-ED-36)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    await db().document.update({ where: { id }, data: { deletedAt: new Date() } });
    expect(await authorise(owner.id, id, 'document.view')).toEqual({ outcome: 'not_found' });
    expect(await authorise(owner.id, id, 'document.rename')).toEqual({ outcome: 'not_found' });
    await db().document.update({ where: { id }, data: { deletedAt: null } });
    expect((await authorise(owner.id, id, 'document.view')).outcome).toBe('allowed');
  });

  it('reads the role from current state on every request: nothing is kept between two', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    expect((await read(owner.cookie, id)).status).toBe(200);
    expect((await read(other.cookie, id)).status).toBe(404);

    // The Owner changes, as a transfer of ownership will change it. Neither
    // account signs in again.
    await db().document.update({
      where: { id },
      data: { ownerId: other.id, workspaceId: await workspaceOf(other.id) },
    });
    expect((await read(owner.cookie, id)).status).toBe(404);
    expect((await rename(owner.cookie, id, { title: 'No longer mine' })).status).toBe(404);
    expect((await read(other.cookie, id)).status).toBe(200);
    expect((await rename(other.cookie, id, { title: 'Mine now' })).status).toBe(200);
    expect((await row(id)).title).toBe('Mine now');
    expect((await list(owner.cookie).then((response) => response.json())).documents).toEqual([]);
  });

  it('does not let a stored set take from the Owner what the table fixes', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    for (const permissionSet of [{}, [], 'nothing', { 'document.rename': { owner: false } }]) {
      await db().document.update({ where: { id }, data: { permissionSet } });
      expect((await authorise(owner.id, id, 'document.rename')).outcome).toBe('allowed');
      expect((await rename(owner.cookie, id, { title: 'Still the Owner’s' })).status).toBe(200);
      expect(await authorise(owner.id, id, 'document.leave')).toEqual({ outcome: 'forbidden' });
    }
  });

  it('answers a refusal with a 404 or a 403, and writes the 403 to the security log (NFR-SE-19)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);

    const missing = await refusal({ outcome: 'not_found' }, owner.id, id);
    expect((await expectError(missing, 404, 'not_found')).message).toBe(NOT_FOUND);
    expect((await logged()).filter((entry) => entry.userId === owner.id)).toEqual([]);

    const forbidden = await refusal({ outcome: 'forbidden' }, owner.id, id);
    const error = await expectError(forbidden, 403, 'forbidden');
    expect(Object.keys(error)).toEqual(['code', 'message']);
    expect(error.message).toBe(
      'The role of this account on the document does not hold the permission for this action. The Owner of the document can give it.',
    );
    expect((await logged()).filter((entry) => entry.userId === owner.id)).toEqual([
      { kind: 'forbidden', userId: owner.id, documentId: id },
    ]);
  });
});

describe('the title of a document (FR-ED-35, NFR-SE-08, NFR-I18-03)', () => {
  it('is stored as written and returned unaltered', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    for (const title of [
      '<script>alert("x")</script>',
      `"double" 'single' \`back\` & <b>bold</b> </title>`,
      '‮right to left‬ ‏ mark ‎',
      'Ελληνικά, 中文, العربية, 😀 👩‍👩‍👧‍👦',
      '  spaces kept at both ends  ',
      'a\tb\nc',
      '\'; DROP TABLE "Document"; --',
      'a'.repeat(200),
      '😀'.repeat(200),
    ]) {
      const response = await rename(owner.cookie, id, { title });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      const answer = await response.json();
      expect(Object.keys(answer)).toEqual(['id', 'title', 'recording', 'createdAt', 'updatedAt']);
      expect(answer.title).toBe(title);
      expect((await row(id)).title).toBe(title);
      expect((await (await read(owner.cookie, id)).json()).title).toBe(title);
      expect((await (await list(owner.cookie)).json()).documents[0].title).toBe(title);
      // No character added or removed in the database either.
      expect(value(`SELECT char_length(title) FROM "Document" WHERE id = '${id}'`)).toBe(
        String([...title].length),
      );
    }
  });

  it('is refused where it is longer than 200 characters, and the title stays', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    await rename(owner.cookie, id, { title: 'Kept' });
    for (const title of ['a'.repeat(201), '😀'.repeat(201), ' '.repeat(201)]) {
      const error = await expectError(await rename(owner.cookie, id, { title }), 422, 'invalid');
      expect(error.message).toBe(
        'The title was not changed, because it does not meet its rule. Change the title and try again.',
      );
      expect(error.fields).toEqual({ title: 'A title has at most 200 characters. Enter a shorter title.' });
    }
    expect((await row(id)).title).toBe('Kept');
  });

  it('is stored as the default where it is empty', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    for (const title of ['', '   ', '\t\n']) {
      await rename(owner.cookie, id, { title: 'Something else' });
      const response = await rename(owner.cookie, id, { title });
      expect(response.status).toBe(200);
      expect((await response.json()).title).toBe('Untitled document');
      expect((await row(id)).title).toBe('Untitled document');
    }
  });

  it('is refused where it cannot be stored, or is not text, or is not alone', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    await rename(owner.cookie, id, { title: 'Kept' });
    const elsewhere = await workspaceOf(other.id);

    for (const title of ['a\u0000b', 'half \ud83d of a pair']) {
      const error = await expectError(await rename(owner.cookie, id, { title }), 422, 'invalid');
      expect(error.fields).toEqual({
        title: 'The title holds a character that cannot be stored. Remove the character and try again.',
      });
    }
    for (const body of [
      {},
      { title: 7 },
      { title: null },
      { title: ['A title'] },
      { title: { text: 'A title' } },
      // FR-AU-13: no route moves a document to another workspace; nor to another Owner.
      { title: 'A title', workspaceId: elsewhere },
      { workspaceId: elsewhere },
      { title: 'A title', ownerId: other.id },
      { title: 'A title', permissionSet: {} },
      { title: 'A title', id: UNKNOWN },
      { title: 'A title', deletedAt: '2026-01-01T00:00:00.000Z' },
      ['A title'],
      '"A title"',
      '{"title":',
      '',
      `{"title":"${'a'.repeat(5000)}"}`,
    ]) {
      const error = await expectError(await rename(owner.cookie, id, body), 422, 'invalid_request');
      expect(error.message).toBe(
        'The request must give the title as text, and nothing else. The title was not changed.',
      );
    }
    const stored = await row(id);
    expect(stored.title).toBe('Kept');
    expect(stored.ownerId).toBe(owner.id);
    expect(stored.workspaceId).toBe(await workspaceOf(owner.id));
    expect(stored.permissionSet).toEqual(defaultPermissionSet());
    expect(stored.deletedAt).toBeNull();
  });

  it('is held to its length by the database as well', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(db().document.update({ where: { id }, data: { title: 'a'.repeat(201) } })).rejects.toThrow();
    await expect(db().document.update({ where: { id }, data: { title: '' } })).rejects.toThrow();
    await db().document.update({ where: { id }, data: { title: '😀'.repeat(200) } });
    errors.mockRestore();
  });
});

describe('the session of the four routes (NFR-SE-02, NFR-SE-17 (c), FR-AU-07)', () => {
  it('answers 401 without a valid session, before anything else', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const documents = await db().document.count();
    for (const cookie of [undefined, '__Secure-better-auth.session_token=made-up.c2ln']) {
      for (const response of [
        await list(cookie),
        await create(cookie),
        await create(cookie, { nothing: true }),
        await read(cookie, id),
        await read(cookie, UNKNOWN),
        await rename(cookie, id, { title: 'Taken' }),
        await rename(cookie, 'not-an-identifier', { title: 7 }),
      ]) {
        const error = await expectError(response, 401, 'unauthenticated');
        expect(error.message).toBe('This request needs a signed-in session. Sign in and try again.');
      }
    }
    expect(await db().document.count()).toBe(documents);
    expect((await row(id)).title).toBe('Untitled document');
  });

  it('reads the row for a request that changes state: an ended session creates and renames nothing, although its copy is fresh', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    await db().session.deleteMany({ where: { userId: owner.id } });

    // A read may still be answered from the signed copy, for up to a minute (NFR-SE-17 (c)).
    expect((await list(owner.cookie)).status).toBe(200);
    expect((await read(owner.cookie, id)).status).toBe(200);
    // What changes state is refused at once.
    await expectError(await create(owner.cookie), 401, 'unauthenticated');
    await expectError(await rename(owner.cookie, id, { title: 'After the end' }), 401, 'unauthenticated');
    expect(await db().document.count({ where: { ownerId: owner.id } })).toBe(1);
    expect((await row(id)).title).toBe('Untitled document');
  });

  it('is behind the proxy: a session and, to change state, the origin of the application', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const call = (method: string, path: string, headers: Record<string, string>) =>
      proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers }));
    const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';
    const cookie = owner.cookie;
    for (const path of ['/api/documents', `/api/documents/${id}`]) {
      expect((await call('GET', path, {})).status).toBe(401);
      expect(passed(await call('GET', path, { cookie }))).toBe(true);
    }
    for (const [method, path] of [
      ['POST', '/api/documents'],
      ['PATCH', `/api/documents/${id}`],
    ] as const) {
      expect((await call(method, path, { origin: ORIGIN })).status).toBe(401);
      expect((await call(method, path, { cookie, origin: 'https://evil.example' })).status).toBe(403);
      expect((await call(method, path, { cookie })).status).toBe(403);
      expect(passed(await call(method, path, { cookie, origin: ORIGIN }))).toBe(true);
    }
  });
});

describe('what is logged (NFR-SE-19, NFR-SE-06 A10)', () => {
  const TITLE = 'A title that no log may hold';

  it('writes nothing to a log in the course of creating, listing, reading, and renaming', async () => {
    const consoles = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    const owner = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    await rename(owner.cookie, id, { title: TITLE });
    await rename(owner.cookie, id, { title: `${TITLE} ${'a'.repeat(200)}` });
    await list(owner.cookie);
    await read(owner.cookie, id);
    await read(other.cookie, id);
    await rename(other.cookie, id, { title: TITLE });
    await create(owner.cookie, { workspaceId: 'another-workspace' });
    for (const spy of consoles) expect(spy).not.toHaveBeenCalled();
    // The security log has no column a title, a name, or an address could be in.
    expect(JSON.stringify(await db().securityLogEntry.findMany())).not.toContain('title');
    expect(JSON.stringify(await db().securityLogEntry.findMany())).not.toContain('example.com');
  });

  it('answers a fault without a word of it, and logs its class alone', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // An error of the database can quote a row: a title, and an address.
    const quoting = new Error(`Failing row contains (${TITLE}, ${owner.email}).`);
    for (const method of ['findUnique', 'findMany', 'create', 'update'] as const) {
      vi.spyOn(db().document, method).mockRejectedValue(quoting);
    }
    for (const response of [
      await list(owner.cookie),
      await create(owner.cookie),
      await read(owner.cookie, id),
      await rename(owner.cookie, id, { title: TITLE }),
    ]) {
      const error = await expectError(response, 500, 'internal');
      expect(error.message).toBe(
        'The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes.',
      );
    }
    expect(errors.mock.calls).toEqual(Array(4).fill(['documents: request failed (Error)']));
  });
});

describe('the rows a document rests on (plan, C17)', () => {
  it('are not deleted from under it: neither its Owner’s nor its workspace’s', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const workspace = await workspaceOf(owner.id);
    expect(() => database.sql(`DELETE FROM "Workspace" WHERE id = '${workspace}'`)).toThrow(/foreign key/);
    expect(() => database.sql(`DELETE FROM "User" WHERE id = '${owner.id}'`)).toThrow(/foreign key/);
    expect((await row(id)).ownerId).toBe(owner.id);
  });
});
