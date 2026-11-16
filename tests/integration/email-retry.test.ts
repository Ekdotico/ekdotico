// The retry of the emails of a document (D263, D267; NFR-RE-15; FR-ED-21, FR-ED-48, FR-ED-47, FR-AU-91, FR-AU-92,
// FR-AU-58 (a); NFR-SE-19), against a provisioned database. The sender is a fake that fails the way the test says:
// nothing here reaches Brevo, and `fetch` fails the test where it is called. Each test of a rule names the
// weakening that makes it fail.
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccount, load, ORIGIN, prepare } from './identity.ts';

const database = prepare('emailretry');
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { createInvitations, deliverInvitations } = await import('../../src/lib/documents/sharing.ts');
const { remindInvitations } = await import('../../src/lib/documents/invitation-timers.ts');
const { deliverOffer } = await import('../../src/lib/documents/ownership.ts');
const { deliverBatch } = await import('../../src/lib/account/transfer-email.ts');
const { deliverClearingEmails } = await import('../../src/lib/clearing/email.ts');
const { CLEARING_NOTICE } = await import('../../src/lib/clearing/notices.ts');
const { MessageRefused, MessageSentAlready } = await import('../../src/lib/email/index.ts');
const { sendOrQueue } = await import('../../src/lib/email/queue.ts');
const { retryEmails } = await import('../../src/lib/email/retry.ts');

const fetchMock = vi.fn(async () => {
  throw new Error('fetch was called: a test reached for the network');
});
vi.stubGlobal('fetch', fetchMock);

afterAll(async () => {
  vi.unstubAllGlobals();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

type Mail = { to: string; subject: string; text: string };
const DAY = 24 * 60 * 60 * 1000;

// What the sender throws, by the code it puts on its faults (src/lib/email/index.ts).
const fault = (code?: string) =>
  Object.assign(new Error('The service did not answer well.'), code ? { code } : {});
const NOT_TAKEN = () => fault('401');
const failing = (make: () => Error) => async () => {
  throw make();
};
const collecting = () => {
  const mails: Mail[] = [];
  return { mails, send: async (mail: Mail) => void mails.push(mail) };
};

let logged: ReturnType<typeof vi.spyOn>[];
beforeEach(async () => {
  await db().emailRetry.deleteMany();
  fetchMock.mockClear();
  logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  // NFR-SE-19, in every test: no address, link or word of an email in a line, and the network untouched.
  const output = JSON.stringify(logged.flatMap((spy) => spy.mock.calls));
  expect(output).not.toMatch(/@example|https?:|\/notifications|\/invitations|invited you|offered you/);
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

// ── What the tests make ─────────────────────────────────────────────────────

let count = 0;
async function person() {
  const email = `retry${++count}.${randomUUID().slice(0, 6)}@example.com`;
  return { id: await createAccount(auth, email), email };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An invitation created and first delivered by a sender that fails as `first` says. */
async function invitation(first: (mail: Mail) => Promise<void>, who?: { owner: Person; guest: Person }) {
  const owner = who?.owner ?? (await person());
  const guest = who?.guest ?? (await person());
  const document = await createDocument(owner.id);
  const made = await createInvitations(
    { id: document.id, ownerId: owner.id },
    owner.id,
    [guest.email],
    'editor',
  );
  if (made.outcome !== 'created') throw new Error(made.outcome);
  const [one] = made.invitations;
  await deliverInvitations(document.id, owner.id, made.invitations, first);
  return { owner, guest, document, one: one! };
}
const rows = () => db().emailRetry.findMany();
const notifications = (userId: string) => db().notification.count({ where: { recipientId: userId } });

async function offer(owner: Person, to: Person, batchId: string | null = null) {
  const document = await createDocument(owner.id);
  return db().ownershipOffer.create({
    data: {
      documentId: document.id,
      fromUserId: owner.id,
      toUserId: to.id,
      expiresAt: new Date(Date.now() + 7 * DAY),
      batchId,
    },
  });
}

async function clearing(owner: Person, to: Person) {
  const document = await createDocument(owner.id);
  const created = await db().documentClearing.create({
    data: {
      userId: owner.id,
      scope: 'ALL',
      documentIds: [document.id],
      sharedDocumentIds: [document.id],
      requestedAt: new Date(Date.now() - DAY),
      deleteSharedAt: new Date(Date.now() + 7 * DAY),
    },
  });
  await db().notification.create({
    data: { recipientId: to.id, kind: CLEARING_NOTICE, payload: { clearingId: created.id } },
  });
  return created;
}

// ── Each email, tried again once ────────────────────────────────────────────

describe('an email that the service certainly did not take is tried again, and delivered once', () => {
  // Mutation R01: the row is not written where the service certainly did not take the email.
  it('the invitation: a row of kind, subject and account, and then one email, to the notification list', async () => {
    const { guest, one } = await invitation(failing(NOT_TAKEN));
    const waiting = await rows();
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({ kind: 'INVITATION', subjectId: one.id, userId: guest.id });
    const notified = await notifications(guest.id);
    expect(notified).toBe(1);

    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(1);
    const mail = sink.mails[0]!;
    expect(mail.to).toBe(guest.email);
    expect(mail.subject).toBe('You have been invited to a document | Ekdotico');
    // Its own link is stored only as a hash: the link is the notification list, as the reminder's is.
    expect(mail.text).toContain(`open this link: ${ORIGIN}/notifications.`);
    expect(mail.text).not.toContain('/invitations/');
    expect(mail.text).not.toContain(one.token);
    expect(await rows()).toHaveLength(0);
    // The notification is written once.
    expect(await notifications(guest.id)).toBe(notified);

    // And once only: a later run finds nothing.
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(1);
  });

  it('the invitation keeps the pseudonym of a hidden title, and no title', async () => {
    const owner = await person();
    const guest = await person();
    const document = await createDocument(owner.id);
    const made = await createInvitations(
      { id: document.id, ownerId: owner.id },
      owner.id,
      [guest.email],
      'viewer',
      new Date(),
      true,
    );
    if (made.outcome !== 'created') throw new Error(made.outcome);
    await deliverInvitations(document.id, owner.id, made.invitations, failing(NOT_TAKEN));
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(1);
    expect(sink.mails[0]!.text).toContain(`In Ekdotico it is shown as ${made.invitations[0]!.pseudonym}.`);
  });

  it('the reminder', async () => {
    const { guest, one } = await invitation(async () => {});
    // Past the day of its reminder.
    await db().documentInvitation.update({
      where: { id: one.id },
      data: { createdAt: new Date(Date.now() - 20 * DAY), expiresAt: new Date(Date.now() + DAY) },
    });
    await remindInvitations(failing(NOT_TAKEN));
    expect(await rows()).toMatchObject([{ kind: 'REMINDER', subjectId: one.id, userId: guest.id }]);
    const notified = await notifications(guest.id);

    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails.map((m) => m.subject)).toEqual([
      'Your invitation to a document in Ekdotico expires soon',
    ]);
    expect(sink.mails[0]!.to).toBe(guest.email);
    expect(await notifications(guest.id)).toBe(notified);
    // The reminder is claimed: a run of the reminder sends no second one.
    await remindInvitations(sink.send);
    expect(sink.mails).toHaveLength(1);
  });

  it('the offer of ownership', async () => {
    const owner = await person();
    const to = await person();
    const made = await offer(owner, to);
    await deliverOffer(made.id, failing(NOT_TAKEN));
    expect(await rows()).toMatchObject([{ kind: 'OFFER', subjectId: made.id, userId: to.id }]);
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails.map((m) => [m.to, m.subject])).toEqual([
      [to.email, 'An offer of ownership of a document in Ekdotico'],
    ]);
    expect(await rows()).toHaveLength(0);
  });

  it('the one email of a transfer of all documents, counting the offers still open', async () => {
    const owner = await person();
    const to = await person();
    const batchId = randomUUID();
    await offer(owner, to, batchId);
    const ended = await offer(owner, to, batchId);
    await offer(owner, to, batchId);
    await deliverBatch(batchId, to.id, failing(NOT_TAKEN));
    expect(await rows()).toMatchObject([{ kind: 'OFFER_BATCH', subjectId: batchId, userId: to.id }]);
    // One of the three ended in the meantime: it is not counted.
    await db().ownershipOffer.update({ where: { id: ended.id }, data: { state: 'DECLINED' } });
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails.map((m) => m.subject)).toEqual(['An offer of ownership of 2 documents in Ekdotico']);
  });

  it('the notice of a clearing, until the clearing has run', async () => {
    const owner = await person();
    const to = await person();
    const made = await clearing(owner, to);
    await deliverClearingEmails(made.id, failing(NOT_TAKEN));
    expect(await rows()).toMatchObject([{ kind: 'CLEARING', subjectId: made.id, userId: to.id }]);
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails.map((m) => [m.to, m.subject])).toEqual([
      [to.email, 'Documents you have access to in Ekdotico will be deleted'],
    ]);

    // Run again: the clearing has run, so the row that failed again is dropped, not tried.
    const other = await person();
    const second = await clearing(owner, other);
    await deliverClearingEmails(second.id, failing(NOT_TAKEN));
    await db().documentClearing.update({ where: { id: second.id }, data: { completedAt: new Date() } });
    const none = collecting();
    await retryEmails(none.send);
    expect(none.mails).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });
});

// ── Only where the service certainly did not take it ────────────────────────

describe('which faults wait', () => {
  const CERTAIN = [
    '401',
    '402',
    '403',
    '429',
    '400_CREDITS',
    '400_KEY',
    '400_DOMAIN',
    'ECONNREFUSED',
    'ENOTFOUND',
  ];
  // Mutation R02: a timeout, a broken connection or a 5xx is tried again, and a second send is a second email.
  const UNKNOWN: [string, () => Error][] = [
    ['a 500', () => fault('500')],
    ['a 503', () => fault('503')],
    ['a timeout', () => fault('Timeout')],
    ['a connect timeout', () => fault('UND_ERR_CONNECT_TIMEOUT')],
    ['a broken connection', () => fault('ECONNRESET')],
    ['a 400 of no listed reason', () => fault('400')],
    ['a fault of no code', () => fault()],
    [
      'a message the service refuses',
      () => Object.assign(new MessageRefused('refused'), { code: 'INVALID' }),
    ],
    ['a message it has seen', () => Object.assign(new MessageSentAlready('seen'), { code: 'DUPLICATE' })],
  ];

  it.each(CERTAIN)('after %s a row is written, and the fault still reaches the caller', async (code) => {
    const { guest } = await person().then(async (owner) => ({ guest: await person(), owner }));
    const made = await offer(await person(), guest);
    await expect(
      sendOrQueue(
        failing(() => fault(code)),
        { to: guest.email, subject: 's', text: 't' },
        { kind: 'OFFER', subjectId: made.id, userId: guest.id },
      ),
    ).rejects.toMatchObject({ code });
    expect(await rows()).toHaveLength(1);
  });

  it.each(UNKNOWN)('after %s nothing is written, and nothing is sent again', async (_name, make) => {
    const { guest, one } = await invitation(failing(make));
    expect(one.id).toBeTruthy();
    expect(await rows()).toHaveLength(0);
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
    expect(guest.id).toBeTruthy();
  });

  it('a retry that again certainly fails waits for the next run, once; any other fault ends it', async () => {
    await invitation(failing(NOT_TAKEN));
    await retryEmails(failing(NOT_TAKEN));
    expect(await rows()).toHaveLength(1);
    await retryEmails(failing(() => fault('429')));
    expect(await rows()).toHaveLength(1);
    // The service did not answer: unknown, so it is not sent a second time, and not tried at the next run.
    const unknown = vi.fn(failing(() => fault('Timeout')));
    await retryEmails(unknown);
    expect(unknown).toHaveBeenCalledTimes(1);
    expect(await rows()).toHaveLength(0);
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
  });
});

// ── No second send ──────────────────────────────────────────────────────────

describe('no email is sent twice', () => {
  // Mutation R03: the row is read, sent, and removed afterwards, or removed without matching the one row.
  it('four workers on six rows: each email is sent once', async () => {
    const guests: string[] = [];
    for (let each = 0; each < 6; each++) guests.push((await invitation(failing(NOT_TAKEN))).guest.email);
    const sink = collecting();
    const slow = async (mail: Mail) => {
      await sleep(30);
      await sink.send(mail);
    };
    await Promise.all([retryEmails(slow), retryEmails(slow), retryEmails(slow), retryEmails(slow)]);
    // Each of the six once, however the four workers fell among them.
    expect(sink.mails.map((mail) => mail.to).sort()).toEqual([...guests].sort());
    expect(await rows()).toHaveLength(0);
  });

  it('a process that stops after it took the row and before the answer loses that email and sends none again', async () => {
    await invitation(failing(NOT_TAKEN));
    // The first attempt: the row is gone before the sender is asked, and the process then stops.
    await expect(
      retryEmails(async () => {
        expect(await rows()).toHaveLength(0);
        throw new Error('the process stopped');
      }),
    ).resolves.toBe(0);
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
  });

  it('a fault before the email is made leaves the row for the next run: nothing was handed over', async () => {
    const { one } = await invitation(failing(NOT_TAKEN));
    const broken = vi.spyOn(db().user, 'findUnique').mockRejectedValueOnce(fault('P1001'));
    const sink = collecting();
    await retryEmails(sink.send);
    broken.mockRestore();
    expect(sink.mails).toHaveLength(0);
    expect(await rows()).toMatchObject([{ kind: 'INVITATION', subjectId: one.id }]);
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(1);
  });

  it('the same email waits once, however often it failed', async () => {
    const { one, guest } = await invitation(failing(NOT_TAKEN));
    const ref = { kind: 'INVITATION' as const, subjectId: one.id, userId: guest.id };
    await sendOrQueue(failing(NOT_TAKEN), { to: guest.email, subject: 's', text: 't' }, ref).catch(() => {});
    expect(await rows()).toHaveLength(1);
  });

  it('survives a restart: the rows are in the database, and a new connection finds them', async () => {
    const { guest } = await invitation(failing(NOT_TAKEN));
    await db().$disconnect();
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails.map((m) => m.to)).toEqual([guest.email]);
  });
});

// ── Read again before each attempt ──────────────────────────────────────────

describe('the attempt asks again whether the email is wanted', () => {
  // Mutation R04: FR-AU-58 (a) is not read before an attempt (D267).
  it('an account whose deletion is confirmed is sent nothing, and the row is gone', async () => {
    const { guest } = await invitation(failing(NOT_TAKEN));
    await db().accountDeletion.create({ data: { userId: guest.id } });
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it.each(['REVOKED', 'DECLINED', 'ACCEPTED'] as const)(
    'an invitation that is %s is sent nothing',
    async (state) => {
      const { one } = await invitation(failing(NOT_TAKEN));
      await db().documentInvitation.update({
        where: { id: one.id },
        data: { state, respondedAt: new Date() },
      });
      const sink = collecting();
      await retryEmails(sink.send);
      expect(sink.mails).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
    },
  );

  it('an invitation that expired is sent nothing: the link of a late retry is not offered', async () => {
    const { one } = await invitation(failing(NOT_TAKEN));
    await db().documentInvitation.update({
      where: { id: one.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
    expect(await rows()).toHaveLength(0);
  });

  it('an invitee who now holds a role on the document is sent nothing', async () => {
    const { guest, document } = await invitation(failing(NOT_TAKEN));
    await db().documentCollaborator.create({
      data: { documentId: document.id, userId: guest.id, role: 'VIEWER' },
    });
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
  });

  it("an address that is no longer the account's verified one is sent nothing", async () => {
    const { guest } = await invitation(failing(NOT_TAKEN));
    await db().user.update({ where: { id: guest.id }, data: { emailVerified: false } });
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
  });

  it.each(['ACCEPTED', 'DECLINED', 'WITHDRAWN', 'EXPIRED'] as const)(
    'an offer that is %s is sent nothing',
    async (state) => {
      const owner = await person();
      const to = await person();
      const made = await offer(owner, to);
      await deliverOffer(made.id, failing(NOT_TAKEN));
      await db().ownershipOffer.update({ where: { id: made.id }, data: { state } });
      const sink = collecting();
      await retryEmails(sink.send);
      expect(sink.mails).toHaveLength(0);
      expect(await rows()).toHaveLength(0);
    },
  );

  it('a person whose notice of the clearing was taken back is sent nothing', async () => {
    const owner = await person();
    const to = await person();
    const made = await clearing(owner, to);
    await deliverClearingEmails(made.id, failing(NOT_TAKEN));
    await db().notification.deleteMany({ where: { recipientId: to.id, kind: CLEARING_NOTICE } });
    const sink = collecting();
    await retryEmails(sink.send);
    expect(sink.mails).toHaveLength(0);
  });
});

// ── What waits holds nothing of the email ───────────────────────────────────

describe('what waits and what is logged', () => {
  // Mutation R05: the address, the link, or the text goes into the row or into a line.
  it('a row holds the kind, the subject and the account, and no address, link or content', async () => {
    const { one, guest } = await invitation(failing(NOT_TAKEN));
    const [row] = await rows();
    expect(Object.keys(row!).sort()).toEqual(['createdAt', 'id', 'kind', 'subjectId', 'userId']);
    const held = JSON.stringify(row);
    for (const forbidden of [guest.email, '@', 'http', one.token, 'invited', ORIGIN])
      expect(held).not.toContain(forbidden);
    const columns = await db().$queryRaw<{ column_name: string }[]>`
      SELECT column_name FROM information_schema.columns WHERE table_name = 'EmailRetry' ORDER BY column_name`;
    expect(columns.map((c) => c.column_name)).toEqual(['createdAt', 'id', 'kind', 'subjectId', 'userId']);
  });

  it('a line names the kind and the subject, and the class and code of the fault, and nothing else', async () => {
    await invitation(failing(NOT_TAKEN));
    // The fault quotes the address, as a library's message can.
    const quoting = () =>
      Object.assign(new Error('Brevo said no to a.secret.person@example.com: https://x.test/t0k3n'), {
        code: '429',
      });
    await retryEmails(failing(quoting));
    const lines = logged.flatMap((spy) => spy.mock.calls.map((call: unknown[]) => String(call[0])));
    expect(
      lines.some((line) =>
        /^email retry invitation \S+: not taken, will try again \(Error 429\)$/.test(line),
      ),
    ).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain('secret');
      expect(line).not.toContain('t0k3n');
    }
  });
});
