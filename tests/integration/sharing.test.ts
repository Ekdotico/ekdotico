// Sharing a document (FR-ED-19, FR-ED-21, FR-ED-37, FR-ED-39, FR-ED-42,
// FR-ED-44 (a); NFR-SE-07, NFR-SE-19, NFR-RE-15): the routes of invitations
// and of the notification list, called as Next.js calls them, against a
// provisioned database, the real Valkey and the local email sink. Each test
// of a security rule names the weakening that makes it fail.
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn, sunk } from './identity.ts';

// `after` of Next.js exists only inside a request of the framework. Here its
// tasks are kept, so that a test sees what happened before the response and
// what after it.
const later = vi.hoisted(() => ({ tasks: [] as (() => unknown)[] }));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.tasks.push(task),
}));
const runLater = async () => {
  for (const task of later.tasks.splice(0)) await task();
};

const SINK = mkdtempSync(join(tmpdir(), 'ekdotico-sharing-mail-'));
// Room for the tests of the limit of ten without meeting the limit of an hour,
// which its own test reaches with a person of its own.
const database = prepare('sharing', {
  EMAIL_SINK_DIRECTORY: SINK,
  RATE_LIMIT_INVITATIONS_PER_USER: '12/3600',
});
const { auth, db, valkey } = await load();
const { hashToken } = await import('../../src/lib/token.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { deliverInvitations } = await import('../../src/lib/documents/sharing.ts');
const { authorise } = await import('../../src/lib/documents/access.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const one = await import('../../src/app/api/documents/[id]/route.ts');
const inviting = await import('../../src/app/api/documents/[id]/invitations/route.ts');
const revoking = await import('../../src/app/api/documents/[id]/invitations/[invitationId]/route.ts');
const resending = await import('../../src/app/api/documents/[id]/invitations/[invitationId]/resend/route.ts');
const people = await import('../../src/app/api/documents/[id]/collaborators/route.ts');
const byLink = await import('../../src/app/api/invitations/[token]/[answer]/route.ts');
const byId = await import('../../src/app/api/invitations/received/[invitationId]/[answer]/route.ts');
const notifications = await import('../../src/app/api/notifications/route.ts');
const notification = await import('../../src/app/api/notifications/[id]/route.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(() => void later.tasks.splice(0));

const CONFIRMATION = (address: string) =>
  `Invitation created for ${address}. Ekdotico sends an invitation only to an address that belongs to an account. If this address does, the person receives an email and a notification.`;
const LIMIT =
  'This document has reached its limit of ten people. Remove a collaborator or revoke an invitation to invite another.';
// D202: the owner's subject, owed final approval.
const SUBJECT = 'You have been invited to a document | Ekdotico';

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

const invite = (cookie: string, id: string, emails: string[], role = 'editor') =>
  inviting.POST(request('POST', `/api/documents/${id}/invitations`, cookie, { emails, role }), at({ id }));
const revoke = (cookie: string, id: string, invitationId: string) =>
  revoking.DELETE(
    request('DELETE', `/api/documents/${id}/invitations/${invitationId}`, cookie),
    at({ id, invitationId }),
  );
const resend = (cookie: string, id: string, invitationId: string) =>
  resending.POST(
    request('POST', `/api/documents/${id}/invitations/${invitationId}/resend`, cookie),
    at({ id, invitationId }),
  );
const peopleOf = (cookie: string, id: string) =>
  people.GET(request('GET', `/api/documents/${id}/collaborators`, cookie), at({ id }));
const answerByLink = (cookie: string, token: string, answer: string) =>
  byLink.POST(request('POST', `/api/invitations/${token}/${answer}`, cookie), at({ token, answer }));
const answerById = (cookie: string, invitationId: string, answer: string) =>
  byId.POST(
    request('POST', `/api/invitations/received/${invitationId}/${answer}`, cookie),
    at({ invitationId, answer }),
  );
const listOf = async (cookie: string) =>
  (await notifications.GET(request('GET', '/api/notifications', cookie))).json() as Promise<{
    unread: number;
    notifications: { id: string; read: boolean; invitationId: string; inviterName: string; role: string }[];
  }>;
const markRead = (cookie: string, id: string) =>
  notification.PATCH(request('PATCH', `/api/notifications/${id}`, cookie), at({ id }));

let count = 0;
async function person(verified = true) {
  const email = `sharer${++count}@example.com`;
  const id = await createAccount(auth, email, verified);
  // An unverified account cannot sign in; it needs no session here.
  const cookie = verified ? cookiesOf(await signIn(auth, email)) : '';
  return { id, email, cookie };
}
async function documentOf(cookie: string): Promise<string> {
  const response = await collection.POST(request('POST', '/api/documents', cookie, {}));
  expect(response.status).toBe(201);
  return (await response.json()).id;
}
const invitationsOf = (documentId: string) =>
  db().documentInvitation.findMany({ where: { documentId }, orderBy: { createdAt: 'asc' } });
const logged = (documentId: string) =>
  db().securityLogEntry.findMany({ where: { documentId }, select: { kind: true, userId: true } });
const mailTo = async (email: string) => (await sunk(SINK)).filter(({ to }) => to === email);
const tokenIn = (text: string) => /\/invitations\/([A-Za-z0-9_-]{43})/.exec(text)?.[1];

/** An invitation sent and delivered to `to`, with the token its email carries. */
async function sent(owner: { cookie: string }, documentId: string, to: { email: string }, role = 'editor') {
  expect((await invite(owner.cookie, documentId, [to.email], role)).status).toBe(201);
  await runLater();
  const mail = (await mailTo(to.email)).at(-1)!;
  const token = tokenIn(mail.text)!;
  const row = await db().documentInvitation.findUniqueOrThrow({ where: { tokenHash: hashToken(token) } });
  return { token, row };
}

describe('the uniform answer (FR-ED-21)', () => {
  it('answers an account, an unverified account and no account alike, and sends to the first alone, after the response', async () => {
    const owner = await person();
    const verified = await person();
    const unverified = await person(false);
    const nobody = 'nobody-at-all@example.com';
    const id = await documentOf(owner.cookie);

    const answers = [];
    for (const email of [verified.email, unverified.email, nobody]) {
      const response = await invite(owner.cookie, id, [email]);
      answers.push({
        status: response.status,
        body: JSON.stringify(await response.json()).replace(email, 'X'),
      });
    }
    // Weakening: answer an address without an account differently, or not create its row.
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
    expect(answers[0]).toEqual({ status: 201, body: JSON.stringify({ confirmations: [CONFIRMATION('X')] }) });
    const rows = await invitationsOf(id);
    expect(rows.map(({ email, state, emailClaimedAt }) => [email, state, emailClaimedAt])).toEqual([
      [verified.email, 'PENDING', null],
      [unverified.email, 'PENDING', null],
      [nobody, 'PENDING', null],
    ]);

    // Weakening: send the email, or write the notification, before the response.
    expect(await mailTo(verified.email)).toEqual([]);
    expect(await db().notification.count({ where: { recipientId: verified.id } })).toBe(0);

    await runLater();
    const mail = await mailTo(verified.email);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toBe(SUBJECT);
    expect(mail[0]!.text).toMatch(
      /^A Person \(sharer\d+@example\.com\) invited you to a document in Ekdotico as Editor\. To accept or decline, open this link: https:\/\/app\.example\.test\/invitations\/[A-Za-z0-9_-]{43}\. The link works once, and the invitation is open until \d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC\. If you did not expect this invitation, you can ignore this email\.\n?$/,
    );
    expect(await mailTo(unverified.email)).toEqual([]);
    expect(await mailTo(nobody)).toEqual([]);
    expect(
      await db().notification.count({ where: { recipientId: { in: [verified.id, unverified.id] } } }),
    ).toBe(1);
    const after = await invitationsOf(id);
    expect(after.map(({ emailClaimedAt }) => emailClaimedAt !== null)).toEqual([true, false, false]);
    // The token is stored only as its hash.
    expect(after[0]!.tokenHash).toBe(hashToken(tokenIn(mail[0]!.text)!));
  });

  it('hands an email over once, however often the delivery runs (weakening: no claim of the row)', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    expect((await invite(owner.cookie, id, [invitee.email])).status).toBe(201);
    const [task] = later.tasks.splice(0);
    await task!();
    await task!();
    expect(await mailTo(invitee.email)).toHaveLength(1);
    expect(await db().notification.count({ where: { recipientId: invitee.id } })).toBe(1);
  });

  it('never returns the link, and puts no token in a notification', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const response = await invite(owner.cookie, id, [invitee.email]);
    const text = await response.text();
    await runLater();
    const token = tokenIn((await mailTo(invitee.email))[0]!.text)!;
    expect(text).not.toContain(token);
    expect(JSON.stringify(await listOf(invitee.cookie))).not.toContain(token);
    expect(JSON.stringify(await (await peopleOf(owner.cookie, id)).json())).not.toContain(token);
    const stored = await db().notification.findMany({ where: { recipientId: invitee.id } });
    expect(stored.map(({ payload }) => Object.keys(payload as object))).toEqual([['invitationId']]);
  });

  it('gives an address entered twice one invitation, and refuses the Owner’s own and an accepted collaborator’s with a 409', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const twice = await invite(owner.cookie, id, [invitee.email, invitee.email.toUpperCase()]);
    expect((await twice.json()).confirmations).toHaveLength(1);
    await runLater();
    const token = tokenIn((await mailTo(invitee.email))[0]!.text)!;
    expect((await answerByLink(invitee.cookie, token, 'accept')).status).toBe(200);

    const before = (await invitationsOf(id)).length;
    const own = await invite(owner.cookie, id, [owner.email]);
    expect(own.status).toBe(409);
    expect((await own.json()).error.code).toBe('own_address');
    const known = await invite(owner.cookie, id, [invitee.email]);
    expect(known.status).toBe(409);
    expect((await known.json()).error.code).toBe('collaborator_address');
    expect(await invitationsOf(id)).toHaveLength(before);
  });

  it('refuses the Reviewer with a 422 (plan Q7), and a body that is not an invitation', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const reviewer = await invite(owner.cookie, id, ['someone@example.com'], 'reviewer');
    expect(reviewer.status).toBe(422);
    expect((await reviewer.json()).error.code).toBe('role_not_offered');
    expect((await invite(owner.cookie, id, ['not an address'])).status).toBe(422);
    const empty = await invite(owner.cookie, id, []);
    expect(empty.status).toBe(422);
    // The owner's words of 18 October 2026, written out here: what was not done comes first.
    expect((await empty.json()).error.message).toBe(
      'No invitation was created. Enter 1 to 10 email addresses, one on each line, and choose a role.',
    );
    expect(await invitationsOf(id)).toEqual([]);
  });
});

describe('answering an invitation (FR-ED-21, FR-ED-37)', () => {
  it('is for the account that holds the invited address as verified, and the link alone grants nothing', async () => {
    const owner = await person();
    const invitee = await person();
    const stranger = await person();
    const id = await documentOf(owner.cookie);
    const { token, row } = await sent(owner, id, invitee, 'viewer');

    // Weakening: accept by the token alone.
    for (const [cookie, answer] of [
      [stranger.cookie, 'accept'],
      [stranger.cookie, 'decline'],
      [owner.cookie, 'accept'],
    ] as const) {
      const refused = await answerByLink(cookie, token, answer);
      expect(refused.status).toBe(404);
      expect((await refused.json()).error.code).toBe('not_open_to_account');
    }
    expect((await answerById(stranger.cookie, row.id, 'accept')).status).toBe(404);
    // An account whose address is no longer verified holds it no more.
    await db().user.update({ where: { id: invitee.id }, data: { emailVerified: false } });
    expect((await answerByLink(invitee.cookie, token, 'accept')).status).toBe(404);
    await db().user.update({ where: { id: invitee.id }, data: { emailVerified: true } });
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(0);
    expect((await one.GET(request('GET', `/api/documents/${id}`, stranger.cookie), at({ id }))).status).toBe(
      404,
    );

    const accepted = await answerByLink(invitee.cookie, token, 'accept');
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ documentId: id });
    expect(
      await db().documentCollaborator.findMany({
        where: { documentId: id },
        select: { userId: true, role: true },
      }),
    ).toEqual([{ userId: invitee.id, role: 'VIEWER' }]);
    // NFR-SE-19: the change of the collaborators, with the user and the document.
    expect(await logged(id)).toContainEqual({ kind: 'collaborators_changed', userId: invitee.id });

    // FR-ED-19, FR-ED-39: the role is the one the invitation offered, read by
    // the one authorisation; a Viewer does not hold the content (weakening:
    // read every collaborator as an Editor).
    expect(await authorise(invitee.id, id, 'document.view')).toMatchObject({
      outcome: 'allowed',
      role: 'viewer',
    });
    expect(await authorise(invitee.id, id, 'document.content.edit')).toEqual({ outcome: 'forbidden' });
    // FR-ED-39: the Viewer reads the document and may not rename it (a 403, logged).
    expect((await one.GET(request('GET', `/api/documents/${id}`, invitee.cookie), at({ id }))).status).toBe(
      200,
    );
    const rename = await one.PATCH(
      request('PATCH', `/api/documents/${id}`, invitee.cookie, { title: 'Mine' }),
      at({ id }),
    );
    expect(rename.status).toBe(403);
    expect(await logged(id)).toContainEqual({ kind: 'forbidden', userId: invitee.id });
    // The list of documents shows it, without the controls of the Owner.
    const listed = await (await collection.GET(request('GET', '/api/documents', invitee.cookie))).json();
    expect(listed.documents).toEqual([expect.objectContaining({ id, canRename: false, canDelete: false })]);

    // Accepted once: the link is no longer open.
    const again = await answerByLink(invitee.cookie, token, 'accept');
    expect((await again.json()).error.code).toBe('no_longer_open');
    // The notification of an accepted invitation stays (FR-ED-42).
    expect((await listOf(invitee.cookie)).notifications).toHaveLength(1);
  });

  it('grants nothing for a declined, revoked, or expired invitation', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);

    const declining = await person();
    const declined = await sent(owner, id, declining);
    expect((await listOf(declining.cookie)).notifications).toHaveLength(1);
    expect((await answerById(declining.cookie, declined.row.id, 'decline')).status).toBe(200);
    // FR-ED-42: the notification goes with the pending state.
    expect((await listOf(declining.cookie)).notifications).toEqual([]);
    expect(await db().notification.count({ where: { recipientId: declining.id } })).toBe(0);

    const revoked = await person();
    const toRevoke = await sent(owner, id, revoked);
    expect((await revoke(owner.cookie, id, toRevoke.row.id)).status).toBe(200);
    expect(await db().notification.count({ where: { recipientId: revoked.id } })).toBe(0);
    expect((await revoke(owner.cookie, id, toRevoke.row.id)).status).toBe(404);

    const expiring = await person();
    const toExpire = await sent(owner, id, expiring);
    await db().documentInvitation.update({
      where: { id: toExpire.row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    // Left out of the list from the moment of expiry (S13-6).
    expect((await listOf(expiring.cookie)).notifications).toEqual([]);

    for (const [who, token] of [
      [declining, declined.token],
      [revoked, toRevoke.token],
      [expiring, toExpire.token],
    ] as const) {
      const response = await answerByLink(who.cookie, token, 'accept');
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe('no_longer_open');
    }
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(0);
  });

  it('sends again with a new link and revokes the pending one, without counting a person twice', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const first = await sent(owner, id, invitee);
    const response = await resend(owner.cookie, id, first.row.id);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ confirmations: [CONFIRMATION(invitee.email)] });
    await runLater();
    const rows = await invitationsOf(id);
    expect(rows.map(({ state }) => state)).toEqual(['REVOKED', 'PENDING']);
    expect((await (await peopleOf(owner.cookie, id)).json()).people).toBe(2);
    expect((await answerByLink(invitee.cookie, first.token, 'accept')).status).toBe(404);
    const second = tokenIn((await mailTo(invitee.email)).at(-1)!.text)!;
    expect(second).not.toBe(first.token);
    expect((await listOf(invitee.cookie)).notifications.map(({ invitationId }) => invitationId)).toEqual([
      rows[1]!.id,
    ]);
    expect((await answerByLink(invitee.cookie, second, 'accept')).status).toBe(200);
  });

  it('revokes the pending invitations of a deleted document and removes their notifications', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const { token } = await sent(owner, id, invitee);
    expect(
      (await one.DELETE(request('DELETE', `/api/documents/${id}`, owner.cookie), at({ id }))).status,
    ).toBe(204);
    expect((await invitationsOf(id)).map(({ state }) => state)).toEqual(['REVOKED']);
    expect(await db().notification.count({ where: { recipientId: invitee.id } })).toBe(0);
    expect((await answerByLink(invitee.cookie, token, 'accept')).status).toBe(404);
  });
});

describe('the limits', () => {
  it('holds a document to ten people, the Owner and pending invitations counted (FR-ED-37)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const nine = Array.from({ length: 9 }, (_, n) => `limit-${n}@example.com`);
    expect((await invite(owner.cookie, id, nine)).status).toBe(201);
    const refused = await invite(owner.cookie, id, ['tenth@example.com']);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toEqual({ code: 'people_limit', message: LIMIT });
    expect(await invitationsOf(id)).toHaveLength(9);
    // Sending one of the nine again replaces it, and passes.
    const [first] = await invitationsOf(id);
    expect((await resend(owner.cookie, id, first!.id)).status).toBe(201);
    expect(await (await peopleOf(owner.cookie, id)).json()).toMatchObject({ people: 10, limit: 10 });
  });

  it('lets no two requests at once pass ten together (weakening: no lock on the document row)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const five = (prefix: string) => Array.from({ length: 5 }, (_, n) => `${prefix}-${n}@example.com`);
    const statuses = (
      await Promise.all([invite(owner.cookie, id, five('a')), invite(owner.cookie, id, five('b'))])
    ).map((response) => response.status);
    expect(statuses.sort()).toEqual([201, 409]);
    expect(await invitationsOf(id)).toHaveLength(5);
  });

  it('refuses past the invitations of an hour with a 429, whole, and creates nothing (NFR-SE-07; S13-5)', async () => {
    const owner = await person();
    const [a, b] = [await documentOf(owner.cookie), await documentOf(owner.cookie)];
    expect(
      (
        await invite(
          owner.cookie,
          a,
          Array.from({ length: 9 }, (_, n) => `hour-a${n}@example.com`),
        )
      ).status,
    ).toBe(201);
    const over = await invite(
      owner.cookie,
      b,
      Array.from({ length: 4 }, (_, n) => `hour-b${n}@example.com`),
    );
    expect(over.status).toBe(429);
    expect(Number(over.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await invitationsOf(b)).toEqual([]);
    expect(
      (await invite(owner.cookie, b, ['hour-b0@example.com', 'hour-b1@example.com', 'hour-b2@example.com']))
        .status,
    ).toBe(201);
    expect((await invite(owner.cookie, b, ['hour-b3@example.com'])).status).toBe(429);
  });
});

describe('the permission to invite (FR-ED-39, FR-ED-44)', () => {
  it('refuses a Viewer and an Editor without it with a 403, logged, on every route of invitations', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const viewer = await person();
    const editor = await person();
    await sent(owner, id, viewer, 'viewer').then(({ token }) => answerByLink(viewer.cookie, token, 'accept'));
    await sent(owner, id, editor, 'editor').then(({ token }) => answerByLink(editor.cookie, token, 'accept'));
    expect((await invite(owner.cookie, id, ['pending@example.com'])).status).toBe(201);
    const [row] = await db().documentInvitation.findMany({ where: { documentId: id, state: 'PENDING' } });
    for (const who of [viewer, editor]) {
      expect((await invite(who.cookie, id, ['another@example.com'])).status).toBe(403);
      expect((await revoke(who.cookie, id, row!.id)).status).toBe(403);
      expect((await resend(who.cookie, id, row!.id)).status).toBe(403);
      expect(await logged(id)).toContainEqual({ kind: 'forbidden', userId: who.id });
      // The people they may see; the pending invitations they may not.
      const seen = await (await peopleOf(who.cookie, id)).json();
      expect(seen.invitations).toBeUndefined();
      expect(seen.collaborators).toHaveLength(2);
    }
  });

  it('refuses, with one rule, the address of any account that holds a role now, for an inviter who may see the people (the owner’s answer of 21 October 2026; weakening: refuse only an address that accepted an invitation, or only for the Owner)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const editor = await person();
    const viewer = await person();
    const outsider = await person();
    await sent(owner, id, editor).then(({ token }) => answerByLink(editor.cookie, token, 'accept'));
    await sent(owner, id, viewer, 'viewer').then(({ token }) => answerByLink(viewer.cookie, token, 'accept'));
    // A collaborator through no invitation at all: the rule follows the account, not the invitation.
    const carried = await person();
    await db().documentCollaborator.create({ data: { documentId: id, userId: carried.id, role: 'VIEWER' } });
    const set = defaultPermissionSet();
    set['document.collaborators.invite'].editor = true;
    await db().document.update({ where: { id }, data: { permissionSet: set } });
    const before = await invitationsOf(id);

    const refusal = `No invitation was created: the person at X already has access to this document.`;
    // The Owner's invitation of a collaborator, and the Editor's of the Owner and of another collaborator.
    for (const [who, address] of [
      [owner, viewer.email],
      [owner, carried.email],
      [editor, owner.email],
      [editor, viewer.email],
      [editor, carried.email],
    ] as const) {
      const refused = await invite(who.cookie, id, [address]);
      expect(refused.status).toBe(409);
      const { error } = await refused.json();
      expect(error.code).toBe('collaborator_address');
      expect(error.message.replace(address, 'X')).toBe(refusal);
    }
    // Whole: a request that names one such address among others creates none.
    expect((await invite(owner.cookie, id, ['fresh@example.com', viewer.email])).status).toBe(409);
    expect(await invitationsOf(id)).toHaveLength(before.length);
    // An address of no account, and of an account that holds no role, is invited as before.
    expect((await invite(owner.cookie, id, ['fresh@example.com', outsider.email])).status).toBe(201);
  });

  it('invites a person who has left the document, and a former Owner who has left, and refuses them while they hold a role (S17-12)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const editor = await person();
    await sent(owner, id, editor).then(({ token }) => answerByLink(editor.cookie, token, 'accept'));
    const collaboratorId = (await db().documentCollaborator.findFirstOrThrow({ where: { documentId: id } }))
      .id;
    // The Editor becomes the Owner by a transfer, and the former Owner holds a role: refused.
    const offered = await db().ownershipOffer.create({
      data: {
        documentId: id,
        fromUserId: owner.id,
        toUserId: editor.id,
        state: 'ACCEPTED',
        expiresAt: new Date(),
      },
    });
    await db().document.update({ where: { id }, data: { ownerId: editor.id } });
    await db().documentCollaborator.delete({ where: { id: collaboratorId } });
    await db().documentCollaborator.create({ data: { documentId: id, userId: owner.id, role: 'EDITOR' } });
    expect((await invite(editor.cookie, id, [owner.email])).status).toBe(409);
    // The former Owner leaves: the address is invited, delivered, and accepted.
    await db().documentCollaborator.deleteMany({ where: { documentId: id, userId: owner.id } });
    const { token } = await sent(editor, id, owner, 'editor');
    expect((await answerByLink(owner.cookie, token, 'accept')).status).toBe(200);
    expect(offered.state).toBe('ACCEPTED');
    expect(await db().documentCollaborator.count({ where: { documentId: id, userId: owner.id } })).toBe(1);
  });

  it('given to the Editor, who is shown no people, refuses only the Editor’s own address; the Owner’s gets an invitation that sends nothing and cannot be accepted (the answer stays uniform)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    const editor = await person();
    const { token } = await sent(owner, id, editor);
    await answerByLink(editor.cookie, token, 'accept');
    const set = defaultPermissionSet();
    set['document.collaborators.invite'].editor = true;
    set['document.collaborators.view'].editor = false;
    await db().document.update({ where: { id }, data: { permissionSet: set } });

    const own = await invite(editor.cookie, id, [editor.email]);
    expect((await own.json()).error.code).toBe('own_address');
    const ownerAddress = await invite(editor.cookie, id, [owner.email]);
    expect(ownerAddress.status).toBe(201);
    expect(await ownerAddress.json()).toEqual({ confirmations: [CONFIRMATION(owner.email)] });
    await runLater();
    expect(await mailTo(owner.email)).toEqual([]);
    expect(await db().notification.count({ where: { recipientId: owner.id } })).toBe(0);
    const [row] = await db().documentInvitation.findMany({ where: { documentId: id, email: owner.email } });
    const refused = await answerById(owner.cookie, row!.id, 'accept');
    expect((await refused.json()).error.code).toBe('not_open_to_account');
  });
});

describe('the notification list (FR-ED-42)', () => {
  it('is its recipient’s alone, with the unread count, and a notification is marked read and stays', async () => {
    const owner = await person();
    const invitee = await person();
    const other = await person();
    const id = await documentOf(owner.cookie);
    await sent(owner, id, invitee, 'viewer');
    const list = await listOf(invitee.cookie);
    expect(list.unread).toBe(1);
    expect(list.notifications).toEqual([
      expect.objectContaining({ read: false, inviterName: 'A Person', role: 'viewer' }),
    ]);
    expect(await listOf(other.cookie)).toEqual({ unread: 0, notifications: [] });
    const notificationId = list.notifications[0]!.id;
    // Weakening: mark by identifier alone.
    expect((await markRead(other.cookie, notificationId)).status).toBe(404);
    expect((await listOf(invitee.cookie)).unread).toBe(1);
    expect((await markRead(invitee.cookie, notificationId)).status).toBe(204);
    expect(await listOf(invitee.cookie)).toMatchObject({ unread: 0, notifications: [{ read: true }] });
  });

  it('checks the origin of a change first (D164)', async () => {
    const invitee = await person();
    const foreign = new Request(`${ORIGIN}/api/notifications/x`, {
      method: 'PATCH',
      headers: { origin: 'https://elsewhere.example', cookie: invitee.cookie },
    });
    expect((await notification.PATCH(foreign, at({ id: 'x' }))).status).toBe(403);
    const answering = new Request(`${ORIGIN}/api/invitations/x/accept`, {
      method: 'POST',
      headers: { origin: 'https://elsewhere.example', cookie: invitee.cookie },
    });
    expect((await byLink.POST(answering, at({ token: 'x', answer: 'accept' }))).status).toBe(403);
  });
});

/**
 * Makes the database refuse a write, as a fault of the database would, for
 * the length of `run`: a trigger, written by the administrator, that raises
 * on an insert into `table` where `condition` holds.
 */
async function refusing<T>(table: string, condition: string, run: () => Promise<T>): Promise<T> {
  database.sql(
    `CREATE FUNCTION refuse_for_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'refused for the test'; END $$;
     CREATE TRIGGER refuse_for_test BEFORE INSERT ON "${table}" FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION refuse_for_test();`,
  );
  const lines = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    return await run();
  } finally {
    lines.mockRestore();
    database.sql(`DROP TRIGGER refuse_for_test ON "${table}"; DROP FUNCTION refuse_for_test();`);
  }
}

describe('what the review of pull request 43 asked', () => {
  it('lets no one answer an invitation that was sent to no one, by its link or from the list (FR-ED-37)', async () => {
    const owner = await person();
    const id = await documentOf(owner.cookie);
    // An address that belongs to no account when it is invited, and later to a verified one.
    const later = `later-${randomUUID()}@example.com`;
    expect((await invite(owner.cookie, id, [later])).status).toBe(201);
    await runLater();
    const [row] = await db().documentInvitation.findMany({ where: { documentId: id, email: later } });
    expect(row!.emailClaimedAt).toBeNull();
    const account = await createAccount(auth, later);
    const cookie = cookiesOf(await signIn(auth, later));
    // Its token never left the server; a known one is written for the test.
    const token = 'U'.repeat(43);
    await db().documentInvitation.update({ where: { id: row!.id }, data: { tokenHash: hashToken(token) } });
    // Weakening: an open invitation that ignores whether it was sent.
    for (const answer of ['accept', 'decline']) {
      expect((await (await answerByLink(cookie, token, answer)).json()).error.code).toBe(
        'not_open_to_account',
      );
      expect((await (await answerById(cookie, row!.id, answer)).json()).error.code).toBe(
        'not_open_to_account',
      );
    }
    expect(await db().documentCollaborator.count({ where: { userId: account } })).toBe(0);
    expect((await db().documentInvitation.findUniqueOrThrow({ where: { id: row!.id } })).state).toBe(
      'PENDING',
    );
  });

  it('leaves no collaborator where the entry of the security log cannot be written (D163; plan test 14)', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const { token, row } = await sent(owner, id, invitee);
    // Weakening: the entry written outside the transaction of the acceptance.
    const response = await refusing('SecurityLogEntry', `NEW.kind = 'collaborators_changed'`, () =>
      answerByLink(invitee.cookie, token, 'accept'),
    );
    expect(response.status).toBe(500);
    expect(await db().documentCollaborator.count({ where: { documentId: id } })).toBe(0);
    expect((await db().documentInvitation.findUniqueOrThrow({ where: { id: row.id } })).state).toBe(
      'PENDING',
    );
    expect((await answerByLink(invitee.cookie, token, 'accept')).status).toBe(200);
  });

  it('revokes and sends again only the invitations of the document in the path', async () => {
    const owner = await person();
    const other = await person();
    const [a, b] = [await documentOf(owner.cookie), await documentOf(other.cookie)];
    expect((await invite(owner.cookie, a, ['cross@example.com'])).status).toBe(201);
    const [row] = await invitationsOf(a);
    // Weakening: an invitation found by its identifier alone.
    expect((await revoke(other.cookie, b, row!.id)).status).toBe(404);
    expect((await resend(other.cookie, b, row!.id)).status).toBe(404);
    expect((await invitationsOf(a)).map(({ state }) => state)).toEqual(['PENDING']);
    expect(await invitationsOf(b)).toEqual([]);
  });

  it('gives back the invitations of an hour that a failed transaction did not create (S13-5)', async () => {
    const owner = await person();
    const [a, b] = [await documentOf(owner.cookie), await documentOf(owner.cookie)];
    expect(
      (
        await invite(
          owner.cookie,
          a,
          Array.from({ length: 9 }, (_, n) => `back-a${n}@example.com`),
        )
      ).status,
    ).toBe(201);
    // Three that fail inside the transaction, after they were counted.
    const failed = await refusing('DocumentInvitation', `NEW.email = 'back-boom@example.com'`, () =>
      invite(owner.cookie, b, ['back-b0@example.com', 'back-boom@example.com', 'back-b1@example.com']),
    );
    expect(failed.status).toBe(500);
    expect(await invitationsOf(b)).toEqual([]);
    // Weakening: the count kept. Twelve in the hour remain possible: nine and these three.
    expect(
      (await invite(owner.cookie, b, ['back-b0@example.com', 'back-b1@example.com', 'back-b2@example.com']))
        .status,
    ).toBe(201);
    expect((await invite(owner.cookie, b, ['back-b3@example.com'])).status).toBe(429);
  });

  it('marks read only a notification the list shows (FR-ED-42)', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const { row } = await sent(owner, id, invitee);
    const [shown] = (await listOf(invitee.cookie)).notifications;
    await db().documentInvitation.update({
      where: { id: row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await markRead(invitee.cookie, shown!.id)).status).toBe(404);
  });

  it('names no account’s identifier among the people of a document', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    const { token } = await sent(owner, id, invitee);
    await answerByLink(invitee.cookie, token, 'accept');
    const text = await (await peopleOf(owner.cookie, id)).text();
    expect(text).not.toContain(invitee.id);
    expect(text).not.toContain(owner.id);
  });
});

describe('the delivery', () => {
  it('names the invitation and nothing of a person where an email cannot be handed over', async () => {
    const owner = await person();
    const invitee = await person();
    const id = await documentOf(owner.cookie);
    expect((await invite(owner.cookie, id, [invitee.email])).status).toBe(201);
    const [row] = await invitationsOf(id);
    later.tasks.splice(0);
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    await deliverInvitations(
      id,
      owner.id,
      [
        {
          id: row!.id,
          email: invitee.email,
          token: 'T'.repeat(43),
          role: 'editor',
          expiresAt: row!.expiresAt,
          pseudonym: null,
        },
      ],
      async () => {
        throw new Error(`refused for ${invitee.email}`);
      },
    );
    spy.mockRestore();
    expect(lines).toEqual([`invitation ${row!.id}: not delivered (Error)`]);
    // Marked before the hand-over, so never handed over again (FR-ED-21).
    expect(
      (await db().documentInvitation.findUniqueOrThrow({ where: { id: row!.id } })).emailClaimedAt,
    ).not.toBeNull();
  });
});
