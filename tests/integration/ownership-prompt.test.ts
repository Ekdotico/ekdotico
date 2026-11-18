// The prompt in front of an offer of ownership and of the transfer of all documents (FR-ED-47, FR-AU-92; D285;
// register Q82 point 6; docs@da33e58): the password, and a code where two-factor authentication is on, asked for
// immediately before the action, every time, by the route. A request without them is refused whatever its session
// (a session cookie alone offers nothing), and a wrong one is a failed sign-in (NFR-SE-07) toward the lock of
// FR-AU-81, as FR-AU-58 has it, through the one function that confirms a deletion and a clearing. Each test names
// the weakening that makes it fail.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, prepare, signIn } from './identity.ts';
import { enrol, nextCode } from './second-factor.ts';

// `after` of Next.js exists only inside a request of the framework: what a route leaves for after its response is
// collected here and run by the test when it wants it (the lock of a failed sign-in is one of them; the email of an
// offer is another, and no email is sent from a test: the sink is a directory).
const later = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => unknown) => void later.push(task),
}));
async function afterResponses() {
  for (const task of later.splice(0)) await task();
}

// Not the initial value: the third wrong password in an hour locks an account (as tests/integration/account-deletion.test.ts has it).
const MOST = 3;
const database = prepare('ownershipprompt', {
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: `/tmp/ekdotico-ownership-prompt-${randomUUID()}`,
  RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600',
  // Two offers in an hour, so that a third is a 429 (review of PR 80, item 1).
  RATE_LIMIT_OFFERS_PER_USER: '2/3600',
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: `${MOST}/3600`,
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: '500/900',
});
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { SIGN_IN_REFUSED } = await import('../../src/lib/auth/sign-in.ts');
const offering = await import('../../src/app/api/documents/[id]/ownership-offer/route.ts');
const transferring = await import('../../src/app/api/account/documents/transfer/route.ts');
const { transferScreen, confirmTransfer } = await import('../../src/lib/account/transfer.ts');
const { makeOffer } = await import('../../src/lib/documents/ownership.ts');
const { guardAnswer } = await import('../../src/lib/account/prompt.ts');
const { standingAs } = await import('./guard.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

const WRONG = 'not the password at all';
let addresses = 0;
const net = () => ({ 'x-forwarded-for': `10.40.${Math.floor(++addresses / 250)}.${addresses % 250}` });
const post = (path: string, cookie: string, body: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json', cookie, ...net() },
    body: JSON.stringify(body),
  });
const at = (id: string) => ({ params: Promise.resolve({ id }) });
const offer = (id: string, cookie: string, body: unknown) =>
  offering.POST(post(`/api/documents/${id}/ownership-offer`, cookie, body), at(id));
const transfer = (cookie: string, body: unknown) =>
  transferring.POST(post('/api/account/documents/transfer', cookie, body));
const code = async (response: Response) =>
  ((await response.json()) as { error: { code: string } }).error.code;

let count = 0;
async function person() {
  const email = `prompt${++count}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email, PASSWORD, net())) };
}
async function enrolled() {
  const who = await person();
  return { ...who, ...(await enrol(auth, who.cookie, net())) };
}

/** An Owner with a document and an Editor on it, and the identifier of the Editor's row. */
async function document(owner: { id: string }) {
  const editor = await person();
  const { id } = await createDocument(owner.id);
  const row = await db().documentCollaborator.create({
    data: { documentId: id, userId: editor.id, role: 'EDITOR' },
  });
  return { id, row: row.id };
}
const offers = (documentId: string) => db().ownershipOffer.count({ where: { documentId } });

describe('the offer of ownership asks for the password (FR-ED-47, D285)', () => {
  // Weakening: the route offers on the session alone.
  it('refuses a request without the password, whatever its session, and offers nothing', async () => {
    const owner = await person();
    const { id, row } = await document(owner);
    const bare = await offer(id, owner.cookie, { collaboratorId: row });
    expect(bare.status).toBe(422);
    expect(await code(bare)).toBe('invalid_request');
    expect(await offers(id)).toBe(0);
  });

  // Weakening: a wrong password is not counted as a failed sign-in, or not refused.
  it('refuses a wrong password, counts it as a failed sign-in, and locks the account as FR-AU-81 does', async () => {
    const owner = await person();
    const { id, row } = await document(owner);
    for (let attempt = 0; attempt < MOST; attempt += 1) {
      const wrong = await offer(id, owner.cookie, { collaboratorId: row, password: WRONG });
      expect(wrong.status).toBe(403);
      expect(await code(wrong)).toBe('password_refused');
    }
    expect(await offers(id)).toBe(0);
    await afterResponses();
    expect((await db().user.findUniqueOrThrow({ where: { id: owner.id } })).lockedUntil).not.toBeNull();
    // The right password, while it is locked: the statement of the lock, and no offer.
    const locked = await offer(id, owner.cookie, { collaboratorId: row, password: PASSWORD });
    expect(locked.status).toBe(403);
    expect(((await locked.json()) as { error: { message: string } }).error.message).toBe(SIGN_IN_REFUSED);
    expect(await offers(id)).toBe(0);
  });

  // Weakening: the password is asked once and remembered.
  it('asks every time: the right password offers, and the next request without it is refused again', async () => {
    const owner = await person();
    const { id, row } = await document(owner);
    const made = await offer(id, owner.cookie, { collaboratorId: row, password: PASSWORD });
    expect(made.status).toBe(201);
    expect((await offer(id, owner.cookie, { collaboratorId: row })).status).toBe(422);
    expect(await offers(id)).toBe(1);
  });

  // Weakening: the code is not asked for, or is accepted from an account that has none.
  it('asks for a code where two-factor authentication is on, and for none where it is off', async () => {
    const who = await enrolled();
    const { id, row } = await document(who);
    expect((await offer(id, who.cookie, { collaboratorId: row, password: PASSWORD })).status).toBe(422);
    const wrong = await offer(id, who.cookie, { collaboratorId: row, password: PASSWORD, code: '000000' });
    expect(wrong.status).toBe(403);
    expect(await code(wrong)).toBe('code_refused');
    expect(await offers(id)).toBe(0);
    const right = await offer(id, who.cookie, {
      collaboratorId: row,
      password: PASSWORD,
      code: nextCode(who.secret),
    });
    expect(right.status).toBe(201);

    const plain = await person();
    const second = await document(plain);
    const extra = await offer(second.id, plain.cookie, {
      collaboratorId: second.row,
      password: PASSWORD,
      code: '123456',
    });
    expect(extra.status).toBe(422);
    expect(await offers(second.id)).toBe(0);
  });

  // Weakening: a recovery code that opened one offer opens another.
  it('spends a recovery code on an offer that is made, and not on one that is refused', async () => {
    const who = await enrolled();
    const first = await document(who);
    const second = await document(who);
    const recovery = who.recoveryCodes[0]!;
    // Refused for another reason (no such collaborator): the code stays its owner's.
    const refused = await offer(first.id, who.cookie, {
      collaboratorId: 'nobody',
      password: PASSWORD,
      code: recovery,
    });
    expect(refused.status).toBe(404);
    expect(
      (await offer(first.id, who.cookie, { collaboratorId: first.row, password: PASSWORD, code: recovery }))
        .status,
    ).toBe(201);
    const again = await offer(second.id, who.cookie, {
      collaboratorId: second.row,
      password: PASSWORD,
      code: recovery,
    });
    expect(again.status).toBe(403);
    expect(await code(again)).toBe('code_refused');
    expect(await offers(second.id)).toBe(0);
  });
});

describe('the transfer of all documents asks for the password (FR-AU-92, D285)', () => {
  async function ready(owner: { id: string }) {
    await document(owner);
    const { longest } = await transferScreen(owner.id);
    return { mode: 'longest', documentIds: longest.documentIds };
  }

  // Weakening: the route transfers on the session alone.
  it('refuses a request without the password and offers nothing', async () => {
    const owner = await person();
    const body = await ready(owner);
    const bare = await transfer(owner.cookie, body);
    expect(bare.status).toBe(422);
    expect(await db().ownershipOffer.count({ where: { fromUserId: owner.id } })).toBe(0);
  });

  // Weakening: a wrong password is not counted toward the lock.
  it('refuses a wrong password, counts it as a failed sign-in, and locks the account', async () => {
    const owner = await person();
    const body = await ready(owner);
    for (let attempt = 0; attempt < MOST; attempt += 1) {
      const wrong = await transfer(owner.cookie, { ...body, password: WRONG });
      expect(wrong.status).toBe(403);
      expect(await code(wrong)).toBe('password_refused');
    }
    await afterResponses();
    expect((await db().user.findUniqueOrThrow({ where: { id: owner.id } })).lockedUntil).not.toBeNull();
    expect(await db().ownershipOffer.count({ where: { fromUserId: owner.id } })).toBe(0);
  });

  it('makes the offers for the right password, asks again each time, and asks a code where one is on', async () => {
    const owner = await person();
    const body = await ready(owner);
    expect((await transfer(owner.cookie, { ...body, password: PASSWORD })).status).toBe(201);
    expect((await transfer(owner.cookie, body)).status).toBe(422);

    const who = await enrolled();
    const second = await ready(who);
    expect((await transfer(who.cookie, { ...second, password: PASSWORD })).status).toBe(422);
    const wrong = await transfer(who.cookie, { ...second, password: PASSWORD, code: '000000' });
    expect(wrong.status).toBe(403);
    expect(await code(wrong)).toBe('code_refused');
    const right = await transfer(who.cookie, { ...second, password: PASSWORD, code: nextCode(who.secret) });
    expect(right.status).toBe(201);
  });
});

describe('a recovery code is spent only by an action that is carried out (review of PR 80, item 1)', () => {
  const codesOf = async (userId: string) =>
    (await db().twoFactor.findUniqueOrThrow({ where: { userId } })).backupCodes;

  // Weakening: the code is spent before the limit is taken, so that a 429 uses it up.
  it('leaves the code where the offer is refused for the limit, with a 429', async () => {
    const who = await enrolled();
    const [first, second, third] = [await document(who), await document(who), await document(who)];
    for (const each of [first, second]) {
      const made = await offer(each.id, who.cookie, {
        collaboratorId: each.row,
        password: PASSWORD,
        code: nextCode(who.secret),
      });
      expect(made.status).toBe(201);
    }
    const before = await codesOf(who.id);
    const limited = await offer(third.id, who.cookie, {
      collaboratorId: third.row,
      password: PASSWORD,
      code: who.recoveryCodes[0]!,
    });
    expect(limited.status).toBe(429);
    expect(await codesOf(who.id)).toBe(before);
    expect(await offers(third.id)).toBe(0);
  });

  // Weakening: the code is spent before the over-limit refusal of the transfer.
  it('leaves the code where the transfer would email more people than the limit allows, with a 409', async () => {
    const who = await enrolled();
    for (let each = 0; each < 3; each += 1) await document(who);
    const { longest } = await transferScreen(who.id);
    const before = await codesOf(who.id);
    const refused = await transfer(who.cookie, {
      mode: 'longest',
      documentIds: longest.documentIds,
      password: PASSWORD,
      code: who.recoveryCodes[0]!,
    });
    expect(refused.status).toBe(409);
    expect(await code(refused)).toBe('too_many_offers');
    expect(await codesOf(who.id)).toBe(before);
    expect(await db().ownershipOffer.count({ where: { fromUserId: who.id } })).toBe(0);
  });
});

describe('the action asks again whether the password and the session stand (review of PR 80, item 3)', () => {
  // Weakening: `guardRefusal` is not asked in the transaction of the action.
  it.each([
    ['outrun', 'password_refused', 403],
    ['ended', 'unauthenticated', 401],
  ] as const)(
    'refuses an offer when the check finds %s, offers nothing and spends no code',
    async (found, answer, status) => {
      const owner = await person();
      const { id, row } = await document(owner);
      const spend = vi.fn(async () => true);
      const result = await makeOffer(id, owner.id, row, undefined, standingAs(found, spend));
      expect(result).toEqual({ outcome: found });
      expect(await offers(id)).toBe(0);
      expect(spend).not.toHaveBeenCalled();
      const response = await guardAnswer(owner.id, { outcome: found });
      expect(response.status).toBe(status);
      expect(await code(response)).toBe(answer);
    },
  );

  it.each(['outrun', 'ended'] as const)(
    'refuses a transfer when the check finds %s, offers nothing and spends no code',
    async (found) => {
      const owner = await person();
      const body = await (async () => {
        await document(owner);
        const { longest } = await transferScreen(owner.id);
        return { mode: 'longest' as const, documentIds: longest.documentIds };
      })();
      const stored = await db().session.findFirstOrThrow({ where: { userId: owner.id } });
      const spend = vi.fn(async () => true);
      const result = await confirmTransfer(
        { userId: owner.id, sessionId: stored.id } as never,
        body,
        undefined,
        standingAs(found, spend),
      );
      expect(result.outcome).toBe(found);
      expect(await db().ownershipOffer.count({ where: { fromUserId: owner.id } })).toBe(0);
      expect(spend).not.toHaveBeenCalled();
    },
  );
});
