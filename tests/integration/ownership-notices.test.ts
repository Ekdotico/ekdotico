// Two follow-ups to the transfer of ownership (FR-ED-47, FR-ED-42; NFR-SE-07,
// NFR-SE-19), decided by the owner as S17-7 and S17-5: a limit on the offers an
// Owner makes in an hour, and the Owner's notification when an offer ends
// without the Owner's own action. The routes as Next.js calls them, against a
// provisioned database and the real Valkey. Each test of a security rule names
// the weakening that makes it fail.
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { until } from './channel.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));

const MAIL = join(tmpdir(), `ekdotico-ownership-notices-mail-${randomUUID()}`);
// Three offers an hour: the limit is the same mechanism as the invitations', at a figure a test can reach.
const database = prepare('ownershipnotices', {
  EMAIL_SINK_DIRECTORY: MAIL,
  RATE_LIMIT_OFFERS_PER_USER: '3/3600',
  RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600',
});
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { deleteDocument, restoreDocument } = await import('../../src/lib/documents/deletion.ts');
const { deleteAccessNotificationsOf, deleteExpiredRemovedNotifications } =
  await import('../../src/lib/documents/access-notifications.ts');
const { expireOffers } = await import('../../src/lib/documents/ownership.ts');
const { notifyOfferEnded } = await import('../../src/lib/documents/ownership-notifications.ts');
const offering = await import('../../src/app/api/documents/[id]/ownership-offer/route.ts');
const answering = await import('../../src/app/api/ownership-offers/[offerId]/[answer]/route.ts');
const one = await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
const leaving = await import('../../src/app/api/documents/[id]/leave/route.ts');
const notifications = await import('../../src/app/api/notifications/route.ts');
const notification = await import('../../src/app/api/notifications/[id]/route.ts');
const inviting = await import('../../src/app/api/documents/[id]/invitations/route.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
afterEach(() => {
  vi.restoreAllMocks();
  later.length = 0;
});

const request = (method: string, path: string, cookie: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { origin: ORIGIN }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

const offer = (cookie: string, id: string, collaboratorId: unknown) =>
  offering.POST(
    request('POST', `/api/documents/${id}/ownership-offer`, cookie, { collaboratorId }),
    at({ id }),
  );
const withdraw = (cookie: string, id: string) =>
  offering.DELETE(request('DELETE', `/api/documents/${id}/ownership-offer`, cookie), at({ id }));
const answer = (cookie: string, offerId: string, chosen: string) =>
  answering.POST(
    request('POST', `/api/ownership-offers/${offerId}/${chosen}`, cookie),
    at({ offerId, answer: chosen }),
  );
const removal = (cookie: string, id: string, collaboratorId: string) =>
  one.DELETE(
    request('DELETE', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie),
    at({ id, collaboratorId }),
  );
const changeRole = (cookie: string, id: string, collaboratorId: string, role: string) =>
  one.PATCH(
    request('PATCH', `/api/documents/${id}/collaborators/${collaboratorId}`, cookie, { role }),
    at({ id, collaboratorId }),
  );
const leave = (cookie: string, id: string) =>
  leaving.POST(request('POST', `/api/documents/${id}/leave`, cookie), at({ id }));

interface Listed {
  id: string;
  kind: string;
  read: boolean;
  end?: string;
  title?: string;
  editorName?: string;
  documentId?: string;
  inTrash?: boolean;
}
const listOf = async (cookie: string) =>
  (await notifications.GET(request('GET', '/api/notifications', cookie))).json() as Promise<{
    unread: number;
    notifications: Listed[];
  }>;
const endedOf = async (cookie: string) =>
  (await listOf(cookie)).notifications.filter(({ kind }) => kind === 'ownership_offer_ended');
const storedFor = (userId: string) =>
  db().notification.findMany({ where: { recipientId: userId, kind: 'ownership_offer_ended' } });

let count = 0;
async function person(name = 'A Person') {
  const email = `notice${++count}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, name, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;
async function grant(documentId: string, who: Person, role: 'EDITOR' | 'VIEWER') {
  return (await db().documentCollaborator.create({ data: { documentId, userId: who.id, role } })).id;
}
const TITLE = 'The title the Owner knows';
/** An Owner with an Editor, and a document with a title. */
async function pair() {
  const owner = await person('Ada Owner');
  const editor = await person('Ben Editor');
  const id = (await createDocument(owner.id)).id;
  await db().document.update({ where: { id }, data: { title: TITLE } });
  const row = await grant(id, editor, 'EDITOR');
  return { owner, editor, id, row };
}
const pendingOf = (documentId: string) =>
  db().ownershipOffer.findFirstOrThrow({ where: { documentId, state: 'PENDING' } });
const code = async (response: Response) => (await response.clone().json()).error.code as string;

/** Runs `during` with a trigger that refuses the insert of a row of one kind of notification, and removes it. */
async function refusing<T>(kind: string, during: () => Promise<T>): Promise<T> {
  database.sql(
    `CREATE FUNCTION refuse_notice_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
     CREATE TRIGGER refuse_notice_for_test BEFORE INSERT ON "Notification" FOR EACH ROW WHEN (NEW.kind = '${kind}') EXECUTE FUNCTION refuse_notice_for_test();`,
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await during();
  } finally {
    database.sql(
      `DROP TRIGGER refuse_notice_for_test ON "Notification"; DROP FUNCTION refuse_notice_for_test();`,
    );
  }
}

describe('the limit on offers (NFR-SE-07; S17-7)', () => {
  it('refuses the offer past the limit with a 429 and a Retry-After, and creates nothing (weakening: no limit)', async () => {
    const { owner, editor, id, row } = await pair();
    for (let n = 0; n < 3; n += 1) {
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      expect((await withdraw(owner.cookie, id)).status).toBe(200);
    }
    const over = await offer(owner.cookie, id, row);
    expect(over.status).toBe(429);
    expect(await code(over)).toBe('rate_limited');
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await db().ownershipOffer.count({ where: { documentId: id, state: 'PENDING' } })).toBe(0);
    expect(await db().ownershipOffer.count({ where: { documentId: id } })).toBe(3);
    // No fourth notification either: the Editor holds none of an offer that was refused.
    expect(
      await db().notification.count({ where: { recipientId: editor.id, kind: 'ownership_offer' } }),
    ).toBe(0);
  });

  it('counts for each Owner, so that one Owner’s offers do not use up another’s', async () => {
    const first = await pair();
    const second = await pair();
    for (let n = 0; n < 3; n += 1) {
      expect((await offer(first.owner.cookie, first.id, first.row)).status).toBe(201);
      expect((await withdraw(first.owner.cookie, first.id)).status).toBe(200);
    }
    expect((await offer(first.owner.cookie, first.id, first.row)).status).toBe(429);
    // Weakening: one count for everyone.
    expect((await offer(second.owner.cookie, second.id, second.row)).status).toBe(201);
  });

  it('is counted across the Owner’s documents (weakening: a count for each document)', async () => {
    const owner = await person('Ada Owner');
    const editor = await person('Ben Editor');
    const documents = await Promise.all([0, 1, 2, 3].map(async () => (await createDocument(owner.id)).id));
    const rows = await Promise.all(documents.map((id) => grant(id, editor, 'EDITOR')));
    for (const [n, id] of documents.entries()) {
      const response = await offer(owner.cookie, id, rows[n]);
      expect(response.status).toBe(n < 3 ? 201 : 429);
    }
  });

  it('does not count an offer that was refused, nor a withdrawal, nor an invitation (weakening: count before the refusals)', async () => {
    const { owner, editor, id, row } = await pair();
    const viewer = await person('Vera Viewer');
    const viewerRow = await grant(id, viewer, 'VIEWER');
    // Refused: not an Editor (409), no such collaborator (404), and an offer past the one pending (409).
    for (let n = 0; n < 5; n += 1) {
      expect((await offer(owner.cookie, id, viewerRow)).status).toBe(409);
      expect((await offer(owner.cookie, id, 'no-such-row')).status).toBe(404);
    }
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    for (let n = 0; n < 5; n += 1) expect((await offer(owner.cookie, id, row)).status).toBe(409);
    expect((await withdraw(owner.cookie, id)).status).toBe(200);
    // The invitations of the Owner are counted by their own limit and not by this one.
    for (let n = 0; n < 4; n += 1) {
      const invited = await inviting.POST(
        request('POST', `/api/documents/${id}/invitations`, owner.cookie, {
          emails: [`counted${n}@example.com`],
          role: 'viewer',
        }),
        at({ id }),
      );
      expect(invited.status).toBe(201);
    }
    // Three offers have been counted at most: this is the second, and so is the third.
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await withdraw(owner.cookie, id)).status).toBe(200);
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await withdraw(owner.cookie, id)).status).toBe(200);
    expect((await offer(owner.cookie, id, row)).status).toBe(429);
    expect(editor.id).toBeTruthy();
  });

  it('gives back the count of an offer that a failed transaction did not make (weakening: the count kept)', async () => {
    const { owner, id, row } = await pair();
    const failed = await refusing('ownership_offer', () => offer(owner.cookie, id, row));
    expect(failed.status).toBe(500);
    expect(await db().ownershipOffer.count({ where: { documentId: id } })).toBe(0);
    for (let n = 0; n < 3; n += 1) {
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      expect((await withdraw(owner.cookie, id)).status).toBe(200);
    }
    expect((await offer(owner.cookie, id, row)).status).toBe(429);
  });
});

describe('the Owner is told when an offer ends without the Owner’s own action (S17-5)', () => {
  it('is told that the Editor declined, in the same transaction, and the Editor is told nothing', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await pendingOf(id);

    expect(await endedOf(owner.cookie)).toEqual([]);
    expect((await answer(editor.cookie, made.id, 'decline')).status).toBe(200);

    const listed = await listOf(owner.cookie);
    expect(listed.unread).toBe(1);
    expect(listed.notifications).toEqual([
      expect.objectContaining({
        kind: 'ownership_offer_ended',
        read: false,
        end: 'declined',
        title: TITLE,
        editorName: 'Ben Editor',
        documentId: id,
      }),
    ]);
    // The payload holds identifiers and the way it ended, and no title and no name.
    const [stored] = await storedFor(owner.id);
    expect(stored!.payload).toEqual({ documentId: id, toUserId: editor.id, end: 'declined' });
    expect(await endedOf(editor.cookie)).toEqual([]);
    expect(await storedFor(editor.id)).toEqual([]);
  });

  it('leaves the decline unmade where the notification cannot be written (weakening: the notification written outside the transaction)', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await pendingOf(id);
    const failed = await refusing('ownership_offer_ended', () => answer(editor.cookie, made.id, 'decline'));
    expect(failed.status).toBe(500);
    expect((await pendingOf(id)).id).toBe(made.id);
    expect(await storedFor(owner.id)).toEqual([]);
  });

  it('is told that the offer expired, once, whichever of the timer and the next offer meets it first', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await pendingOf(id);
    // Only this offer is past its time: the others the database holds are 14 days from it.
    await db().ownershipOffer.update({
      where: { id: made.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const past = new Date();

    expect(await expireOffers(past)).toBe(1);
    expect(await expireOffers(past)).toBe(0);
    expect(await endedOf(owner.cookie)).toEqual([
      expect.objectContaining({ end: 'expired', editorName: 'Ben Editor' }),
    ]);
    expect(await storedFor(editor.id)).toEqual([]);

    // An offer that is past its time and has not been written expired yet is settled by the next offer, and told once.
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const second = await pendingOf(id);
    await db().ownershipOffer.update({
      where: { id: second.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect(await expireOffers(new Date(Date.now() + 1000))).toBe(0);
    expect((await endedOf(owner.cookie)).map(({ end }) => end)).toEqual(['expired', 'expired']);
  });

  it('is told once where the timer’s expiry is not yet committed when the next offer settles the same offer (weakening: no PENDING guard on the write of settle)', async () => {
    const { owner, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await pendingOf(id);
    await db().ownershipOffer.update({
      where: { id: made.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // The timer's transaction: the offer written expired and the Owner's notice, held uncommitted.
    let held!: () => void;
    let release!: () => void;
    const holds = new Promise<void>((resolve) => (held = resolve));
    const gate = new Promise<void>((resolve) => (release = resolve));
    const timer = db().$transaction(
      async (tx) => {
        await tx.ownershipOffer.update({
          where: { id: made.id },
          data: { state: 'EXPIRED', respondedAt: new Date() },
        });
        await notifyOfferEnded(tx, {
          ownerId: owner.id,
          toUserId: made.toUserId,
          documentId: id,
          end: 'expired',
        });
        held();
        await gate;
      },
      { timeout: 20_000 },
    );
    await holds;
    // The next offer reads the offer as pending (the expiry is not committed), then waits on its row.
    const next = offer(owner.cookie, id, row);
    await until(() =>
      /(^|\n)[1-9]\d*$/.test(
        database.sql(`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type = 'Lock'`),
      ),
    );
    release();
    await timer;
    expect((await next).status).toBe(201);

    expect(await storedFor(owner.id)).toHaveLength(1);
    expect(await endedOf(owner.cookie)).toEqual([expect.objectContaining({ end: 'expired' })]);
  });

  it('writes the notice in the transaction of an expiry and of the system’s ending, so that neither stands without it (weakening: the notice written after the commit)', async () => {
    const { owner, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    const made = await pendingOf(id);

    // The system's ending: the Editor is removed while the notice cannot be written.
    const removed = await refusing('ownership_offer_ended', () => removal(owner.cookie, id, row));
    expect(removed.status).toBe(500);
    expect((await pendingOf(id)).id).toBe(made.id);
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(1);

    // The expiry: the timer's transaction fails as a whole.
    await db().ownershipOffer.update({
      where: { id: made.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await refusing('ownership_offer_ended', async () => {
      await expect(expireOffers(new Date())).rejects.toThrow();
    });
    expect((await pendingOf(id)).id).toBe(made.id);
    expect(await storedFor(owner.id)).toEqual([]);
  });

  it('is told that the system ended it where the Editor stops holding the role: removed, left, or given another role', async () => {
    for (const how of ['removed', 'left', 'viewer'] as const) {
      const { owner, editor, id, row } = await pair();
      expect((await offer(owner.cookie, id, row)).status).toBe(201);
      const done =
        how === 'removed'
          ? await removal(owner.cookie, id, row)
          : how === 'left'
            ? await leave(editor.cookie, id)
            : await changeRole(owner.cookie, id, row, 'viewer');
      expect([200, 204]).toContain(done.status);
      expect(await db().ownershipOffer.count({ where: { documentId: id, state: 'WITHDRAWN' } })).toBe(1);
      expect(await endedOf(owner.cookie)).toEqual([
        expect.objectContaining({ end: 'ended', title: TITLE, editorName: 'Ben Editor' }),
      ]);
    }
  });

  it('is told nothing where the Owner withdraws the offer (weakening: tell the Owner of every ending)', async () => {
    const { owner, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await withdraw(owner.cookie, id)).status).toBe(200);
    expect(await storedFor(owner.id)).toEqual([]);
  });

  it('is told that the offer ended where the document is deleted, and a deletion with no offer open tells nothing (the owner’s answer of 21 October 2026; weakening: no notice at a deletion)', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect(await deleteDocument({ id }, owner.id)).toBe(true);
    expect(await db().ownershipOffer.count({ where: { documentId: id, state: 'WITHDRAWN' } })).toBe(1);
    // The document is in the trash, and the notice is still the Owner's to read, with a way to the deleted documents.
    expect(await endedOf(owner.cookie)).toEqual([
      expect.objectContaining({ end: 'deleted', title: TITLE, editorName: 'Ben Editor', inTrash: true }),
    ]);
    expect((await storedFor(owner.id))[0]!.payload).toEqual({
      documentId: id,
      toUserId: editor.id,
      end: 'deleted',
    });
    expect(await storedFor(editor.id)).toEqual([]);
    // Restored, the document stands and the link is to the document (the list reads the trash at each read).
    expect(await restoreDocument({ id })).not.toBeNull();
    expect(await endedOf(owner.cookie)).toEqual([
      expect.objectContaining({ end: 'deleted', inTrash: false }),
    ]);

    // No offer, no notice.
    const other = await pair();
    expect(await deleteDocument({ id: other.id }, other.owner.id)).toBe(true);
    expect(await storedFor(other.owner.id)).toEqual([]);
  });

  it('stays 30 days, as a removal does, and not a day longer, whether or not the document stands (the owner’s answer of 21 October 2026; weakening: no time limit)', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await answer(editor.cookie, (await pendingOf(id)).id, 'decline')).status).toBe(200);
    const [stored] = await storedFor(owner.id);
    const days = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

    await db().notification.update({ where: { id: stored!.id }, data: { createdAt: days(29) } });
    expect(await endedOf(owner.cookie)).toHaveLength(1);
    // Past the 30 days the list does not show it, and the timer deletes it.
    await db().notification.update({ where: { id: stored!.id }, data: { createdAt: days(31) } });
    expect(await endedOf(owner.cookie)).toEqual([]);
    expect(await storedFor(owner.id)).toHaveLength(1);
    expect(await deleteExpiredRemovedNotifications(new Date())).toBeGreaterThanOrEqual(1);
    expect(await storedFor(owner.id)).toEqual([]);
  });

  it('is told nothing of an offer that was accepted, and the former Owner’s earlier notices go with the ownership', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await answer(editor.cookie, (await pendingOf(id)).id, 'decline')).status).toBe(200);
    expect(await endedOf(owner.cookie)).toHaveLength(1);

    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await answer(editor.cookie, (await pendingOf(id)).id, 'accept')).status).toBe(200);
    // The Editor is the Owner now; the former Owner holds a role on the document and is shown nothing of it.
    expect(await endedOf(owner.cookie)).toEqual([]);
    expect(await storedFor(owner.id)).toEqual([]);
    expect(await endedOf(editor.cookie)).toEqual([]);
  });

  it('stays in the list, read or unread, and is its recipient’s alone', async () => {
    const { owner, editor, id, row } = await pair();
    const stranger = await person('Sam Stranger');
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await answer(editor.cookie, (await pendingOf(id)).id, 'decline')).status).toBe(200);
    const [shown] = await endedOf(owner.cookie);

    // Weakening: marked by identifier alone.
    expect(
      (
        await notification.PATCH(
          request('PATCH', `/api/notifications/${shown!.id}`, stranger.cookie),
          at({ id: shown!.id }),
        )
      ).status,
    ).toBe(404);
    expect((await listOf(owner.cookie)).unread).toBe(1);
    expect(
      (
        await notification.PATCH(
          request('PATCH', `/api/notifications/${shown!.id}`, owner.cookie),
          at({ id: shown!.id }),
        )
      ).status,
    ).toBe(204);
    const after = await listOf(owner.cookie);
    expect(after.unread).toBe(0);
    expect(after.notifications).toEqual([
      expect.objectContaining({ kind: 'ownership_offer_ended', read: true }),
    ]);
    expect(JSON.stringify(await listOf(stranger.cookie))).not.toContain(TITLE);

    // A document in the trash keeps the notice (it stays 30 days); a permanent deletion takes its rows.
    await deleteDocument({ id }, owner.id);
    expect(await endedOf(owner.cookie)).toEqual([expect.objectContaining({ inTrash: true })]);
    expect(await storedFor(owner.id)).toHaveLength(1);
    await db().$transaction((tx) => deleteAccessNotificationsOf(tx, id));
    expect(await storedFor(owner.id)).toEqual([]);
  });

  it('names an Editor whose account is gone as "the Editor" and shows the title as it stands', async () => {
    const { owner, editor, id, row } = await pair();
    expect((await offer(owner.cookie, id, row)).status).toBe(201);
    expect((await answer(editor.cookie, (await pendingOf(id)).id, 'decline')).status).toBe(200);
    await db().document.update({ where: { id }, data: { title: 'Renamed since' } });
    await db().user.update({ where: { id: editor.id }, data: { name: null } });
    await db().user.update({ where: { id: editor.id }, data: { email: null } });
    expect(await endedOf(owner.cookie)).toEqual([
      expect.objectContaining({ title: 'Renamed since', editorName: '' }),
    ]);
  });
});
