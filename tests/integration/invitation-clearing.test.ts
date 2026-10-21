// The reminder and the clearing of addresses (FR-ED-48, FR-ED-37, FR-ED-42,
// FR-AU-89; NFR-RE-15, NFR-SE-19, §2.7): the timers' functions against a
// provisioned database, the real Valkey and the local email sink, with the
// clock a parameter of each, so that "exactly 3 days" and "exactly 30 days"
// are tested to the millisecond. Invitations are made through the routes, as a
// person makes them. Each test of a rule names the weakening that makes it fail.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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

const SINK = mkdtempSync(join(tmpdir(), 'ekdotico-clearing-mail-'));
const database = prepare('clearing', {
  EMAIL_SINK_DIRECTORY: SINK,
  RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600',
});
const { auth, db, valkey } = await load();
const { hashToken } = await import('../../src/lib/token.ts');
const { dateText } = await import('../../src/lib/date-text.ts');
const { remindInvitations, clearInvitationAddresses, deleteEndedInvitationNotifications } =
  await import('../../src/lib/documents/invitation-timers.ts');
const { clearAdmissionAddresses, createInvitation, listInvitations } =
  await import('../../src/lib/admission/invitations.ts');
const collection = await import('../../src/app/api/documents/route.ts');
const documentRoute = await import('../../src/app/api/documents/[id]/route.ts');
const inviting = await import('../../src/app/api/documents/[id]/invitations/route.ts');
const revoking = await import('../../src/app/api/documents/[id]/invitations/[invitationId]/route.ts');
const resending = await import('../../src/app/api/documents/[id]/invitations/[invitationId]/resend/route.ts');
const byId = await import('../../src/app/api/invitations/received/[invitationId]/[answer]/route.ts');
const notifications = await import('../../src/app/api/notifications/route.ts');
const notification = await import('../../src/app/api/notifications/[id]/route.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});
beforeEach(() => void later.tasks.splice(0));

const DAY = 24 * 60 * 60 * 1000;
const TITLE = 'Quartz-zebra-title-never-in-an-email';
const SUBJECT = 'Your invitation to a document in Ekdotico expires soon';

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
const answer = (cookie: string, invitationId: string, what: 'accept' | 'decline') =>
  byId.POST(
    request('POST', `/api/invitations/received/${invitationId}/${what}`, cookie),
    at({ invitationId, answer: what }),
  );
const listOf = async (cookie: string) =>
  (await notifications.GET(request('GET', '/api/notifications', cookie))).json() as Promise<{
    unread: number;
    notifications: Record<string, unknown>[];
  }>;

let count = 0;
async function person() {
  const email = `clearing${++count}@example.com`;
  const id = await createAccount(auth, email, true);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
async function documentOf(cookie: string): Promise<string> {
  const response = await collection.POST(request('POST', '/api/documents', cookie, {}));
  expect(response.status).toBe(201);
  const { id } = await response.json();
  await db().document.update({ where: { id }, data: { title: TITLE } });
  return id;
}
const mailTo = async (email: string) => (await sunk(SINK)).filter(({ to }) => to === email);
const remindersTo = async (email: string) =>
  (await mailTo(email)).filter(({ subject }) => subject === SUBJECT);
/** How many notifications of this person name this invitation (the invitation's own and its reminder). */
const naming = async (recipientId: string, invitationId: string) =>
  (await db().notification.findMany({ where: { recipientId } })).filter(
    ({ payload }) => (payload as { invitationId?: string }).invitationId === invitationId,
  ).length;
const reminderNotifications = (recipientId: string) =>
  db().notification.findMany({ where: { recipientId, kind: 'document_invitation_reminder' } });

/** An invitation sent to a new person, delivered (the row claimed, the notification written). */
async function sent(role = 'editor') {
  const owner = await person();
  const invitee = await person();
  const documentId = await documentOf(owner.cookie);
  expect((await invite(owner.cookie, documentId, [invitee.email], role)).status).toBe(201);
  await runLater();
  const row = await db().documentInvitation.findFirstOrThrow({ where: { documentId, email: invitee.email } });
  expect(row.emailClaimedAt).not.toBeNull();
  return { owner, invitee, documentId, row };
}
const rowOf = (id: string) => db().documentInvitation.findUniqueOrThrow({ where: { id } });

describe('the one reminder (FR-ED-48)', () => {
  it('goes at exactly 3 days before the expiry and not a millisecond before, by email and by notification', async () => {
    const { owner, invitee, row } = await sent();
    const due = row.expiresAt.getTime() - 3 * DAY;

    await remindInvitations(undefined, new Date(due - 1));
    expect(await remindersTo(invitee.email)).toHaveLength(0);
    expect((await rowOf(row.id)).reminderClaimedAt).toBeNull();

    await remindInvitations(undefined, new Date(due));
    const mails = await remindersTo(invitee.email);
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toBe(
      `A Person (${owner.email}) invited you to a document in Ekdotico as Editor. The invitation expires on ${dateText(row.expiresAt, 'utc')}. To accept or decline it, open your notifications in Ekdotico: ${ORIGIN}/notifications.`,
    );
    const rows = await reminderNotifications(invitee.id);
    expect(rows).toHaveLength(1);
    // FR-ED-42: it names the invitation and nothing else.
    expect(rows[0]!.payload).toEqual({ invitationId: row.id });
    expect((await rowOf(row.id)).reminderClaimedAt).not.toBeNull();
  });

  it('is never sent twice: not by a second run, not by two at once, not after a restart (weakening: drop the claim)', async () => {
    const { invitee, row } = await sent();
    const now = new Date(row.expiresAt.getTime() - 3 * DAY + 1000);
    await Promise.all([remindInvitations(undefined, now), remindInvitations(undefined, now)]);
    await remindInvitations(undefined, new Date(now.getTime() + 60 * 60 * 1000));
    // A restart is a new run of the same function against the same database, days later and on the last day.
    vi.resetModules();
    const again = await import('../../src/lib/documents/invitation-timers.ts');
    await again.remindInvitations(undefined, new Date(row.expiresAt.getTime() - 1000));
    expect(await remindersTo(invitee.email)).toHaveLength(1);
    expect(await reminderNotifications(invitee.id)).toHaveLength(1);
  });

  it('is claimed by one of two runs that reach the row together (weakening: the claim ignores the mark)', async () => {
    const { invitee, row } = await sent();
    const now = new Date(row.expiresAt.getTime() - 3 * DAY);
    let runs: Promise<number[]> = Promise.resolve([]);
    // Both runs read the row as unmarked, and both wait at the claim for the row this transaction holds.
    await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ekdotico"."DocumentInvitation" WHERE "id" = ${row.id} FOR UPDATE`;
      runs = Promise.all([remindInvitations(undefined, now), remindInvitations(undefined, now)]);
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await runs;
    expect(await remindersTo(invitee.email)).toHaveLength(1);
    expect(await reminderNotifications(invitee.id)).toHaveLength(1);
  });

  it('is sent a run late, never after the expiry: a process that was down catches up while the invitation is open', async () => {
    const { invitee, row } = await sent();
    await remindInvitations(undefined, new Date(row.expiresAt.getTime() - 1));
    expect(await remindersTo(invitee.email)).toHaveLength(1);

    const second = await sent();
    // At the expiry and after it the invitation is not pending: no reminder (weakening: remind an expired one).
    await remindInvitations(undefined, second.row.expiresAt);
    await remindInvitations(undefined, new Date(second.row.expiresAt.getTime() + 5 * DAY));
    expect(await remindersTo(second.invitee.email)).toHaveLength(0);
    expect((await rowOf(second.row.id)).reminderClaimedAt).toBeNull();
  });

  it("does not claim an invitation that expired while the run was going: the claim reads the clock, not the run's start (weakening: claim at the run's start)", async () => {
    const { invitee, row } = await sent();
    const expiresAt = new Date(Date.now() - 1000);
    await db().documentInvitation.update({
      where: { id: row.id },
      data: { createdAt: new Date(expiresAt.getTime() - 14 * DAY), expiresAt },
    });
    // The run began a day before the expiry, as a slow run of an hour's timer would have, and reaches the row now.
    await remindInvitations(undefined, new Date(expiresAt.getTime() - DAY));
    expect(await remindersTo(invitee.email)).toHaveLength(0);
    expect(await reminderNotifications(invitee.id)).toHaveLength(0);
    expect((await rowOf(row.id)).reminderClaimedAt).toBeNull();
  });

  it('is sent only while the invitation is pending: none for a revoked, accepted, or declined one', async () => {
    const revoked = await sent();
    expect((await revoke(revoked.owner.cookie, revoked.documentId, revoked.row.id)).status).toBe(200);
    const accepted = await sent();
    expect((await answer(accepted.invitee.cookie, accepted.row.id, 'accept')).status).toBe(200);
    const declined = await sent();
    expect((await answer(declined.invitee.cookie, declined.row.id, 'decline')).status).toBe(200);

    await remindInvitations(undefined, new Date(Date.now() + 12 * DAY));
    for (const { invitee, row } of [revoked, accepted, declined]) {
      expect(await remindersTo(invitee.email)).toHaveLength(0);
      expect(await reminderNotifications(invitee.id)).toHaveLength(0);
      expect((await rowOf(row.id)).reminderClaimedAt).toBeNull();
    }
  });

  it('is sent only for an invitation that was itself sent: none for an address with no account, or of a person who holds a role (weakening: remind every pending invitation)', async () => {
    const owner = await person();
    const holder = await person();
    const documentId = await documentOf(owner.cookie);
    const nobody = 'nobody-at-all-clearing@example.com';
    expect((await invite(owner.cookie, documentId, [nobody, holder.email])).status).toBe(201);
    // The person comes to hold a role between the invitation and its delivery: nothing is sent to them.
    await db().documentCollaborator.create({ data: { documentId, userId: holder.id, role: 'VIEWER' } });
    await runLater();
    const rows = await db().documentInvitation.findMany({ where: { documentId } });
    expect(rows).toHaveLength(2);
    expect(rows.every(({ emailClaimedAt }) => emailClaimedAt === null)).toBe(true);

    await remindInvitations(undefined, new Date(Date.now() + 12 * DAY));
    expect(await mailTo(nobody)).toHaveLength(0);
    expect(await mailTo(holder.email)).toHaveLength(0);
    expect(await reminderNotifications(holder.id)).toHaveLength(0);
    expect(
      (await db().documentInvitation.findMany({ where: { documentId } })).map((r) => r.reminderClaimedAt),
    ).toEqual([null, null]);
  });

  it('tells no one where the address no longer belongs to a verified account, and does not try again', async () => {
    const { invitee, row } = await sent();
    await db().user.update({ where: { id: invitee.id }, data: { emailVerified: false } });
    const now = new Date(row.expiresAt.getTime() - 2 * DAY);
    await remindInvitations(undefined, now);
    expect(await remindersTo(invitee.email)).toHaveLength(0);
    expect(await reminderNotifications(invitee.id)).toHaveLength(0);
    expect((await rowOf(row.id)).reminderClaimedAt).not.toBeNull();
    // Verified again, it is still not reminded: one reminder at most.
    await db().user.update({ where: { id: invitee.id }, data: { emailVerified: true } });
    await remindInvitations(undefined, now);
    expect(await remindersTo(invitee.email)).toHaveLength(0);
  });

  it('is its own for an invitation sent again, and the revoked one gets none', async () => {
    const { owner, invitee, documentId, row } = await sent();
    expect((await resend(owner.cookie, documentId, row.id)).status).toBe(201);
    await runLater();
    const fresh = await db().documentInvitation.findFirstOrThrow({
      where: { documentId, email: invitee.email, state: 'PENDING' },
    });
    expect(fresh.id).not.toBe(row.id);
    expect((await rowOf(row.id)).state).toBe('REVOKED');

    await remindInvitations(undefined, new Date(fresh.expiresAt.getTime() - 3 * DAY));
    expect(await remindersTo(invitee.email)).toHaveLength(1);
    expect((await rowOf(row.id)).reminderClaimedAt).toBeNull();
    expect((await rowOf(fresh.id)).reminderClaimedAt).not.toBeNull();
    expect((await reminderNotifications(invitee.id))[0]!.payload).toEqual({ invitationId: fresh.id });
  });

  it("holds no title, no token and no address but the invitee's in the email (weakening: put the title in the text)", async () => {
    const { owner, invitee, row } = await sent();
    await remindInvitations(undefined, new Date(row.expiresAt.getTime() - 3 * DAY));
    const [mail] = await remindersTo(invitee.email);
    expect(mail!.text).not.toContain(TITLE);
    expect(mail!.subject).not.toContain(TITLE);
    expect(mail!.text).not.toMatch(/\/invitations\/|\/documents\//);
    // The token of the invitation's own email never reappears.
    const original = (await mailTo(invitee.email)).find(({ subject }) => subject !== SUBJECT)!;
    const token = /\/invitations\/([A-Za-z0-9_-]{43})/.exec(original.text)![1]!;
    expect(hashToken(token)).toBe(row.tokenHash);
    expect(mail!.text).not.toContain(token);
    // And it tells the Owner nothing: the Owner is sent none.
    expect(await mailTo(owner.email)).toHaveLength(0);
  });

  it('is marked before the email is handed over, and a refused hand-over is not repeated, nor does its line hold an address', async () => {
    const { invitee, row } = await sent();
    const failing = vi.fn(async () => {
      throw Object.assign(new Error(`connect failed for ${invitee.email}`), { code: 'ECONNREFUSED' });
    });
    const lines: string[] = [];
    const log = vi
      .spyOn(console, 'error')
      .mockImplementation((line: unknown) => void lines.push(String(line)));
    const now = new Date(row.expiresAt.getTime() - 3 * DAY);
    await remindInvitations(failing, now);
    expect(failing).toHaveBeenCalledTimes(1);
    // The claim was there before the send was made.
    expect((await rowOf(row.id)).reminderClaimedAt).not.toBeNull();
    await remindInvitations(failing, now);
    expect(failing).toHaveBeenCalledTimes(1);
    log.mockRestore();
    expect(lines).toEqual([`invitation ${row.id}: reminder not delivered (Error ECONNREFUSED)`]);
    expect(lines.join('')).not.toContain(invitee.email);
    // The notification, written with the claim, stands.
    expect(await reminderNotifications(invitee.id)).toHaveLength(1);
  });

  it('is not sent to an invitation created after the moment of its reminder (a period under 3 days)', async () => {
    const { invitee, row } = await sent();
    // As if the setting had been 2 days: the invitation was created 2 days before its expiry.
    await db().documentInvitation.update({
      where: { id: row.id },
      data: { createdAt: new Date(row.expiresAt.getTime() - 2 * DAY) },
    });
    await remindInvitations(undefined, new Date(row.expiresAt.getTime() - 1000));
    expect(await remindersTo(invitee.email)).toHaveLength(0);
    // The moment itself is not "after": created exactly 3 days before, it is reminded.
    await db().documentInvitation.update({
      where: { id: row.id },
      data: { createdAt: new Date(row.expiresAt.getTime() - 3 * DAY) },
    });
    await remindInvitations(undefined, new Date(row.expiresAt.getTime() - 1000));
    expect(await remindersTo(invitee.email)).toHaveLength(1);
  });
});

describe('the reminder in the one list (FR-ED-42)', () => {
  it('is listed with the role, the inviter and the expiry and no title, can be read, and stays at an acceptance', async () => {
    const { owner, invitee, row } = await sent('viewer');
    await remindInvitations(undefined, new Date(row.expiresAt.getTime() - 3 * DAY));
    const before = await listOf(invitee.cookie);
    expect(before.notifications.map(({ kind }) => kind).sort()).toEqual([
      'document_invitation',
      'document_invitation_reminder',
    ]);
    expect(before.unread).toBe(2);
    const reminder = before.notifications.find(({ kind }) => kind === 'document_invitation_reminder')!;
    expect(reminder).toMatchObject({
      invitationId: row.id,
      inviterName: 'A Person',
      inviterEmail: owner.email,
      role: 'viewer',
      expiresAt: row.expiresAt.toISOString(),
    });
    // The reminder names the sender by name and address, and no title (S18-4) and no pseudonym.
    expect(JSON.stringify(reminder)).not.toContain(TITLE);

    const marked = await notification.PATCH(
      request('PATCH', `/api/notifications/${reminder.id}`, invitee.cookie),
      at({ id: reminder.id as string }),
    );
    expect(marked.status).toBe(204);
    expect((await listOf(invitee.cookie)).unread).toBe(1);
    // Nobody else sees it.
    expect((await listOf(owner.cookie)).notifications).toHaveLength(0);

    expect((await answer(invitee.cookie, row.id, 'accept')).status).toBe(200);
    expect((await listOf(invitee.cookie)).notifications).toHaveLength(2);
  });

  it('states no expiry once the invitation was accepted, and states it before (S18-2)', async () => {
    const { invitee, row } = await sent();
    await remindInvitations(undefined, new Date(row.expiresAt.getTime() - 3 * DAY));
    const reminderOf = async () =>
      (await listOf(invitee.cookie)).notifications.find(
        ({ kind }) => kind === 'document_invitation_reminder',
      )!;
    expect(await reminderOf()).toMatchObject({ expiresAt: row.expiresAt.toISOString() });
    expect((await answer(invitee.cookie, row.id, 'accept')).status).toBe(200);
    expect(await reminderOf()).toMatchObject({ invitationId: row.id, expiresAt: null });
  });

  /** An invitation sent and reminded, and the reminder's notification as the database holds it. */
  async function reminded() {
    const made = await sent();
    await remindInvitations(undefined, new Date(made.row.expiresAt.getTime() - 3 * DAY));
    expect(await reminderNotifications(made.invitee.id)).toHaveLength(1);
    return made;
  }

  it("goes with a revocation, as the invitation's own does", async () => {
    const { owner, invitee, documentId, row } = await reminded();
    expect((await revoke(owner.cookie, documentId, row.id)).status).toBe(200);
    expect(await db().notification.count({ where: { recipientId: invitee.id } })).toBe(0);
    expect((await listOf(invitee.cookie)).notifications).toEqual([]);
  });

  it("goes with a decline, as the invitation's own does", async () => {
    const { invitee, row } = await reminded();
    expect((await answer(invitee.cookie, row.id, 'decline')).status).toBe(200);
    expect(await db().notification.count({ where: { recipientId: invitee.id } })).toBe(0);
    expect((await listOf(invitee.cookie)).notifications).toEqual([]);
  });

  it('goes with the sending again of the invitation: the new one is reminded later, the old reminder is gone', async () => {
    const { owner, invitee, documentId, row } = await reminded();
    expect((await resend(owner.cookie, documentId, row.id)).status).toBe(201);
    await runLater();
    expect(await reminderNotifications(invitee.id)).toHaveLength(0);
    expect(await naming(invitee.id, row.id)).toBe(0);
    const list = (await listOf(invitee.cookie)).notifications;
    expect(list.map(({ kind }) => kind)).toEqual(['document_invitation']);
  });

  it('goes with the deletion of the document (DELETE /api/documents/:id)', async () => {
    const { owner, invitee, documentId, row } = await reminded();
    const deleting = await documentRoute.DELETE(
      request('DELETE', `/api/documents/${documentId}`, owner.cookie),
      at({ id: documentId }),
    );
    expect(deleting.status).toBe(204);
    expect((await db().document.findUniqueOrThrow({ where: { id: documentId } })).deletedAt).not.toBeNull();
    expect(await naming(invitee.id, row.id)).toBe(0);
    expect(await reminderNotifications(invitee.id)).toHaveLength(0);
    expect((await listOf(invitee.cookie)).notifications).toEqual([]);
  });
});

describe("the clearing of a document invitation's address (FR-ED-37, §2.7)", () => {
  /** A row of an invitation in `state`, ended at `endedAt`, with an address. */
  async function ended(state: 'DECLINED' | 'REVOKED' | 'EXPIRED' | 'PENDING' | 'ACCEPTED', endedAt: Date) {
    const { owner, invitee, documentId, row } = await sent();
    const when =
      state === 'DECLINED' || state === 'REVOKED' || state === 'ACCEPTED'
        ? { state, respondedAt: endedAt }
        : { state, expiresAt: endedAt };
    await db().documentInvitation.update({ where: { id: row.id }, data: when });
    return { owner, invitee, documentId, id: row.id };
  }

  it.each(['DECLINED', 'REVOKED', 'EXPIRED', 'PENDING'] as const)(
    'clears a %s invitation at exactly 30 days and not a millisecond before (weakening: 29 days, or after the creation)',
    async (state) => {
      const endedAt = new Date(Date.now() - 40 * DAY);
      const { invitee, id } = await ended(state, endedAt);
      const period = endedAt.getTime() + 30 * DAY;

      // The invitee holds a notification that names the invitation, which the timer of S13-6 then deletes
      // (weakening: the timer keeps what it should delete).
      expect(await naming(invitee.id, id)).toBe(1);
      await deleteEndedInvitationNotifications(new Date(period - 1));
      expect(await naming(invitee.id, id)).toBe(0);

      await clearInvitationAddresses(new Date(period - 1));
      expect((await rowOf(id)).email).toBe(invitee.email);

      expect(await clearInvitationAddresses(new Date(period))).toBeGreaterThanOrEqual(1);
      const row = await rowOf(id);
      expect(row.email).toBeNull();
      // The row stays, with all the rest; a pending row that long past its expiry is an expired one.
      expect(row.state).toBe(state === 'PENDING' ? 'EXPIRED' : state);
      expect(row.tokenHash).toBeTruthy();
      expect(row.role).toBe('EDITOR');
      // What is left holds no address: not the row, not the log (NFR-SE-19), and no notification names
      // the invitation, so nothing leads from the person to the row.
      expect(JSON.stringify(row)).not.toContain(invitee.email);
      expect(await naming(invitee.id, id)).toBe(0);
      expect(
        JSON.stringify(await db().securityLogEntry.findMany({ where: { documentId: row.documentId } })),
      ).not.toContain(invitee.email);
    },
  );

  it('deletes the notifications that name the rows it clears, whatever the notification timer has done (defence in depth)', async () => {
    const endedAt = new Date(Date.now() - 40 * DAY);
    const rows = await Promise.all(
      (['DECLINED', 'REVOKED', 'EXPIRED', 'PENDING'] as const).map((s) => ended(s, endedAt)),
    );
    for (const { invitee, id } of rows) expect(await naming(invitee.id, id)).toBe(1);
    await clearInvitationAddresses(new Date());
    for (const { invitee, id } of rows) expect(await naming(invitee.id, id)).toBe(0);
  });

  it('never clears a pending invitation that is open, an expired one inside its 30 days, or an accepted one (weakening: clear an accepted invitation)', async () => {
    const open = await sent();
    const recent = await ended('EXPIRED', new Date(Date.now() - 10 * DAY));
    const accepted = await ended('ACCEPTED', new Date(Date.now() - 400 * DAY));
    const declined = await ended('DECLINED', new Date(Date.now() - 29 * DAY));
    const now = new Date();
    await clearInvitationAddresses(now);
    await clearInvitationAddresses(new Date(now.getTime() + 20 * DAY));
    expect((await rowOf(open.row.id)).email).toBe(open.invitee.email);
    expect((await rowOf(recent.id)).email).toBeNull(); // 10 + 20 days ago is past its 30
    expect((await rowOf(accepted.id)).email).toBe(accepted.invitee.email);
    expect((await rowOf(declined.id)).email).toBeNull();
    // The open one is open still at 20 days on, and is cleared only 30 days after its expiry.
    const away = new Date(open.row.expiresAt.getTime() + 30 * DAY);
    await clearInvitationAddresses(new Date(away.getTime() - 1));
    expect((await rowOf(open.row.id)).email).toBe(open.invitee.email);
    await clearInvitationAddresses(away);
    expect((await rowOf(open.row.id)).email).toBeNull();
    expect((await rowOf(accepted.id)).email).toBe(accepted.invitee.email);
  });

  it('is idempotent and safe on two at once, and a run after days of downtime clears every row that ended before, once each', async () => {
    const rows = await Promise.all(
      [100, 60, 45].map((days) => ended('REVOKED', new Date(Date.now() - days * DAY))),
    );
    const now = new Date();
    const [a, b] = await Promise.all([clearInvitationAddresses(now), clearInvitationAddresses(now)]);
    expect(a + b).toBeGreaterThanOrEqual(3);
    expect(await clearInvitationAddresses(now)).toBe(0);
    for (const { id } of rows) expect((await rowOf(id)).email).toBeNull();
  });

  it("leaves a row nobody can send again or accept, and the Owner's list without it", async () => {
    const { owner, invitee, documentId, id } = await ended('REVOKED', new Date(Date.now() - 31 * DAY));
    await clearInvitationAddresses(new Date());
    expect((await resend(owner.cookie, documentId, id)).status).toBe(404);
    expect((await answer(invitee.cookie, id, 'accept')).status).toBe(404);
    expect((await rowOf(id)).state).toBe('REVOKED');
  });
});

describe("the clearing of an admission invitation's address (FR-AU-89, §2.7)", () => {
  const addressOf = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;
  async function admission(state: 'REVOKED' | 'EXPIRED' | 'PENDING' | 'ACCEPTED', endedAt: Date) {
    const email = addressOf(state.toLowerCase());
    const row = await db().admissionInvitation.create({
      data: {
        email,
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        state,
        expiresAt:
          state === 'REVOKED' || state === 'ACCEPTED' ? new Date(endedAt.getTime() + 20 * DAY) : endedAt,
        revokedAt: state === 'REVOKED' ? endedAt : null,
        acceptedAt: state === 'ACCEPTED' ? endedAt : null,
      },
    });
    return { id: row.id, email };
  }
  const emailOf = async (id: string) =>
    (await db().admissionInvitation.findUniqueOrThrow({ where: { id } })).email;

  it.each(['REVOKED', 'EXPIRED', 'PENDING'] as const)(
    'clears a %s invitation at exactly 30 days after it ended, and not before',
    async (state) => {
      const endedAt = new Date(Date.now() - 40 * DAY);
      const { id, email } = await admission(state, endedAt);
      const period = endedAt.getTime() + 30 * DAY;
      await clearAdmissionAddresses(new Date(period - 1));
      expect(await emailOf(id)).toBe(email);
      await clearAdmissionAddresses(new Date(period));
      expect(await emailOf(id)).toBeNull();
      const row = await db().admissionInvitation.findUniqueOrThrow({ where: { id } });
      expect(row.state).toBe(state === 'PENDING' ? 'EXPIRED' : state);
      expect(JSON.stringify(row)).not.toContain(email);
    },
  );

  it('counts a revocation from its own day, not from the creation or the expiry (weakening: count from the expiry)', async () => {
    // Revoked 10 days ago, though it would have expired 100 days ago: the 30 days are the revocation's.
    const email = addressOf('late');
    const row = await db().admissionInvitation.create({
      data: {
        email,
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        state: 'REVOKED',
        createdAt: new Date(Date.now() - 130 * DAY),
        expiresAt: new Date(Date.now() - 100 * DAY),
        revokedAt: new Date(Date.now() - 10 * DAY),
      },
    });
    await clearAdmissionAddresses(new Date());
    expect(await emailOf(row.id)).toBe(email);
  });

  it('keeps the address of an accepted invitation and of an open one, and is idempotent and safe on two at once', async () => {
    const accepted = await admission('ACCEPTED', new Date(Date.now() - 400 * DAY));
    const open = await db().admissionInvitation.create({
      data: {
        email: addressOf('open'),
        tokenHash: randomUUID(),
        requestId: randomUUID(),
        expiresAt: new Date(Date.now() + 5 * DAY),
      },
    });
    const old = await admission('REVOKED', new Date(Date.now() - 90 * DAY));
    const now = new Date();
    const [a, b] = await Promise.all([clearAdmissionAddresses(now), clearAdmissionAddresses(now)]);
    expect(a + b).toBeGreaterThanOrEqual(1);
    expect(await clearAdmissionAddresses(now)).toBe(0);
    expect(await emailOf(accepted.id)).toBe(accepted.email);
    expect(await emailOf(open.id)).toBe(open.email);
    expect(await emailOf(old.id)).toBeNull();
  });

  it('is absent from the list afterwards, and a new invitation to the address then works', async () => {
    const { id, email } = await admission('EXPIRED', new Date(Date.now() - 31 * DAY));
    await clearAdmissionAddresses(new Date());
    const listed = (await listInvitations()).find((invitation) => invitation.id === id)!;
    expect(listed).toMatchObject({ id, state: 'expired' });
    expect(listed).not.toHaveProperty('email');
    const created = await createInvitation({ email, requestId: randomUUID() });
    expect(created.outcome).toBe('created');
  });
});

describe('the notifications of invitations that are no longer open (S13-6)', () => {
  it('deletes those of an expired invitation, its reminder among them, and of one that is gone, and leaves the rest', async () => {
    const live = await sent();
    await remindInvitations(undefined, new Date(live.row.expiresAt.getTime() - 3 * DAY));
    const accepted = await sent();
    expect((await answer(accepted.invitee.cookie, accepted.row.id, 'accept')).status).toBe(200);
    const expired = await sent();
    await remindInvitations(undefined, new Date(expired.row.expiresAt.getTime() - 3 * DAY));
    expect(await db().notification.count({ where: { recipientId: expired.invitee.id } })).toBe(2);
    await db().documentInvitation.update({
      where: { id: expired.row.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const orphan = await db().notification.create({
      data: { recipientId: live.invitee.id, kind: 'document_invitation', payload: { invitationId: 'gone' } },
    });
    const other = await db().notification.create({
      data: { recipientId: expired.invitee.id, kind: 'removed', payload: { documentId: expired.documentId } },
    });

    // At least these three: the notifications that earlier tests of this file left behind go too.
    expect(await deleteEndedInvitationNotifications(new Date())).toBeGreaterThanOrEqual(3);
    expect(
      await db().notification.count({ where: { recipientId: expired.invitee.id, kind: { not: 'removed' } } }),
    ).toBe(0);
    expect(await db().notification.findUnique({ where: { id: orphan.id } })).toBeNull();
    // A live invitation's two, an accepted one's, and a notification of another kind stay.
    expect(await db().notification.count({ where: { recipientId: live.invitee.id } })).toBe(2);
    expect(await db().notification.count({ where: { recipientId: accepted.invitee.id } })).toBe(1);
    expect(await db().notification.findUnique({ where: { id: other.id } })).not.toBeNull();
    // Idempotent.
    expect(await deleteEndedInvitationNotifications(new Date())).toBe(0);
  });
});
