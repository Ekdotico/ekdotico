// The title and the sender of an invitation (FR-ED-21 as amended by D202; register
// rows D202 and Q49): the invitee sees the title on the page and in the
// notification, behind sign-in and only as the account that holds the invited
// address; the email carries no title, whatever happens; the sender is named by
// name and by email address; the inviter may hide the title, which is replaced
// by a pseudonym fixed for the invitation; after acceptance the invitee is shown
// the real title. Called as Next.js calls the routes, against a provisioned
// database, the real Valkey and the local email sink. Each test of a security
// rule names the weakening that makes it fail.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn, sunk } from './identity.ts';

const later = vi.hoisted(() => ({ tasks: [] as (() => unknown)[] }));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.tasks.push(task),
}));
const runLater = async () => {
  for (const task of later.tasks.splice(0)) await task();
};

const SINK = mkdtempSync(join(tmpdir(), 'ekdotico-title-mail-'));
const database = prepare('invitationtitle', {
  EMAIL_SINK_DIRECTORY: SINK,
  RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600',
});
const { auth, db, valkey } = await load();
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { viewInvitation, listNotifications, sharingOf } = await import('../../src/lib/documents/sharing.ts');
const { PSEUDONYM_ADJECTIVES, PSEUDONYM_ANIMALS } = await import('../../src/lib/documents/pseudonym.ts');
const inviting = await import('../../src/app/api/documents/[id]/invitations/route.ts');
const resending = await import('../../src/app/api/documents/[id]/invitations/[invitationId]/resend/route.ts');
const people = await import('../../src/app/api/documents/[id]/collaborators/route.ts');
const one = await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
const byLink = await import('../../src/app/api/invitations/[token]/[answer]/route.ts');
const notifications = await import('../../src/app/api/notifications/route.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(() => void later.tasks.splice(0));

const TITLE = 'Quartz-zebra-title-never-in-an-email';
const SUBJECT = 'You have been invited to a document! | Ekdotico';
const PSEUDONYM = new RegExp(
  `^(${PSEUDONYM_ADJECTIVES.join('|')}) (${PSEUDONYM_ANIMALS.join('|')}) — (Ada Owner|Eddie Editor)$`,
);

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

const invite = (cookie: string, id: string, body: unknown) =>
  inviting.POST(request('POST', `/api/documents/${id}/invitations`, cookie, body), at({ id }));
const resend = (cookie: string, id: string, invitationId: string) =>
  resending.POST(
    request('POST', `/api/documents/${id}/invitations/${invitationId}/resend`, cookie),
    at({ id, invitationId }),
  );
const accept = (cookie: string, token: string) =>
  byLink.POST(request('POST', `/api/invitations/${token}/accept`, cookie), at({ token, answer: 'accept' }));
const listOf = async (cookie: string) =>
  (await notifications.GET(request('GET', '/api/notifications', cookie))).json() as Promise<{
    unread: number;
    notifications: {
      id: string;
      kind: string;
      inviterName: string;
      inviterEmail: string | null;
      title: string | null;
      pseudonym: string | null;
    }[];
  }>;

let count = 0;
async function person(name = 'Ada Owner') {
  const email = `titled${++count}@example.com`;
  const id = await createAccount(auth, email, true);
  await db().user.update({ where: { id }, data: { name } });
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;
async function documentOf(owner: Person): Promise<string> {
  const { id } = await createDocument(owner.id);
  await db().document.update({ where: { id }, data: { title: TITLE } });
  return id;
}
const mailTo = async (email: string) => (await sunk(SINK)).filter(({ to }) => to === email);
const tokenIn = (text: string) => /\/invitations\/([A-Za-z0-9_-]{43})/.exec(text)![1]!;

/** An invitation sent and delivered, with the token of its email and its row. */
async function sent(inviter: Person, documentId: string, to: Person, extra: object = {}) {
  expect(
    (await invite(inviter.cookie, documentId, { emails: [to.email], role: 'viewer', ...extra })).status,
  ).toBe(201);
  await runLater();
  const mail = (await mailTo(to.email)).at(-1)!;
  const row = await db().documentInvitation.findFirstOrThrow({
    where: { documentId, email: to.email },
    orderBy: { createdAt: 'desc' },
  });
  return { mail, token: tokenIn(mail.text), row };
}

describe('the title is shown to the invitee (D202)', () => {
  it('is on the page and in the notification, with the sender by name and by address', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    const { token, row } = await sent(owner, documentId, invitee);

    expect(row.titlePseudonym).toBeNull();
    for (const ref of [{ token }, { id: row.id }]) {
      expect(await viewInvitation(invitee.id, ref)).toMatchObject({
        outcome: 'open',
        inviterName: 'Ada Owner',
        inviterEmail: owner.email,
        titleShown: { title: TITLE, pseudonym: null },
      });
    }
    const { notifications: listed } = await listOf(invitee.cookie);
    expect(listed).toEqual([
      expect.objectContaining({
        kind: 'document_invitation',
        inviterName: 'Ada Owner',
        inviterEmail: owner.email,
        title: TITLE,
        pseudonym: null,
      }),
    ]);
  });

  it('is shown only to the account that holds the invited address (weakening: show the title to any signed-in account)', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const stranger = await person('Sam Stranger');
    const documentId = await documentOf(owner);
    const { token, row } = await sent(owner, documentId, invitee);

    for (const ref of [{ token }, { id: row.id }]) {
      const seen = await viewInvitation(stranger.id, ref);
      expect(seen).toEqual({ outcome: 'not_open_to_account' });
      expect(JSON.stringify(seen)).not.toContain(TITLE);
      // The Owner, who knows the title, is told what any other account is told.
      expect(await viewInvitation(owner.id, ref)).toEqual({ outcome: 'not_open_to_account' });
    }
    expect(JSON.stringify(await listOf(stranger.cookie))).not.toContain(TITLE);
    expect(JSON.stringify(await listOf(owner.cookie))).not.toContain(row.id);
  });

  it('is not shown to an account that no longer holds the invited address (weakening: no address check in the list)', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    const { token, row } = await sent(owner, documentId, invitee);

    // The address changes after the invitation was sent: the page refuses the account, and so must the list.
    await db().user.update({ where: { id: invitee.id }, data: { email: 'moved-away@example.com' } });
    expect(await viewInvitation(invitee.id, { token })).toEqual({ outcome: 'not_open_to_account' });
    const listed = await listOf(invitee.cookie);
    expect(JSON.stringify(listed)).not.toContain(TITLE);
    expect(listed.notifications).toEqual([
      expect.objectContaining({
        invitationId: row.id,
        title: null,
        pseudonym: null,
        inviterName: 'Ada Owner',
      }),
    ]);
  });

  it('is never in the email, whether the title is shown or hidden (weakening: put the title in the text or the subject)', async () => {
    const owner = await person();
    const first = await person('Ina Invitee');
    const second = await person('Ivan Invitee');
    const documentId = await documentOf(owner);
    await sent(owner, documentId, first);
    await sent(owner, documentId, second, { hideTitle: true });
    await resend(
      owner.cookie,
      documentId,
      (await db().documentInvitation.findFirstOrThrow({ where: { email: first.email } })).id,
    );
    await runLater();

    const all = await sunk(SINK);
    expect(all.length).toBeGreaterThanOrEqual(3);
    // Every message of the sink, whole: the subject, the text and what the file holds besides.
    expect(JSON.stringify(all)).not.toContain(TITLE);
    expect(JSON.stringify(all)).not.toContain('Quartz');
  });

  it('has the subject and the text the owner is to approve, with the sender’s address', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const { mail } = await sent(owner, await documentOf(owner), invitee);
    expect(mail.subject).toBe(SUBJECT);
    expect(mail.text).toMatch(
      new RegExp(
        `^Ada Owner \\(${owner.email.replace('.', '\\.')}\\) invited you to a document in Ekdotico as Viewer\\. To accept or decline, open this link: https://app\\.example\\.test/invitations/[A-Za-z0-9_-]{43}\\. The link works once, and the invitation is open until \\d{1,2} [A-Z][a-z]{2} \\d{4}, \\d{2}:\\d{2} UTC\\. If you did not expect this invitation, you can ignore this email\\.\\n?$`,
      ),
    );
  });
});

describe('hiding the title behind a pseudonym (Q49)', () => {
  it('is off unless asked for, and a value that is not a boolean is refused with nothing created', async () => {
    const owner = await person();
    const documentId = await documentOf(owner);
    for (const hideTitle of ['true', 'false', 1, 0, null, 'yes']) {
      const refused = await invite(owner.cookie, documentId, {
        emails: ['x@example.com'],
        role: 'viewer',
        hideTitle,
      });
      expect(refused.status).toBe(422);
      expect((await refused.json()).error.code).toBe('invalid_request');
    }
    expect(await db().documentInvitation.count({ where: { documentId } })).toBe(0);
    expect(
      (await invite(owner.cookie, documentId, { emails: ['a@example.com'], role: 'viewer' })).status,
    ).toBe(201);
    expect(
      (
        await invite(owner.cookie, documentId, {
          emails: ['b@example.com'],
          role: 'viewer',
          hideTitle: false,
        })
      ).status,
    ).toBe(201);
    const rows = await db().documentInvitation.findMany({ where: { documentId } });
    expect(rows.map(({ titlePseudonym }) => titlePseudonym)).toEqual([null, null]);
  });

  it('shows the same words on the page, in the notification and in the email, and never the title (weakening: show the title beside or instead of the pseudonym)', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    const { token, row, mail } = await sent(owner, documentId, invitee, { hideTitle: true });

    const pseudonym = row.titlePseudonym!;
    expect(pseudonym).toMatch(PSEUDONYM);
    expect(pseudonym.endsWith('— Ada Owner')).toBe(true);
    // Fixed for the invitation (Q49 (1)): the page asked twice, by link and by identifier, says the same.
    const views = [
      await viewInvitation(invitee.id, { token }),
      await viewInvitation(invitee.id, { id: row.id }),
      await viewInvitation(invitee.id, { token }),
    ];
    for (const view of views) {
      expect(view).toMatchObject({
        outcome: 'open',
        inviterName: 'Ada Owner',
        inviterEmail: owner.email,
        titleShown: { title: null, pseudonym },
      });
      expect(JSON.stringify(view)).not.toContain(TITLE);
    }
    const { notifications: listed } = await listOf(invitee.cookie);
    expect(listed).toEqual([expect.objectContaining({ title: null, pseudonym })]);
    expect(JSON.stringify(listed)).not.toContain(TITLE);
    expect(mail.text).toContain(
      `The title of the document is hidden. In Ekdotico it is shown as ${pseudonym}.`,
    );
    expect(mail.text).not.toContain(TITLE);
    // The same invitation, shown by the list a second time, is the same words.
    expect(
      (await listNotifications(invitee.id)).notifications.map((n) => (n as { pseudonym?: string }).pseudonym),
    ).toEqual([pseudonym]);
  });

  it('is made again, with a new row, for an invitation sent again, and a shown title stays shown', async () => {
    const owner = await person();
    const hidden = await person('Ina Invitee');
    const shown = await person('Ivan Invitee');
    const documentId = await documentOf(owner);
    const first = await sent(owner, documentId, hidden, { hideTitle: true });
    const plain = await sent(owner, documentId, shown);

    expect((await resend(owner.cookie, documentId, first.row.id)).status).toBe(201);
    expect((await resend(owner.cookie, documentId, plain.row.id)).status).toBe(201);
    const rows = await db().documentInvitation.findMany({
      where: { documentId },
      orderBy: { createdAt: 'asc' },
    });
    const [, , again, plainAgain] = rows;
    expect(again!.email).toBe(hidden.email);
    expect(again!.titlePseudonym).toMatch(PSEUDONYM);
    expect(plainAgain!.email).toBe(shown.email);
    expect(plainAgain!.titlePseudonym).toBeNull();
  });

  it('is shown the real title after acceptance, in the list (Q49 (2))', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    const { token, row } = await sent(owner, documentId, invitee, { hideTitle: true });
    expect((await listOf(invitee.cookie)).notifications[0]).toMatchObject({
      title: null,
      pseudonym: row.titlePseudonym,
    });

    expect((await accept(invitee.cookie, token)).status).toBe(200);
    // The notification stays after an acceptance (FR-ED-42), and now says the title.
    expect((await listOf(invitee.cookie)).notifications).toEqual([
      expect.objectContaining({ kind: 'document_invitation', title: TITLE, pseudonym: null }),
    ]);
    expect(await viewInvitation(invitee.id, { token })).toEqual({ outcome: 'accepted', documentId });
  });

  it('keeps a hidden title hidden from an account that accepted and then lost its role (weakening: show the title of any accepted invitation)', async () => {
    const owner = await person();
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    const { token, row } = await sent(owner, documentId, invitee, { hideTitle: true });
    expect((await accept(invitee.cookie, token)).status).toBe(200);
    const collaborators = (await (
      await people.GET(
        request('GET', `/api/documents/${documentId}/collaborators`, owner.cookie),
        at({ id: documentId }),
      )
    ).json()) as {
      collaborators: { id: string }[];
    };
    const removed = await one.DELETE(
      request(
        'DELETE',
        `/api/documents/${documentId}/collaborators/${collaborators.collaborators[0]!.id}`,
        owner.cookie,
      ),
      at({ id: documentId, collaboratorId: collaborators.collaborators[0]!.id }),
    );
    expect(removed.status).toBe(200);

    const listed = await listOf(invitee.cookie);
    expect(JSON.stringify(listed)).not.toContain(TITLE);
    expect(listed.notifications.find(({ kind }) => kind === 'document_invitation')).toMatchObject({
      title: null,
      pseudonym: row.titlePseudonym,
    });
  });

  it('is the inviter’s to choose: the Owner, and an Editor who may invite, and no one who may not (Q49 (5); weakening: refuse the Editor, or admit one without the permission)', async () => {
    const owner = await person();
    const editor = await person('Eddie Editor');
    const outsider = await person('Olive Outsider');
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    await db().documentCollaborator.create({ data: { documentId, userId: editor.id, role: 'EDITOR' } });

    // An Editor who does not hold the permission may not invite, so may not hide a title.
    const refused = await invite(editor.cookie, documentId, {
      emails: [invitee.email],
      role: 'viewer',
      hideTitle: true,
    });
    expect(refused.status).toBe(403);
    expect(await db().documentInvitation.count({ where: { documentId } })).toBe(0);
    const stranger = await invite(outsider.cookie, documentId, {
      emails: [invitee.email],
      role: 'viewer',
      hideTitle: true,
    });
    expect(stranger.status).toBe(404);
    expect(await db().documentInvitation.count({ where: { documentId } })).toBe(0);

    const set = defaultPermissionSet();
    set['document.collaborators.invite'].editor = true;
    await db().document.update({ where: { id: documentId }, data: { permissionSet: set } });
    const { row } = await sent(editor, documentId, invitee, { hideTitle: true });
    // The pseudonym is made with the display name of whoever sent the invitation.
    expect(row.invitedById).toBe(editor.id);
    expect(row.titlePseudonym).toMatch(PSEUDONYM);
    expect(row.titlePseudonym!.endsWith('— Eddie Editor')).toBe(true);
    expect(await viewInvitation(invitee.id, { id: row.id })).toMatchObject({
      inviterName: 'Eddie Editor',
      inviterEmail: editor.email,
      titleShown: { title: null, pseudonym: row.titlePseudonym },
    });
  });

  it('is shown to the people who may invite, with the pseudonym, and to no one else', async () => {
    const owner = await person();
    const editor = await person('Eddie Editor');
    const invitee = await person('Ina Invitee');
    const documentId = await documentOf(owner);
    await db().documentCollaborator.create({ data: { documentId, userId: editor.id, role: 'EDITOR' } });
    const { row } = await sent(owner, documentId, invitee, { hideTitle: true });
    const document = await db().document.findUniqueOrThrow({ where: { id: documentId } });

    const ownerSees = await sharingOf(document, 'owner', owner.id);
    expect(ownerSees.invitations).toEqual([expect.objectContaining({ titlePseudonym: row.titlePseudonym })]);
    // An Editor who does not hold the permission is not shown the pending invitations at all.
    expect((await sharingOf(document, 'editor', editor.id)).invitations).toBeUndefined();
    expect(JSON.stringify(await sharingOf(document, 'editor', editor.id))).not.toContain(row.titlePseudonym!);
  });
});
