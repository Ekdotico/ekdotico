// Reading a document that was deleted before a clearing, by the people who held a role on it (FR-AU-91, FR-ED-36;
// register row S23-1, answered "view" by the owner on 26 October 2026; docs/plan/slice-23.md): while the notice
// period runs (the day ahead, and no timer has claimed the document) they may OPEN it, read-only, and nothing else
// of it; after the day, once claimed, or once the clearing is cancelled for it, it is the page that every document
// that is not there leads to. The Owner's view is unchanged. The open connection is in collab-clearing.test.ts.
// Each test of a rule names the weakening that makes it fail (the mutations of the pull request).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DAY_MS, json, MAIL, world } from './clearing.ts';
import { MemoryStorage } from './image-storage.ts';
import { load, PASSWORD, prepare } from './identity.ts';

const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));
// `headers` of Next.js exists only inside a request of the framework: the pages are called with what this says
// the browser sent.
const browser = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => browser.headers }));

const database = prepare('clearingview', { EMAIL_SINK_DIRECTORY: MAIL });
const loaded = await load();
const { db, valkey } = loaded;
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { useImageStorage } = await import('../../src/lib/images/store.ts');
const { countScope } = await import('../../src/lib/clearing/clearing.ts');
const { authorise } = await import('../../src/lib/documents/access.ts');
const { PERMISSIONS } = await import('../../src/lib/documents/permissions.ts');
const { acknowledgeNotice, CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/onboarding.ts');
const clearRoute = await import('../../src/app/api/account/documents/clear/route.ts');
const oneRoute = await import('../../src/app/api/account/documents/clear/[documentId]/route.ts');
const { default: DocumentPage } = await import('../../src/app/(app)/documents/[id]/page.tsx');
const { default: SharingPage } = await import('../../src/app/(app)/documents/[id]/sharing/page.tsx');
const { DocumentView } = await import('../../src/app/(app)/documents/[id]/document-view.tsx');

const w = world(loaded, { createDocument, clearRoute, oneRoute, useImageStorage });
const { person, documentOf, share, deletedAgo, clear, cancelOne, row, image } = w;

let storage: MemoryStorage;
beforeEach(async () => {
  // A run of the timer carries out every open clearing: one that an earlier test left open is not this test's.
  await db().documentClearing.updateMany({
    where: { completedAt: null },
    data: { completedAt: new Date(Date.now() + 365 * DAY_MS) },
  });
  later.length = 0;
  storage = new MemoryStorage();
  useImageStorage(storage);
});
afterEach(() => {
  vi.restoreAllMocks();
  browser.headers = new Headers();
});
afterAll(async () => {
  useImageStorage(undefined);
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

const context = (id: string, extra: Record<string, string> = {}) => ({
  params: Promise.resolve({ id, ...extra }),
});

/**
 * A document that its Owner deleted a day ago, with an Editor, a Reviewer and a Viewer, and a clearing of the
 * Owner's documents that treats it as shared (FR-AU-91): in its notice period.
 */
async function deletedThenCleared() {
  const owner = await person();
  const editor = await person('editor');
  const reviewer = await person('reviewer');
  const viewer = await person('viewer');
  const stranger = await person('stranger');
  // The pages of an account that has not acknowledged the notice of the Closed α show nothing (FR-AU-55).
  for (const who of [owner, editor, reviewer, viewer, stranger]) {
    await acknowledgeNotice(who.id, CLOSED_ALPHA_NOTICE_VERSION);
  }
  const id = await documentOf(owner.id, 'Deleted, then cleared');
  await share(id, editor.id, 'EDITOR');
  await share(id, reviewer.id, 'REVIEWER');
  await share(id, viewer.id, 'VIEWER');
  await deletedAgo(id, owner.id, DAY_MS);
  const response = await clear(owner.cookie, {
    scope: 'all',
    documentIds: (await countScope(owner.id, 'all')).documentIds,
    password: PASSWORD,
  });
  expect(response.status).toBe(200);
  return { owner, editor, reviewer, viewer, stranger, id, day: (await row(id))!.clearingAt! };
}

const outcomeOf = async (userId: string, id: string, now?: Date) =>
  (await authorise(userId, id, 'document.view', now)).outcome;

describe('the former collaborators read the document during the period (S23-1)', () => {
  // Mutation V01: `authorise` finds no document that is deleted for `document.view`, whatever the period.
  it('opens it to each role that was held on it, to read', async () => {
    const { editor, reviewer, viewer, id } = await deletedThenCleared();
    for (const who of [editor, reviewer, viewer]) {
      const access = await authorise(who.id, id, 'document.view');
      expect(access.outcome, who.email).toBe('allowed');
    }
    // The routes that read answer too: the document's summary and the link to an image of it.
    const one = await import('../../src/app/api/documents/[id]/route.ts');
    const response = await one.GET(w.request('GET', `/api/documents/${id}`, viewer.cookie), context(id));
    expect(response.status).toBe(200);
    expect((await json(response)).title).toBe('Deleted, then cleared');
  });

  // Mutation V02: the link to an image is refused for such a document, or issued for an image of another document.
  it('issues the link to an image of that document, and to no other document’s image', async () => {
    const { owner, viewer, id } = await deletedThenCleared();
    const link = await import('../../src/app/api/documents/[id]/images/[imageId]/route.ts');
    const key = await image(id, storage, owner.id);
    const mine = await db().documentImage.findFirstOrThrow({ where: { objectKey: key } });
    const other = await documentOf(owner.id);
    const otherKey = await image(other, storage, owner.id);
    const theirs = await db().documentImage.findFirstOrThrow({ where: { objectKey: otherKey } });
    const ask = (imageId: string) =>
      link.GET(
        w.request('GET', `/api/documents/${id}/images/${imageId}`, viewer.cookie),
        context(id, { imageId }),
      );
    const ok = await ask(mine.id);
    expect(ok.status).toBe(200);
    expect(typeof (await json(ok)).url).toBe('string');
    expect((await ask(theirs.id)).status).toBe(404);
  });

  // Mutation V03: the page is not opened for `document.view` of such a document; or it is opened editable (canEdit).
  it('opens its page read-only, with the day, as for a document in a clearing', async () => {
    const { editor, id, day } = await deletedThenCleared();
    browser.headers = new Headers({ cookie: editor.cookie });
    const shown = await DocumentPage({ params: Promise.resolve({ id }) });
    const view = find(shown, DocumentView);
    expect(view).toBeDefined();
    // An Editor holds the right to edit; the period takes it, and the page is told the day (FR-AU-91).
    expect(view!.props).toMatchObject({
      documentId: id,
      canEdit: false,
      deletedOn: day.toISOString(),
      alreadyDeleted: true,
    });
  });

  // Mutation V17: the page tells the editor that a document in a clearing was deleted already, whether or not it was
  // (the statement then says "was deleted by its Owner" of a live document), or never tells it of one that was.
  it('has the editor say "will be deleted" of a live document in a clearing, and "was deleted" of one that was', async () => {
    const owner = await person();
    const reader = await person('reader');
    for (const who of [owner, reader]) await acknowledgeNotice(who.id, CLOSED_ALPHA_NOTICE_VERSION);
    const live = await documentOf(owner.id, 'Live and cleared');
    await share(live, reader.id, 'VIEWER');
    const cleared = await clear(owner.cookie, {
      scope: 'all',
      documentIds: (await countScope(owner.id, 'all')).documentIds,
      password: PASSWORD,
    });
    expect(cleared.status).toBe(200);
    browser.headers = new Headers({ cookie: reader.cookie });
    const shown = await DocumentPage({ params: Promise.resolve({ id: live }) });
    expect(find(shown, DocumentView)!.props).toMatchObject({ alreadyDeleted: false });
    expect(find(shown, DocumentView)!.props.deletedOn).toEqual(expect.any(String));
  });

  // Mutation V04: the exception is kept for the Owner as well.
  it('leaves the Owner’s view as it was: a deleted document is no page to the Owner, who meets it in the list of deleted documents', async () => {
    const { owner, id } = await deletedThenCleared();
    expect(await outcomeOf(owner.id, id)).toBe('not_found');
    browser.headers = new Headers({ cookie: owner.cookie });
    await expect(DocumentPage({ params: Promise.resolve({ id }) })).rejects.toMatchObject({
      digest: expect.stringContaining('404'),
    });
  });

  // Mutation V05: the exception does not ask for a role (any signed-in account may read).
  it('gives a person who never held a role the 404 of a document that is not there', async () => {
    const { stranger, id } = await deletedThenCleared();
    expect(await outcomeOf(stranger.id, id)).toBe('not_found');
    browser.headers = new Headers({ cookie: stranger.cookie });
    await expect(DocumentPage({ params: Promise.resolve({ id }) })).rejects.toMatchObject({
      digest: expect.stringContaining('404'),
    });
    const one = await import('../../src/app/api/documents/[id]/route.ts');
    const response = await one.GET(w.request('GET', `/api/documents/${id}`, stranger.cookie), context(id));
    expect(response.status).toBe(404);
  });

  // Mutation V05: as above; a role that is gone is no role (the exception reads the rows of the collaborators as they are).
  it('gives a person whose role was removed, or who left, before the document was deleted, the 404', async () => {
    const owner = await person();
    const [keeper, removed, leaver] = [
      await person('keeper'),
      await person('removed'),
      await person('leaver'),
    ];
    for (const who of [owner, keeper, removed, leaver])
      await acknowledgeNotice(who.id, CLOSED_ALPHA_NOTICE_VERSION);
    const id = await documentOf(owner.id, 'Some left');
    await share(id, keeper.id, 'VIEWER');
    const removedRow = await share(id, removed.id, 'EDITOR');
    await share(id, leaver.id, 'VIEWER');
    // Through the real routes, as a person does it.
    const collaborators =
      await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
    const leave = await import('../../src/app/api/documents/[id]/leave/route.ts');
    const takenOut = await collaborators.DELETE(
      w.request('DELETE', `/api/documents/${id}/collaborators/${removedRow.id}`, owner.cookie),
      context(id, { collaboratorId: removedRow.id }),
    );
    expect(takenOut.status).toBe(200);
    const left = await leave.POST(
      w.request('POST', `/api/documents/${id}/leave`, leaver.cookie),
      context(id),
    );
    expect(left.status).toBe(204);
    await deletedAgo(id, owner.id, DAY_MS);
    const cleared = await clear(owner.cookie, {
      scope: 'all',
      documentIds: (await countScope(owner.id, 'all')).documentIds,
      password: PASSWORD,
    });
    expect(cleared.status).toBe(200);
    // The one who stayed reads it; the two who are gone get the page of a document that is not there.
    expect(await outcomeOf(keeper.id, id)).toBe('allowed');
    for (const gone of [removed, leaver]) {
      expect(await outcomeOf(gone.id, id), gone.email).toBe('not_found');
      browser.headers = new Headers({ cookie: gone.cookie });
      await expect(DocumentPage({ params: Promise.resolve({ id }) })).rejects.toMatchObject({
        digest: expect.stringContaining('404'),
      });
    }
  });

  // Mutation V08: the page of the sharing settings opens for a deleted document.
  it('opens no page of settings for it', async () => {
    const { viewer, id } = await deletedThenCleared();
    browser.headers = new Headers({ cookie: viewer.cookie });
    await expect(SharingPage({ params: Promise.resolve({ id }) })).rejects.toMatchObject({
      digest: expect.stringContaining('404'),
    });
  });
});

describe('and read it, and nothing else of it', () => {
  // Mutation V06: the exception holds for every permission (the condition on `document.view` is dropped).
  it('grants no other permission than the reading and the draft export, to any role', async () => {
    const { owner, editor, reviewer, viewer, id } = await deletedThenCleared();
    for (const who of [editor, reviewer, viewer, owner]) {
      for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
        if (permission === 'document.view' || permission === 'document.export.draft') continue;
        const outcome = (await authorise(who.id, id, permission)).outcome;
        expect(outcome, `${who.email} ${permission}`).toBe('not_found');
      }
    }
  });

  // Mutation V07: a route that writes opens for a former collaborator (the handler is reached).
  it('opens no route that writes, to an Editor of the document that was', async () => {
    const { editor, id } = await deletedThenCleared();
    const before = await row(id);
    const r = {
      one: await import('../../src/app/api/documents/[id]/route.ts'),
      restoring: await import('../../src/app/api/documents/[id]/restore/route.ts'),
      invitations: await import('../../src/app/api/documents/[id]/invitations/route.ts'),
      leave: await import('../../src/app/api/documents/[id]/leave/route.ts'),
      permissions: await import('../../src/app/api/documents/[id]/permissions/route.ts'),
      images: await import('../../src/app/api/documents/[id]/images/route.ts'),
    };
    const png = (cookie: string) =>
      new Request(`https://app.example.test/api/documents/${id}/images`, {
        method: 'POST',
        headers: { origin: 'https://app.example.test', cookie, 'content-type': 'image/png' },
        body: new Uint8Array([137, 80, 78, 71]),
      });
    const refused = [
      await r.one.PATCH(
        w.request('PATCH', `/api/documents/${id}`, editor.cookie, { title: 'Another' }),
        context(id),
      ),
      await r.one.DELETE(w.request('DELETE', `/api/documents/${id}`, editor.cookie), context(id)),
      await r.restoring.POST(w.request('POST', `/api/documents/${id}/restore`, editor.cookie), context(id)),
      await r.invitations.POST(
        w.request('POST', `/api/documents/${id}/invitations`, editor.cookie, {
          emails: ['someone@example.com'],
          role: 'viewer',
        }),
        context(id),
      ),
      await r.leave.POST(w.request('POST', `/api/documents/${id}/leave`, editor.cookie), context(id)),
      await r.permissions.PUT(
        w.request('PUT', `/api/documents/${id}/permissions`, editor.cookie, { defaults: true }),
        context(id),
      ),
      await r.images.POST(png(editor.cookie), context(id)),
    ];
    for (const response of refused) expect(response.status).toBe(404);
    const after = await row(id);
    expect({ ...after, updatedAt: null }).toEqual({ ...before, updatedAt: null });
    expect(await db().documentInvitation.count({ where: { documentId: id } })).toBe(0);
    expect(await db().documentImage.count({ where: { documentId: id } })).toBe(0);
    expect(await db().documentCollaborator.count({ where: { documentId: id, userId: editor.id } })).toBe(1);
  });
});

describe('only while the notice period runs', () => {
  // Mutation V09: the day is not asked (`noticeRuns` is replaced by a test of `clearingAt` alone).
  it('is not read after the day, to the second', async () => {
    const { viewer, id, day } = await deletedThenCleared();
    expect(await outcomeOf(viewer.id, id, new Date(day.getTime() - 1))).toBe('allowed');
    expect(await outcomeOf(viewer.id, id, day)).toBe('not_found');
    expect(await outcomeOf(viewer.id, id, new Date(day.getTime() + 1))).toBe('not_found');
    // And through the page, with the day passed on the row itself.
    await db().document.update({ where: { id }, data: { clearingAt: new Date(Date.now() - 1000) } });
    browser.headers = new Headers({ cookie: viewer.cookie });
    await expect(DocumentPage({ params: Promise.resolve({ id }) })).rejects.toMatchObject({
      digest: expect.stringContaining('404'),
    });
  });

  // Mutation V10: the claim is not asked (a document that the timer has claimed is still read).
  it('is not read once the timer has claimed it', async () => {
    const { viewer, id } = await deletedThenCleared();
    expect(await outcomeOf(viewer.id, id)).toBe('allowed');
    await db().document.update({ where: { id }, data: { deletionClaimedAt: new Date() } });
    expect(await outcomeOf(viewer.id, id)).toBe('not_found');
    browser.headers = new Headers({ cookie: viewer.cookie });
    await expect(DocumentPage({ params: Promise.resolve({ id }) })).rejects.toMatchObject({
      digest: expect.stringContaining('404'),
    });
  });

  // Mutation V11: the exception asks for a deleted document and not for the clearing (any deleted document is read).
  it('is not read where the document is deleted and in no clearing, nor once the clearing is cancelled for it', async () => {
    const { owner, viewer, id } = await deletedThenCleared();
    const plain = await documentOf(owner.id);
    await share(plain, viewer.id, 'VIEWER');
    await deletedAgo(plain, owner.id, DAY_MS);
    expect(await outcomeOf(viewer.id, plain)).toBe('not_found');
    expect(await outcomeOf(viewer.id, id)).toBe('allowed');
    const cancelled = await cancelOne(owner.cookie, id);
    expect(cancelled.status).toBe(200);
    expect((await row(id))?.clearingAt).toBeNull();
    expect(await outcomeOf(viewer.id, id)).toBe('not_found');
  });
});

describe('a clearing takes a deleted document only within its retention (FR-AU-91)', () => {
  const retentionMs = () => loaded.settings().deletedDocumentRetentionDays * DAY_MS;

  // Mutation V18: `countScope` or the locked statement of the confirmation leaves the retention out of the scope (for 'all' or for 'deleted').
  it.each(['all', 'deleted'] as const)(
    'leaves out a deleted document whose retention has ended, and one the timer has claimed, so that no one reads either in a period (scope %s)',
    async (scope) => {
      const owner = await person();
      const reader = await person('reader');
      const within = await documentOf(owner.id, 'Within');
      const past = await documentOf(owner.id, 'Past');
      const claimed = await documentOf(owner.id, 'Claimed');
      for (const id of [within, past, claimed]) await share(id, reader.id, 'VIEWER');
      await deletedAgo(within, owner.id, retentionMs() - DAY_MS);
      await deletedAgo(past, owner.id, retentionMs() + DAY_MS);
      await deletedAgo(claimed, owner.id, DAY_MS);
      await db().document.update({ where: { id: claimed }, data: { deletionClaimedAt: new Date() } });

      expect((await countScope(owner.id, scope)).documentIds).toEqual([within]);
      // A request that still names the others is not the documents the account has: the confirmation says so, and does nothing.
      const stale = await clear(owner.cookie, {
        scope,
        documentIds: [within, past, claimed].sort(),
        password: PASSWORD,
      });
      expect(stale.status).toBe(409);
      expect(
        await db().document.count({
          where: { id: { in: [within, past, claimed] }, clearingAt: { not: null } },
        }),
      ).toBe(0);
      const done = await clear(owner.cookie, { scope, documentIds: [within], password: PASSWORD });
      expect(done.status).toBe(200);
      // Only the one within its retention is in a period, and its collaborator reads it; the others are not read.
      expect((await row(within))?.clearingAt).not.toBeNull();
      expect(await outcomeOf(reader.id, within)).toBe('allowed');
      expect((await row(past))?.clearingAt).toBeNull();
      expect((await row(claimed))?.clearingAt).toBeNull();
      expect(await outcomeOf(reader.id, past)).toBe('not_found');
      expect(await outcomeOf(reader.id, claimed)).toBe('not_found');
    },
  );
});

describe('a live document keeps its rules', () => {
  // Mutation V12: the exception reaches a live document (a stranger, a removed role) or changes what a role holds on it.
  it('is read by its roles, refused to a stranger, and its permissions are as they were', async () => {
    const owner = await person();
    const viewer = await person('viewer');
    const stranger = await person('stranger');
    const id = await documentOf(owner.id);
    await share(id, viewer.id, 'VIEWER');
    expect(await outcomeOf(owner.id, id)).toBe('allowed');
    expect(await outcomeOf(viewer.id, id)).toBe('allowed');
    expect(await outcomeOf(stranger.id, id)).toBe('not_found');
    expect((await authorise(viewer.id, id, 'document.content.edit')).outcome).toBe('forbidden');
    expect((await authorise(viewer.id, id, 'document.export.draft')).outcome).toBe('forbidden');
    // A deleted document that is in no clearing: no one reads it, the Owner included (FR-ED-36).
    await deletedAgo(id, owner.id, DAY_MS);
    expect(await outcomeOf(owner.id, id)).toBe('not_found');
    expect(await outcomeOf(viewer.id, id)).toBe('not_found');
  });
});

/** The first element of this type in what a page returned, depth first. */
function find(node: unknown, type: unknown): { props: Record<string, unknown> } | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = find(child, type);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node !== 'object' || node === null || !('props' in node)) return undefined;
  const element = node as { type: unknown; props: Record<string, unknown> };
  if (element.type === type) return element;
  return find(element.props.children, type);
}
