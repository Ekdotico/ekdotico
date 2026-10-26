// The Markdown draft export (FR-EX-01 (a), FR-EX-02, FR-EX-36; NFR-SE-02, NFR-SE-07, NFR-SE-08, NFR-SE-17 (c),
// NFR-SE-19, NFR-PE-01, NFR-I18-03, NFR-I18-04; docs/plan/slice-21.md): the route as the router calls it, against a
// provisioned database and the real Valkey, with the store of the tests in place of Spaces. It is the security-
// sensitive part of the slice, so each test of a rule names the weakening that makes it fail.
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  DOCUMENT_ID,
  NOW,
  bodyOf,
  br,
  editorState,
  el,
  entry,
  fileOf,
  heading,
  image,
  note,
  notes,
  p,
  stateOf,
  table,
  cell,
  row,
  tx,
  bullets,
  item,
} from '../unit/export-fixtures.ts';
import { collect, readZip } from '../unit/zip-reader.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';
import { MemoryStorage } from './image-storage.ts';

// Ten seconds are 1 here, and the limit is 6, so that the idle period and the limit are reached with little.
const database = prepare('draftexport', {
  EXPORT_IDLE_SECONDS: '1',
  RATE_LIMIT_EXPORTS_PER_USER: '6/3600',
  IMAGE_DOCUMENT_MEGABYTES: '25',
});
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { newObjectKey } = await import('../../src/lib/images/storage.ts');
const { loadState, storeState } = await import('../../src/lib/collab/state.ts');
const { takeExportLock } = await import('../../src/lib/export/lock.ts');
const exporting = await import('../../src/app/api/documents/[id]/export/draft/route.ts');
const one = await import('../../src/app/api/documents/[id]/route.ts');
const permissions = await import('../../src/app/api/documents/[id]/permissions/route.ts');

afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

let storage: MemoryStorage;
beforeEach(() => {
  storage = new MemoryStorage();
  useImageStorage(storage);
});
afterEach(() => vi.restoreAllMocks());

// ── People, documents, images ───────────────────────────────────────────────

let people = 0;
async function person() {
  const email = `export-person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;

async function documentFor(owner: Person, state: Uint8Array | null = null, title = 'A document') {
  const { id } = await createDocument(owner.id);
  await db().document.update({
    where: { id },
    data: { title, ...(state ? { yjsState: Buffer.from(state) } : {}) },
  });
  return id;
}
const ROLES = { editor: 'EDITOR', reviewer: 'REVIEWER', viewer: 'VIEWER' } as const;
const share = (documentId: string, who: Person, role: keyof typeof ROLES) =>
  db().documentCollaborator.create({ data: { documentId, userId: who.id, role: ROLES[role] } });

const png = (size: number, fill = 1) => Buffer.alloc(size, fill);
/** An image that the document holds a row for and the store holds an object for. */
async function stored(owner: Person, documentId: string, bytes: Uint8Array, contentType = 'image/png') {
  const objectKey = newObjectKey(documentId);
  const row = await db().documentImage.create({
    data: { documentId, objectKey, contentType, byteSize: bytes.length, uploadedById: owner.id },
  });
  storage.objects.set(objectKey, { bytes, contentType });
  return { id: row.id, objectKey };
}

const at = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (documentId: string, cookie: string | undefined, headers: Record<string, string> = {}) =>
  exporting.POST(
    new Request(`${ORIGIN}/api/documents/${documentId}/export/draft`, {
      method: 'POST',
      headers: { origin: ORIGIN, ...(cookie ? { cookie } : {}), ...headers },
    }),
    at(documentId),
  );
const archiveOf = async (response: Response) => readZip(await collect(response.body!));
const errorOf = async (response: Response) =>
  (await response.json()).error as { code: string; message: string };
const lockExists = async (userId: string) => (await valkey().exists(`export-lock:${userId}`)) === 1;

/** Reads the body until it errors; what was read before, and the error. */
async function untilError(response: Response) {
  const reader = response.body!.getReader();
  const read: Uint8Array[] = [];
  for (;;) {
    try {
      const { done, value } = await reader.read();
      if (done) return { read, error: null };
      read.push(value);
    } catch (error) {
      return { read, error };
    }
  }
}

// ── Who may ask ─────────────────────────────────────────────────────────────

describe('authorisation (NFR-SE-02, NFR-SE-04, NFR-SE-17 (c), FR-ED-44)', () => {
  it('checks the origin before anything is locked, counted or read', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const kept = await stored(owner, id, png(100));
    await db().document.update({
      where: { id },
      data: { yjsState: Buffer.from(stateOf(image({ id: kept.id, alt: 'x' }))) },
    });
    // Ten requests from another origin: the limit of the hour is 6, and none of them is counted against it.
    for (let n = 0; n < 10; n += 1) {
      const foreign = await post(id, owner.cookie, { origin: 'https://evil.example' });
      expect(foreign.status).toBe(403);
      expect(await lockExists(owner.id)).toBe(false);
    }
    expect(storage.reads).toEqual([]);
    for (let n = 0; n < 6; n += 1) {
      expect((await archiveOf(await post(id, owner.cookie))).length, `export ${n + 1}`).toBe(2);
    }
  });

  it('answers a request with no session 401, and a request from another origin 403, and sends no byte of the document', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('a secret sentence')));
    const none = await post(id, undefined);
    expect(none.status).toBe(401);
    expect(await none.text()).not.toContain('secret');
    for (const origin of ['https://evil.example', 'null', '']) {
      const foreign = await post(id, owner.cookie, { origin });
      expect(foreign.status, origin).toBe(403);
      expect(await foreign.text()).not.toContain('secret');
    }
    const absent = await exporting.POST(
      new Request(`${ORIGIN}/api/documents/${id}/export/draft`, {
        method: 'POST',
        headers: { cookie: owner.cookie },
      }),
      at(id),
    );
    expect(absent.status).toBe(403);
    expect(storage.reads).toEqual([]);
  });

  it('reads the session`s row and not the cookie`s signed copy: a session that has ended gets no export', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    expect((await archiveOf(await post(id, owner.cookie))).length).toBe(1);
    await db().session.deleteMany({ where: { userId: owner.id } });
    // The copy in the cookie is valid for a minute: a request that only reads is still answered with it ...
    const read = await one.GET(
      new Request(`${ORIGIN}/api/documents/${id}`, { headers: { cookie: owner.cookie } }),
      at(id),
    );
    expect(read.status).toBe(200);
    // ... and the export is not.
    const refused = await post(id, owner.cookie);
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain('words');
  });

  it('gives an account whose deletion is confirmed no export (FR-AU-58 (a)), though its cookie and its session are good', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words of a leaving account')));
    expect((await archiveOf(await post(id, owner.cookie))).length).toBe(1);
    await db().accountDeletion.create({ data: { userId: owner.id } });
    const refused = await post(id, owner.cookie);
    expect(refused.status).toBe(401);
    expect(await refused.text()).not.toContain('leaving');
    expect(await lockExists(owner.id)).toBe(false);
    expect(storage.reads).toEqual([]);
  });

  it('answers a document of another account, and one that does not exist, with the same 404', async () => {
    const owner = await person();
    const stranger = await person();
    const id = await documentFor(owner, stateOf(p('private')));
    const foreign = await post(id, stranger.cookie);
    const missing = await post(DOCUMENT_ID, stranger.cookie);
    const malformed = await post('not-an-identifier', stranger.cookie);
    for (const response of [foreign, missing, malformed]) expect(response.status).toBe(404);
    const [a, b, c] = await Promise.all([foreign.text(), missing.text(), malformed.text()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).not.toContain('private');
    // A request that fails to find anything holds no lock, counts nothing, and reads no object.
    expect(storage.reads).toEqual([]);
    expect(await lockExists(stranger.id)).toBe(false);
  });

  it('answers 404 for a document that was deleted after the request was authorised, with no lock held and no export counted', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('deleted meanwhile')));
    const { draftExport } = await import('../../src/lib/export/draft.ts');
    const row = await db().document.findUniqueOrThrow({ where: { id } });
    // The decision of the route was taken while the document was live; the deletion came after it.
    await db().document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: owner.id } });
    const document: Omit<typeof row, 'yjsState'> & { yjsState?: unknown } = { ...row };
    delete document.yjsState;
    const response = await draftExport({
      request: new Request(`${ORIGIN}/x`, { method: 'POST' }),
      session: { userId: owner.id } as never,
      document,
      role: 'owner',
      params: { id },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('deleted meanwhile');
    expect(await lockExists(owner.id)).toBe(false);
    // Not counted: the six of the hour are all there.
    const live = await documentFor(owner, stateOf(p('live')));
    for (let n = 0; n < 6; n += 1) expect((await archiveOf(await post(live, owner.cookie))).length).toBe(1);
  });

  it('answers a deleted document 404, with nothing of it', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('deleted words')));
    await db().document.update({ where: { id }, data: { deletedAt: new Date(), deletedById: owner.id } });
    const response = await post(id, owner.cookie);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('deleted words');
    expect(await lockExists(owner.id)).toBe(false);
  });

  it('follows the permission set as it is when asked: an Editor yes, a Viewer and a Reviewer no, until the Owner gives it, and no more once taken', async () => {
    const owner = await person();
    const editor = await person();
    const viewer = await person();
    const reviewer = await person();
    const id = await documentFor(owner, stateOf(p('shared words')));
    await share(id, editor, 'editor');
    await share(id, viewer, 'viewer');
    await share(id, reviewer, 'reviewer');
    expect((await post(id, owner.cookie)).status).toBe(200);
    expect((await post(id, editor.cookie)).status).toBe(200);
    for (const who of [viewer, reviewer]) {
      const refused = await post(id, who.cookie);
      expect(refused.status).toBe(403);
      expect(await refused.text()).not.toContain('shared words');
    }
    // 403 is written to the security log with the user and the document (NFR-SE-19).
    const entries = await db().securityLogEntry.findMany({ where: { documentId: id, kind: 'forbidden' } });
    expect(entries.map((each) => each.userId).sort()).toEqual([viewer.id, reviewer.id].sort());

    const change = (allowed: boolean) =>
      permissions.PUT(
        new Request(`${ORIGIN}/api/documents/${id}/permissions`, {
          method: 'PUT',
          headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: owner.cookie },
          body: JSON.stringify({ changes: { 'document.export.draft': { viewer: allowed } } }),
        }),
        at(id),
      );
    expect((await change(true)).status).toBe(200);
    expect((await post(id, viewer.cookie)).status).toBe(200);
    expect((await post(id, reviewer.cookie)).status).toBe(403);
    expect((await change(false)).status).toBe(200);
    expect((await post(id, viewer.cookie)).status).toBe(403);
  });

  it('is limited to the document it is asked of: the export of one document holds nothing of another of the same owner', async () => {
    const owner = await person();
    const first = await documentFor(owner, stateOf(p('FIRST DOCUMENT')), 'First');
    const second = await documentFor(owner, stateOf(p('SECOND DOCUMENT')), 'Second');
    const entries = await archiveOf(await post(first, owner.cookie));
    expect(entries[0]!.name).toBe('First.md');
    expect(entries[0]!.bytes.toString()).toContain('FIRST DOCUMENT');
    expect(entries[0]!.bytes.toString()).not.toContain('SECOND');
    expect(entries[0]!.bytes.toString()).toContain(`id: ${first}`);
    expect(entries[0]!.bytes.toString()).not.toContain(second);
  });
});

// ── What is in the archive ──────────────────────────────────────────────────

describe('the archive (FR-EX-36)', () => {
  it('is a ZIP file named from the title, that holds the Markdown file named from the title, and sends no copy', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(heading(1, 'Hello'), p('World.')), 'My thesis');
    const response = await post(id, owner.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/zip');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="My thesis.zip"; filename*=UTF-8''My%20thesis.zip`,
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    // A proxy is told not to keep it (docs/operations/deployment.md, item 13).
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    // Streamed: it has no length.
    expect(response.headers.get('content-length')).toBeNull();
    const entries = readZip(await collect(response.body!));
    expect(entries.map((each) => each.name)).toEqual(['My thesis.md']);
    const file = entries[0]!.bytes.toString('utf8');
    expect(file.replace(/^date: .*$/mu, 'date: X')).toBe(
      fileOf(stateOf(heading(1, 'Hello'), p('World.')), { title: 'My thesis', id }).replace(
        /^date: .*$/mu,
        'date: X',
      ),
    );
    expect(file).toMatch(
      new RegExp(
        `^---\\ntitle: "My thesis"\\ndate: ${new Date().toISOString().slice(0, 10)}\\nid: ${id}\\ndraft: true\\n---\\n`,
        'u',
      ),
    );
    expect(storage.reads).toEqual([]);
  });

  it('derives both names from the title by the one rule, whatever the title holds', async () => {
    const titles: [string, string][] = [
      ['../../etc/passwd', 'etcpasswd'],
      ['..\\..\\Windows', 'Windows'],
      ['a"; filename="evil.exe', 'a; filename=evil.exe'],
      ['report‮gpj.exe', 'reportgpj.exe'],
      ['line\r\nSet-Cookie: x=1', 'lineSet-Cookie_ x=1'],
      ['x'.repeat(150), 'x'.repeat(100)],
      // The review of pull request 59: titles the rule passed and the archive refused, after a 200.
      ['Q: notes', 'Q_ notes'],
      ['研究'.repeat(45), '研究'.repeat(41) + '研'],
      ['📚'.repeat(70), '📚'.repeat(62)],
      ['CON', '_CON'],
      ['/', 'document'],
      ['..', 'document'],
      ['Εκδοτικό 論文 📚', 'Εκδοτικό 論文 📚'],
    ];
    for (const [title, stem] of titles) {
      // An account of its own for each: the limit of the hour is not what is tested here.
      const asker = await person();
      const id = await documentFor(asker, stateOf(p('x')), title);
      const response = await post(id, asker.cookie);
      expect(response.status, title).toBe(200);
      const header = response.headers.get('content-disposition')!;
      expect(header, title).not.toMatch(/[\r\n]/u);
      expect(header, title).toContain(
        `filename*=UTF-8''${encodeURIComponent(`${stem}.zip`).replace(/['()*]/gu, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
      );
      const entries = readZip(await collect(response.body!));
      expect(
        entries.map((each) => each.name),
        title,
      ).toEqual([`${stem}.md`]);
      // The title is in the front matter as it is, and as a string.
      expect(entries[0]!.bytes.toString()).toContain('title: "');
    }
  });

  it('asks the archive about its names before the response begins: a name it refuses is a statement, and not a reset after a 200', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words')), 'Any title');
    const naming = await import('../../src/lib/export/name.ts');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(naming, 'exportName').mockReturnValueOnce('a/../b');
    const refused = await post(id, owner.cookie);
    expect(refused.status).toBe(500);
    expect((await errorOf(refused)).code).toBe('internal');
    expect(await lockExists(owner.id)).toBe(false);
    // Not counted: the six of the hour are all there.
    for (let n = 0; n < 6; n += 1) expect((await archiveOf(await post(id, owner.cookie))).length).toBe(1);
  });

  it('holds each image as the store holds it, named by its order in the document, and refers to it by that path', async () => {
    const owner = await person();
    const first = png(5000, 1);
    const second = Buffer.from('GIF89a-second'.padEnd(3000, 'x'));
    const id = await documentFor(owner);
    const one1 = await stored(owner, id, first);
    const two = await stored(owner, id, second, 'image/gif');
    const jpeg = await stored(owner, id, Buffer.alloc(100, 9), 'image/jpeg');
    const webp = await stored(owner, id, Buffer.alloc(10, 3), 'image/webp');
    const state = stateOf(
      p('before'),
      image({ id: two.id, alt: 'second image', caption: 'Figure 1' }),
      image({ id: one1.id, alt: 'first image' }),
      image({ id: two.id, alt: 'second again' }),
      bullets(item(p('x'), image({ id: jpeg.id, alt: 'jpeg' }))),
      table('', row(cell({}, image({ id: webp.id, alt: 'webp' })))),
    );
    await db().document.update({ where: { id }, data: { yjsState: Buffer.from(state) } });
    const entries = await archiveOf(await post(id, owner.cookie));
    expect(entries.map((each) => each.name)).toEqual([
      'A document.md',
      'images/001.gif',
      'images/002.png',
      'images/003.jpg',
      'images/004.webp',
    ]);
    expect(entries[1]!.bytes.equals(second)).toBe(true);
    expect(entries[2]!.bytes.equals(first)).toBe(true);
    expect(entries[3]!.bytes.length).toBe(100);
    const file = entries[0]!.bytes.toString();
    expect(file).toContain('![second image](images/001.gif)\n\nFigure 1');
    expect(file).toContain('![first image](images/002.png)');
    expect(file).toContain('![second again](images/001.gif)');
    expect(file).toContain('![jpeg](images/003.jpg)');
    expect(file).toContain('![webp](images/004.webp)');
    // Each object is read once, however many blocks name it.
    expect([...storage.reads].sort()).toEqual(
      [one1.objectKey, two.objectKey, jpeg.objectKey, webp.objectKey].sort(),
    );
    // The Markdown holds no address of the store: the archive is whole in itself.
    expect(file).not.toMatch(/memory:|https?:\/\//u);
  });

  it('is the Markdown file alone for a document without images, and for one that was never stored', async () => {
    const owner = await person();
    const text = await documentFor(owner, stateOf(p('no images here')));
    const empty = await documentFor(owner);
    for (const id of [text, empty]) {
      const entries = await archiveOf(await post(id, owner.cookie));
      expect(entries.map((each) => each.name)).toEqual(['A document.md']);
      expect(entries[0]!.bytes.toString()).toContain('> Draft export — not a provenance-sealed document.');
    }
    expect(storage.reads).toEqual([]);
  });

  it('writes an image block whose image is not this document`s as its words, and reads no object for it', async () => {
    const owner = await person();
    const other = await person();
    const mine = await documentFor(owner, null, 'Mine');
    const theirs = await documentFor(other, null, 'Theirs');
    const foreign = await stored(other, theirs, png(300, 5));
    const claimed = await stored(owner, mine, png(300, 6));
    await db().documentImage.update({ where: { id: claimed.id }, data: { deletionClaimedAt: new Date() } });
    const state = stateOf(
      image({ id: foreign.id, alt: 'a foreign image', caption: 'its caption' }),
      image({ id: claimed.id, alt: 'a claimed image' }),
      image({ id: '../../etc/passwd', alt: 'a path' }),
      image({ id: 'https://evil.example/x.png', alt: 'a url' }),
      image({ id: 'data:image/png;base64,AAAA', alt: 'a data url' }),
      image({ id: `c${'z'.repeat(24)}`, alt: 'an identifier of no image' }),
    );
    await db().document.update({ where: { id: mine }, data: { yjsState: Buffer.from(state) } });
    const entries = await archiveOf(await post(mine, owner.cookie));
    expect(entries.map((each) => each.name)).toEqual(['Mine.md']);
    const file = entries[0]!.bytes.toString();
    for (const words of [
      'a foreign image',
      'its caption',
      'a claimed image',
      'a path',
      'a url',
      'a data url',
      'an identifier of no image',
    ]) {
      expect(file).toContain(words);
    }
    expect(file).not.toContain('](');
    expect(storage.reads).toEqual([]);
    // And the other owner's export of their own document does hold it.
    const theirsEntries = await archiveOf(
      await (async () => {
        await db().document.update({
          where: { id: theirs },
          data: { yjsState: Buffer.from(stateOf(image({ id: foreign.id, alt: 'mine' }))) },
        });
        return post(theirs, other.cookie);
      })(),
    );
    expect(theirsEntries.map((each) => each.name)).toEqual(['Theirs.md', 'images/001.png']);
  });

  it('reads nothing of an image that is the same identifier in another document, though a block names it', async () => {
    const owner = await person();
    const a = await documentFor(owner, null, 'A');
    const b = await documentFor(owner, null, 'B');
    const inB = await stored(owner, b, png(100, 2));
    await db().document.update({
      where: { id: a },
      data: { yjsState: Buffer.from(stateOf(image({ id: inB.id, alt: 'cross' }))) },
    });
    const entries = await archiveOf(await post(a, owner.cookie));
    expect(entries.map((each) => each.name)).toEqual(['A.md']);
    expect(storage.reads).toEqual([]);
  });

  it('is a 503 for a document with images where there is no store, before a byte, and is no export that is counted', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const kept = await stored(owner, id, png(100));
    await db().document.update({
      where: { id },
      data: { yjsState: Buffer.from(stateOf(image({ id: kept.id, alt: 'x' }))) },
    });
    useImageStorage(null);
    const refused = await post(id, owner.cookie);
    expect(refused.status).toBe(503);
    expect((await errorOf(refused)).code).toBe('images_unavailable');
    expect(await lockExists(owner.id)).toBe(false);
    // Six more are admitted: the refused one was not counted.
    const text = await documentFor(owner, stateOf(p('text only')));
    for (let n = 0; n < 6; n += 1)
      expect((await archiveOf(await post(text, owner.cookie))).length, `export ${n + 1}`).toBe(1);
  });

  it('is written from the stored state, which the application`s own functions store and load again', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const written = new Y.Doc();
    Y.applyUpdate(written, stateOf(p('stored through the application')));
    expect(await storeState(id, written)).toBe(true);
    expect(await loadState(id)).not.toBeNull();
    const entries = await archiveOf(await post(id, owner.cookie));
    expect(entries[0]!.bytes.toString()).toContain('stored through the application');
  });
});

// ── When it goes wrong ──────────────────────────────────────────────────────

describe('failures (FR-EX-36: "no partial file", "the server aborts the connection")', () => {
  async function withImages(count = 2, size = 40_000) {
    const owner = await person();
    const id = await documentFor(owner);
    const images = [];
    for (let n = 0; n < count; n += 1) images.push(await stored(owner, id, png(size, n + 1)));
    await db().document.update({
      where: { id },
      data: {
        yjsState: Buffer.from(
          stateOf(...images.map((each, n) => image({ id: each.id, alt: `image ${n + 1}` }))),
        ),
      },
    });
    return { owner, id, images };
  }

  it('errors the body, after the Markdown has been sent, where an object cannot be read; and the lock is free', async () => {
    const { owner, id, images } = await withImages();
    storage.faults.set(images[1]!.objectKey, { open: new Error('no such key') });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = await post(id, owner.cookie);
    // The statement of a failure cannot be given once the response has begun: it is a response that does not end in order.
    expect(response.status).toBe(200);
    const { read, error } = await untilError(response);
    expect(error).toBeInstanceOf(Error);
    expect(Buffer.concat(read).subarray(0, 2).toString()).toBe('PK');
    expect(await lockExists(owner.id)).toBe(false);
    expect(storage.open).toBe(0);
    // And the next export is admitted at once.
    storage.faults.clear();
    expect((await archiveOf(await post(id, owner.cookie))).length).toBe(3);
  });

  it('errors the body where an object fails halfway, and where it ends short or runs long of the size its row holds', async () => {
    const { owner, id, images } = await withImages(1, 40_000);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const key = images[0]!.objectKey;
    const faults = {
      'fails halfway': { after: { bytes: 20_000, error: new Error('reset') } },
      'ends short': { endAfter: 39_999 },
      'runs long': { extra: 1 },
    } as const;
    for (const [name, fault] of Object.entries(faults)) {
      storage.faults.set(key, fault);
      const { error } = await untilError(await post(id, owner.cookie));
      expect(error, name).toBeInstanceOf(Error);
      expect(await lockExists(owner.id), name).toBe(false);
      expect(storage.open, name).toBe(0);
    }
    storage.faults.clear();
    expect((await archiveOf(await post(id, owner.cookie))).map((each) => each.name)).toEqual([
      'A document.md',
      'images/001.png',
    ]);
  });

  it('answers a fault before the first byte with the one statement, and says nothing of what failed', async () => {
    const owner = await person();
    const title = 'THE SECRET TITLE';
    const id = await documentFor(owner, stateOf(p('SECRET WORDS')), title);
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.spyOn(db().document, 'findFirst').mockRejectedValueOnce(new Error(`row of ${title}: SECRET WORDS`));
    const response = await post(id, owner.cookie);
    expect(response.status).toBe(500);
    const body = JSON.stringify(await errorOf(response));
    expect(body).not.toMatch(/SECRET|row of/u);
    expect(lines.join('\n')).not.toMatch(/SECRET/u);
    expect(lines.join('\n')).toContain('export: request failed');
    expect(await lockExists(owner.id)).toBe(false);
    // The request that failed was not counted: six more are admitted.
    // (Each is read to its end, which is what lets the next begin: one at a time.)
    for (let n = 0; n < 6; n += 1)
      expect((await archiveOf(await post(id, owner.cookie))).length, `export ${n + 1}`).toBe(1);
    expect((await post(id, owner.cookie)).status).toBe(429);
  });

  it('logs nothing that holds the title or the words of the document, whatever fails', async () => {
    const { owner, id, images } = await withImages();
    await db().document.update({ where: { id }, data: { title: 'TITLE-SENTINEL' } });
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    );
    vi.spyOn(console, 'log').mockImplementation(
      (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    );
    vi.spyOn(console, 'warn').mockImplementation(
      (...args: unknown[]) => void lines.push(args.map(String).join(' ')),
    );
    storage.faults.set(images[0]!.objectKey, { open: new Error('TITLE-SENTINEL image 1') });
    await untilError(await post(id, owner.cookie));
    storage.faults.set(images[0]!.objectKey, { endAfter: 5 });
    await untilError(await post(id, owner.cookie));
    storage.faults.clear();
    const logged = JSON.stringify(await db().securityLogEntry.findMany());
    expect(logged).not.toContain('TITLE-SENTINEL');
    expect(lines.join('\n')).not.toContain('TITLE-SENTINEL');
  });
});

// ── One at a time ───────────────────────────────────────────────────────────

describe('one export at a time for a user (FR-EX-36)', () => {
  it('refuses a second request with a 429 while one is under way, for that user alone, and admits one when it is over', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    const otherId = await documentFor(other, stateOf(p('words')));
    const first = await post(id, owner.cookie);
    expect(first.status).toBe(200);
    const reader = first.body!.getReader();
    await reader.read();
    // Under way: the same user, on this document or any other, is refused.
    const second = await post(id, owner.cookie);
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/u);
    expect((await errorOf(second)).code).toBe('export_in_progress');
    const elsewhere = await documentFor(owner, stateOf(p('x')));
    expect((await post(elsewhere, owner.cookie)).status).toBe(429);
    // Another user is not.
    expect((await post(otherId, other.cookie)).status).toBe(200);
    // Over: the first is read to its end.
    while (!(await reader.read()).done);
    await sleep(20);
    expect(await lockExists(owner.id)).toBe(false);
    expect((await archiveOf(await post(id, owner.cookie))).length).toBe(1);
  });

  it('counts a refusal by the lock for nothing', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    const first = await post(id, owner.cookie);
    const reader = first.body!.getReader();
    await reader.read();
    for (let n = 0; n < 10; n += 1) expect((await post(id, owner.cookie)).status).toBe(429);
    while (!(await reader.read()).done);
    await sleep(20);
    // The limit is 6 in the hour and one was spent: five more, and then the limit.
    for (let n = 0; n < 5; n += 1)
      expect((await archiveOf(await post(id, owner.cookie))).length, `export ${n + 2}`).toBe(1);
    const over = await post(id, owner.cookie);
    expect(over.status).toBe(429);
    expect((await errorOf(over)).code).toBe('rate_limited');
  });

  it('releases the lock however the export ends', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    const held = () => lockExists(owner.id);

    // The last byte.
    expect((await archiveOf(await post(id, owner.cookie))).length).toBe(1);
    await sleep(20);
    expect(await held(), 'the last byte').toBe(false);

    // A cancel by the client.
    const cancelled = await post(id, owner.cookie);
    const reader = cancelled.body!.getReader();
    await reader.read();
    expect(await held(), 'under way').toBe(true);
    await reader.cancel();
    await sleep(20);
    expect(await held(), 'a cancel').toBe(false);

    // A client that never reads: the idle period (1 second here) ends it.
    const stalled = await post(id, owner.cookie);
    expect(stalled.status).toBe(200);
    expect(await held(), 'a stalled client, at first').toBe(true);
    await sleep(1400);
    expect(await held(), 'a stalled client, after the idle period').toBe(false);
    await expect(stalled.body!.getReader().read()).rejects.toThrow();
    // The next is admitted at once.
    expect((await post(id, owner.cookie)).status).toBe(200);
  });

  it('releases the lock where the limit refuses, and where the document is gone', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    for (let n = 0; n < 6; n += 1) await archiveOf(await post(id, owner.cookie));
    const over = await post(id, owner.cookie);
    expect(over.status).toBe(429);
    expect((await errorOf(over)).code).toBe('rate_limited');
    expect(over.headers.get('retry-after')).toMatch(/^[1-9][0-9]*$/u);
    expect(await lockExists(owner.id)).toBe(false);
  });

  it('holds a key that expires, so that a holder that dies does not hold it for ever, and that no other holder can release', async () => {
    const user = (await person()).id;
    const first = await takeExportLock(user, 400);
    expect(first).not.toBeNull();
    expect(await takeExportLock(user, 400)).toBeNull();
    const ttl = await valkey().pttl(`export-lock:${user}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(400);
    // The holder dies without releasing: the key goes by itself.
    await sleep(500);
    const second = await takeExportLock(user, 5000);
    expect(second).not.toBeNull();
    // The first holder, long gone, cannot release or renew what is now the second's.
    await first!.release();
    expect(await first!.renew()).toBe(false);
    expect(await valkey().exists(`export-lock:${user}`)).toBe(1);
    expect(await takeExportLock(user, 5000)).toBeNull();
    await second!.release();
    expect(await valkey().exists(`export-lock:${user}`)).toBe(0);
    // A renewal extends it for the holder.
    const third = (await takeExportLock(user, 300))!;
    await sleep(200);
    expect(await third.renew()).toBe(true);
    await sleep(200);
    expect(await takeExportLock(user, 300)).toBeNull();
    await third.release();
  });

  it('refuses the request where Valkey cannot be asked, and does not admit it', async () => {
    const owner = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(valkey(), 'set').mockRejectedValueOnce(new Error('connection lost'));
    const response = await post(id, owner.cookie);
    expect(response.status).toBe(500);
    expect(storage.reads).toEqual([]);
  });
});

describe('the limit (NFR-SE-07: draft exports started, 10 in any hour; 6 here)', () => {
  it('answers the seventh in the hour with a 429 that says when to try again, and processes nothing', async () => {
    const owner = await person();
    const other = await person();
    const id = await documentFor(owner, stateOf(p('words')));
    for (let n = 0; n < 6; n += 1) expect((await archiveOf(await post(id, owner.cookie))).length).toBe(1);
    const over = await post(id, owner.cookie);
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    const { message } = await errorOf(over);
    expect(message).toMatch(/Try again in \d+ minutes?\./u);
    // For that user alone.
    const otherId = await documentFor(other, stateOf(p('words')));
    expect((await post(otherId, other.cookie)).status).toBe(200);
    // The refusal is in the security log, once for the period, with the user.
    const entries = await db().securityLogEntry.findMany({
      where: { userId: owner.id, kind: 'rate_limit_reached' },
    });
    expect(entries).toHaveLength(1);
  });
});

// ── A client that stalls, on a real socket ──────────────────────────────────

describe('a client that stops reading (FR-EX-36: "a response that has sent nothing for 30 seconds is aborted")', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
  });

  /** The response written to a socket as Next.js writes one: a stream piped to the response, a write that waits for the drain, an error that destroys the connection. */
  function serve(handler: () => Promise<Response>) {
    let closed!: (how: { at: number; finished: boolean }) => void;
    const serverClosed = new Promise<{ at: number; finished: boolean }>((resolve) => (closed = resolve));
    server = createServer((_, res) => {
      res.once('close', () => closed({ at: Date.now(), finished: res.writableFinished }));
      void (async () => {
        const response = await handler();
        res.writeHead(response.status, Object.fromEntries(response.headers));
        const writer = new WritableStream<Uint8Array>({
          write: async (chunk) => {
            if (!res.write(chunk)) await once(res, 'drain');
          },
          abort: (error) => void res.destroy(error as Error),
          close: () => void res.end(),
        });
        await response.body!.pipeTo(writer).catch(() => undefined);
      })();
    });
    return new Promise<{ port: number; serverClosed: typeof serverClosed }>((resolve) =>
      server!.listen(0, '127.0.0.1', () =>
        resolve({ port: (server!.address() as { port: number }).port, serverClosed }),
      ),
    );
  }

  it('releases the lock and the read of the store at the idle period, with a client that has taken the headers and nothing more; and gives it no whole file when it reads on', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const big = await stored(owner, id, png(12 * 1024 * 1024, 4));
    await db().document.update({
      where: { id },
      data: { yjsState: Buffer.from(stateOf(image({ id: big.id, alt: 'big' }))) },
    });
    const { port, serverClosed } = await serve(() => post(id, owner.cookie));
    const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/' });
    let received = 0;
    let stalled: IncomingMessage | undefined;
    let aborted = false;
    request.on('response', (response) => {
      stalled = response;
      // Takes nothing: the socket's buffers fill and the server waits for a drain that does not come.
      response.pause();
      response.on('data', (chunk: Buffer) => (received += chunk.length));
      response.on('aborted', () => (aborted = true));
      response.on('error', () => (aborted = true));
    });
    request.on('error', () => (aborted = true));
    request.end();
    const started = Date.now();
    await sleep(300);
    expect(await lockExists(owner.id), 'under way').toBe(true);
    expect(storage.open, 'a read of the store is open').toBe(1);
    // After the idle period (1 second here) it holds nothing: not the lock, not the read of the store.
    await sleep(1500);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await lockExists(owner.id), 'after the idle period').toBe(false);
    expect(storage.open, 'after the idle period').toBe(0);
    // And the next export is admitted at once.
    expect((await archiveOf(await post(id, owner.cookie))).length).toBe(2);
    // The socket of a client that is connected and does not read is the writer's to close, which waits for it to
    // drain (register row S21-9): when the client reads on, the response ends as a failure and not as a file.
    stalled!.resume();
    const how = await Promise.race([serverClosed, sleep(10_000).then(() => 'still open' as const)]);
    expect(how).not.toBe('still open');
    expect((how as { finished: boolean }).finished).toBe(false);
    await expect.poll(() => aborted, { timeout: 5000 }).toBe(true);
    expect(received).toBeLessThan(12 * 1024 * 1024);
    request.destroy();
  });

  it('completes for a client that reads, slowly: progress is not idleness', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const middling = await stored(owner, id, png(600_000, 8));
    await db().document.update({
      where: { id },
      data: { yjsState: Buffer.from(stateOf(image({ id: middling.id, alt: 'm' }))) },
    });
    const { port } = await serve(() => post(id, owner.cookie));
    const total = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (response) => {
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          response.pause();
          setTimeout(() => response.resume(), 20);
        });
        response.on('end', () => resolve(bytes));
        response.on('error', reject);
      });
      request.on('error', reject);
      request.end();
    });
    expect(total).toBeGreaterThan(600_000);
  });
});

// ── Bounded memory ──────────────────────────────────────────────────────────

describe('bounded memory (FR-EX-36: "the application keeps no copy")', () => {
  it('reads an image as the client takes it: the store is asked for no more than a few chunks ahead of the reader', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const big = await stored(owner, id, png(8 * 1024 * 1024, 3));
    await db().document.update({
      where: { id },
      data: { yjsState: Buffer.from(stateOf(image({ id: big.id, alt: 'big' }))) },
    });
    const response = await post(id, owner.cookie);
    const reader = response.body!.getReader();
    let taken = 0;
    // The Markdown first, then the image: a few chunks are read, with a pause for a reader that is slow.
    for (let n = 0; n < 10; n += 1) taken += (await reader.read()).value!.length;
    await sleep(200);
    // Whatever the reader has taken, the store has handed out about that and a few chunks more, and not the 8 MB.
    expect(storage.pulled).toBeLessThan(taken + 8 * 64 * 1024);
    expect(storage.pulled).toBeLessThan((8 * 1024 * 1024) / 4);
    await reader.cancel();
    await sleep(50);
    expect(storage.open).toBe(0);
  });

  it('keeps no file: the code of the export writes to no file and puts nothing in the store', () => {
    for (const file of ['draft.ts', 'stream.ts', 'zip.ts', 'markdown.ts', 'read.ts', 'lock.ts', 'name.ts']) {
      const source = readFileSync(new URL(`../../src/lib/export/${file}`, import.meta.url), 'utf8');
      expect(source, file).not.toMatch(
        /node:fs|node:os|writeFile|createWriteStream|tmpdir|\.put\(|\.remove\(|PutObject|DeleteObject/u,
      );
    }
    const route = readFileSync(
      new URL('../../src/app/api/documents/[id]/export/draft/route.ts', import.meta.url),
      'utf8',
    );
    expect(route).not.toMatch(/node:fs/u);
  });
});

// ── Unicode, and the reference document ─────────────────────────────────────

const SCRIPTS = {
  'accented Latin': 'Café naïve façade — Ångström, Łódź, Ñandú, ÀÉÎÕÜ',
  Greek: 'Εκδοτικό — Ελληνικά, άέήίόύώ, Ωμέγα',
  CJK: '論文 論文集 日本語のテキスト 中文文本 한국어 텍스트',
  Arabic: 'مرحبا بالعالم — النص العربي',
  'emoji outside the Basic Multilingual Plane': '📚 🙂 👩‍💻 🇬🇷 🧪',
} as const;

describe('Unicode (NFR-I18-03, NFR-I18-04: written, reloaded, exported, every code point found)', () => {
  it('finds every code point of every script in a title, a paragraph, a caption and a footnote', async () => {
    const owner = await person();
    const id = await documentFor(owner);
    const everything = Object.values(SCRIPTS).join(' | ');
    const noteId = 'e'.repeat(24);
    // Written as the editor writes it, through the binding; stored by the application's own function.
    const json = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: everything },
            { type: 'footnoteReference', attrs: { id: noteId } },
          ],
        },
        { type: 'image', attrs: { id: null, alt: everything, caption: everything } },
        {
          type: 'footnotes',
          content: [
            { type: 'footnote', attrs: { id: noteId }, content: [{ type: 'text', text: everything }] },
          ],
        },
      ],
    };
    const written = new Y.Doc();
    Y.applyUpdate(written, editorState(json));
    expect(await storeState(id, written)).toBe(true);
    await db().document.update({ where: { id }, data: { title: everything.slice(0, 190) } });
    // Reloaded, exported.
    const response = await post(id, owner.cookie);
    const file = readZip(await collect(response.body!))[0]!.bytes.toString('utf8');
    const front = file.slice(4, file.indexOf('\n---\n', 4));
    const { load: parse } = await import('js-yaml');
    const parsed = parse(front) as { title: string };
    expect(parsed.title).toBe(everything.slice(0, 190));
    // The body is the text, escaped where Markdown reads syntax: the code points are all there, and none is anything else.
    const body = file.slice(file.indexOf('> Draft export'));
    for (const [script, sample] of Object.entries(SCRIPTS)) {
      for (const codePoint of new Set(Array.from(sample))) {
        if (/[\s|—,]/u.test(codePoint)) continue;
        // In the paragraph, the caption, the alt text and the footnote: four times at least.
        const count = Array.from(body).filter((each) => each === codePoint).length;
        expect(
          count,
          `${script}: U+${codePoint.codePointAt(0)!.toString(16).toUpperCase()} (${codePoint})`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
    // And the title in the name of the download.
    expect(response.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    expect(Buffer.from(file, 'utf8').toString('utf8')).toBe(file);
  });
});

describe('the reference document (NFR-PE-01, NFR-IC-14: 5,000 words, no image)', () => {
  it('is exported in a fraction of the 10 seconds of its budget', async () => {
    const owner = await person();
    const words = [
      'alpha',
      'beta',
      'gamma',
      'delta',
      'epsilon',
      'zeta',
      'eta',
      'theta',
      'iota',
      'kappa',
      'lambda',
      'mu',
    ];
    const sentence = (seed: number) =>
      Array.from({ length: 24 }, (_, n) => words[(seed * 7 + n * 3) % words.length]).join(' ');
    const blocks: (Y.XmlElement | Y.XmlText)[] = [];
    const ids: string[] = [];
    for (let section = 0; section < 12; section += 1) {
      blocks.push(heading(2, `Section ${section + 1}`));
      for (let n = 0; n < 8; n += 1) {
        const marker =
          (section * 8 + n) % 3 === 0 ? [note(`${(section * 8 + n).toString(16).padStart(24, '0')}`)] : [];
        if (marker.length) ids.push(`${(section * 8 + n).toString(16).padStart(24, '0')}`);
        blocks.push(
          p(
            sentence(section * 8 + n),
            tx(' emphasised', { bold: {}, italic: {} }),
            ...marker,
            br(),
            sentence(n),
          ),
        );
      }
      blocks.push(bullets(item(p(sentence(1))), item(p(sentence(2)))));
      blocks.push(table('Table', row(cell({}, p('a')), cell({}, p(sentence(3))))));
    }
    blocks.push(notes(...ids.map((each) => entry(each, sentence(5)))));
    blocks.push(el('horizontalRule'));
    const id = await documentFor(owner, stateOf(...blocks));
    const started = performance.now();
    const response = await post(id, owner.cookie);
    const entries = readZip(await collect(response.body!));
    const took = performance.now() - started;
    const markdown = entries[0]!.bytes.toString();
    expect(markdown.split(/\s+/u).length).toBeGreaterThan(5000);
    expect(took).toBeLessThan(10_000);
    // Printed for the record of the pull request; the budget is 10 seconds.
    process.stdout.write(
      `reference document: ${markdown.split(/\s+/u).length} words exported in ${Math.round(took)} ms\n`,
    );
  });
});

void bodyOf;
void NOW;
