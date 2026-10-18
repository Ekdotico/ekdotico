// The lock of an account after failed sign-ins, and the sign-in link in the
// email of a lock (FR-AU-81, FR-AU-86, FR-AU-87 (h); NFR-SE-07, NFR-SE-17 (d),
// NFR-SE-19; register D115; A104, assumed), through the identity library's
// handler as the route calls it, against a provisioned database, Valkey, and
// the local sink of email.
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  cookiesOf,
  createAccount,
  handle,
  load,
  ORIGIN,
  PASSWORD,
  post,
  prepare,
  signIn,
  sunk,
} from './identity.ts';
import { listen, until } from './channel.ts';
import { codeAt, enrol, midStep, nextCode, passwordStep, secondStep, withCookies } from './second-factor.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-lock-mail-'));
// Not the initial values: the limits are configuration. The fourth failure
// here is "the twentieth", and the count for one network address is out of
// the way.
const MOST = 4;
const database = prepare('lock', {
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: sink,
  FOUNDING_TEAM_EMAILS: 'founder@example.com',
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: `${MOST}/3600`,
  RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: '50/900',
});
const { auth, db, valkey, settings, validateSessionRow } = await load();
// What the collaboration server is told (FR-ED-40 (d)); register row S15-3.
const channel = await listen();
const { beginLock, claimSignInLink, findOpenSignInLink } = await import('../../src/lib/auth/sign-in-lock.ts');
const { clearFailedSignIns } = await import('../../src/lib/auth/sign-in.ts');
const { deleteExpiredTokens } = await import('../../src/lib/auth/password.ts');

// Written out here and not imported: every character is the requirement's.
// FR-AU-81.
const REFUSED =
  '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}';
const NOT_VALID_STATEMENT =
  'This link is no longer valid. Sign in with your email address and password, or set a new password from the sign-in page.';
const NOT_VALID = `{"error":{"code":"sign_in_link_not_valid","message":"${NOT_VALID_STATEMENT}"}}`;
// FR-AU-87 (h), with the numbers of this file's settings.
const SUBJECT = 'Sign-in to your Ekdotico account is locked for 1 hour';
const TEXT = (link: string, time: string) =>
  `Sign-in to your Ekdotico account is locked for 1 hour, because sign-in to it failed ${MOST} times within an hour. To sign in now, open this link:\n${link}\nIt works once, until ${time}, and it lifts the lock. If the failed attempts were not yours, set a new password from the sign-in page.`;

const WRONG = 'a wrong password, long enough';
const NEW = 'a new password, long enough';
const HOUR = 60 * 60 * 1000;
const LINK = 'sign-in-link:';

let addresses = 0;
/** A network address no earlier request came from, as the one trusted proxy reports it. */
const fresh = () => ({ 'x-forwarded-for': `10.${Math.floor(++addresses / 250)}.${addresses % 250}.7` });
let people = 0;
const address = () => `person${++people}@example.com`;
async function person(verified = true) {
  const email = address();
  return { email, id: await createAccount(auth, email, verified) };
}

const attempt = (email: string, password = PASSWORD, headers: Record<string, string> = fresh()) =>
  post(auth, '/sign-in/email', { email, password }, headers);
/** `n` failed sign-ins, each with what it left for after its answer run. */
async function fail(email: string, n: number) {
  for (let each = 0; each < n; each++) {
    const failed = await attempt(email, WRONG);
    expect(await failed.response.text()).toBe(REFUSED);
    await failed.after();
  }
}
const mailTo = async (email: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject === SUBJECT);
const tokenIn = (text: string) => /\/sign-in\/link\/([A-Za-z0-9_-]+)\n/.exec(text)![1]!;
/** Fails until the account is locked, and reads the token of the link from the email, as the person would. */
async function lock(email: string): Promise<string> {
  await fail(email, MOST);
  return tokenIn((await mailTo(email)).at(-1)!.text);
}
const confirm = (token: unknown, headers: Record<string, string> = {}) =>
  post(auth, '/sign-in/link', { token }, { ...fresh(), ...headers });
const account = (id: string) => db().user.findUniqueOrThrow({ where: { id } });
const links = (id: string) =>
  db().verification.findMany({ where: { value: id, identifier: { startsWith: LINK } } });
const steps = (id: string) =>
  db().verification.findMany({ where: { value: id, identifier: { startsWith: 'second-step:' } } });
const sessions = (id: string) => db().session.findMany({ where: { userId: id } });
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
const logged = () =>
  db().securityLogEntry.findMany({ orderBy: { createdAt: 'asc' }, select: { kind: true, userId: true } });

/** How many entries of a kind the security log holds for a user. */
const entries = (kind: 'sign_in_locked' | 'sign_in_by_link', userId: string) =>
  db().securityLogEntry.count({ where: { kind, userId } });
const entriesOf = (kind: string) => db().securityLogEntry.count({ where: { kind } });

/**
 * Makes the next transaction that is opened fail where it creates a row of
 * `table`, with everything before it done: what the transaction wrote until
 * then must be undone with it. With `written`, the row is created first and
 * the transaction fails after it: the row itself must be undone too.
 */
function failCreateIn(table: 'verification' | 'securityLogEntry', message: string, written = false) {
  type Work = (tx: Record<string, unknown>) => Promise<unknown>;
  const client = db() as unknown as { $transaction: (work: Work) => Promise<unknown> };
  const original = client.$transaction.bind(client);
  vi.spyOn(client, '$transaction').mockImplementationOnce((work) =>
    original((tx) => {
      const rows = new Proxy(tx[table] as object, {
        get: (target, key) =>
          key === 'create'
            ? async (...args: unknown[]) => {
                if (written) {
                  await (Reflect.get(target, key) as (...all: unknown[]) => Promise<unknown>).apply(
                    target,
                    args,
                  );
                }
                throw new Error(message);
              }
            : Reflect.get(target, key),
      });
      return work(new Proxy(tx, { get: (target, key) => (key === table ? rows : Reflect.get(target, key)) }));
    }),
  );
}

/** An account with two-factor authentication on, and no session left. */
async function enrolled(email = address()) {
  const id = await createAccount(auth, email);
  const { secret } = await enrol(auth, cookiesOf(await signIn(auth, email, PASSWORD, fresh())), fresh());
  await db().session.deleteMany({ where: { userId: id } });
  return { email, id, secret };
}
/**
 * A code that none of the steps near now gives. Chosen against them, and not
 * the code of a far step: that one is the code of a near step three times in
 * a million, and the refusal the test expects would then be a sign-in.
 */
function wrongCode(secret: string): string {
  const right = [-1, 0, 1, 2].map((steps) => codeAt(secret, steps));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!right.includes(code)) return code;
  }
}

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  channel.stop();
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the twentieth failed sign-in for an email address in any hour (FR-AU-81, NFR-SE-07)', () => {
  it('locks the account for the period of the setting, counted from that failure, and not a failure sooner', async () => {
    const { email, id } = await person();
    await fail(email, MOST - 1);
    expect((await account(id)).lockedUntil).toBeNull();
    expect(await mailTo(email)).toHaveLength(0);

    const before = Date.now();
    await fail(email, 1);
    const until = (await account(id)).lockedUntil!.getTime();
    expect(until).toBeGreaterThanOrEqual(before + settings().signInLockSeconds * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + settings().signInLockSeconds * 1000);
    expect(settings().signInLockSeconds).toBe(3600);
  });

  it('sends the notice of FR-AU-87 (h) to its address, with the fixed text and a link of this origin', async () => {
    const { email, id } = await person();
    await fail(email, MOST);
    const messages = await mailTo(email);
    expect(messages).toHaveLength(1);
    const token = tokenIn(messages[0]!.text);
    // "[time]" as a person reads it, in UTC: `9 Oct 2026, 14:05 UTC`.
    const until = (await account(id)).lockedUntil!;
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
      until.getUTCMonth()
    ];
    const time = `${until.getUTCDate()} ${month} ${until.getUTCFullYear()}, ${until.toISOString().slice(11, 16)} UTC`;
    expect(messages[0]!.text).toBe(TEXT(`${ORIGIN}/sign-in/link/${token}`, time));
  });

  it('stores the token of the link only as a hash, with 256 bits, valid until the lock would have ended', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    // 43 characters of the URL-safe alphabet are 32 bytes of the platform's source (src/lib/token.ts).
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
    const rows = await links(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.identifier).toBe(LINK + hashOf(token));
    expect(rows[0]!.expiresAt).toEqual((await account(id)).lockedUntil);
    // No row of any table holds the token itself.
    const everything = JSON.stringify([await db().verification.findMany(), await db().user.findMany()]);
    expect(everything).not.toContain(token);
  });

  it('sends one notice for each lock, however many attempts are refused in it, and never extends it', async () => {
    const { email, id } = await person();
    await lock(email);
    const { lockedUntil } = await account(id);
    for (let n = 0; n < 3; n++) {
      for (const password of [WRONG, PASSWORD]) {
        const refused = await attempt(email, password);
        expect(refused.response.status).toBe(401);
        expect(await refused.response.text()).toBe(REFUSED);
        await refused.after();
      }
    }
    expect(await mailTo(email)).toHaveLength(1);
    expect(await links(id)).toHaveLength(1);
    expect((await account(id)).lockedUntil).toEqual(lockedUntil);
  });

  it('begins one lock, writes one link and sends one notice where the calls arrive together', async () => {
    const { email, id } = await person();
    await Promise.all(Array.from({ length: 6 }, () => beginLock(email)));
    expect(await links(id)).toHaveLength(1);
    expect(await mailTo(email)).toHaveLength(1);
    // NFR-SE-19: and one entry, as there is one link and one email.
    expect(await entries('sign_in_locked', id)).toBe(1);
    // A lock in force is not begun again.
    const { lockedUntil } = await account(id);
    await beginLock(email);
    expect((await account(id)).lockedUntil).toEqual(lockedUntil);
    expect(await mailTo(email)).toHaveLength(1);
    expect(await entries('sign_in_locked', id)).toBe(1);
  });

  it('writes one entry for the lock where the twentieth failures arrive together, with the user and nothing else', async () => {
    const { email, id } = await person();
    await fail(email, MOST - 1);
    // Six attempts at once, each from a network address of its own: one of them is the twentieth.
    const together = await Promise.all(Array.from({ length: 6 }, () => attempt(email, WRONG)));
    for (const each of together) await each.after();
    expect((await account(id)).lockedUntil).not.toBeNull();
    const written = await db().securityLogEntry.findMany({ where: { kind: 'sign_in_locked' } });
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      id: expect.any(String),
      createdAt: expect.any(Date),
      kind: 'sign_in_locked',
      userId: id,
      documentId: null,
    });
    // Refused attempts in the lock, and its end by the link, write no second one.
    await (await attempt(email, WRONG)).after();
    expect(await entries('sign_in_locked', id)).toBe(1);
  });

  it('writes the entry in the transaction that begins the lock: no lock, no entry, and no entry without the lock', async () => {
    const { email, id } = await person();
    // The lock is begun and its entry written, and then the link cannot be: all three are undone.
    failCreateIn('verification', 'the link was not written');
    await expect(beginLock(email)).rejects.toThrow('the link was not written');
    expect((await account(id)).lockedUntil).toBeNull();
    expect(await entriesOf('sign_in_locked')).toBe(0);
    expect(await mailTo(email)).toHaveLength(0);
    // And where the entry cannot be written, no lock begins without it.
    failCreateIn('securityLogEntry', 'the entry was not written');
    await expect(beginLock(email)).rejects.toThrow('the entry was not written');
    expect((await account(id)).lockedUntil).toBeNull();
    expect(await links(id)).toEqual([]);
    expect(await mailTo(email)).toHaveLength(0);
  });

  it('begins the lock after the answer, so that the answer is the same for an address without an account', async () => {
    const known = await person();
    const unknown = address();
    await fail(known.email, MOST - 1);
    await fail(unknown, MOST - 1);
    const users = vi.spyOn(db().user, 'updateMany');
    const rows = vi.spyOn(db().verification, 'create');

    const [first, second] = [await attempt(known.email, WRONG), await attempt(unknown, WRONG)];
    for (const each of [first, second]) {
      expect(each.response.status).toBe(401);
      expect(await each.response.text()).toBe(REFUSED);
      expect(each.response.headers.getSetCookie()).toEqual([]);
    }
    expect([...first.response.headers.keys()].sort()).toEqual([...second.response.headers.keys()].sort());
    // The same work was left by both, and until it runs nothing is written for either.
    expect([first.left, second.left]).toEqual([1, 1]);
    expect(users).not.toHaveBeenCalled();
    expect(rows).not.toHaveBeenCalled();
    expect((await account(known.id)).lockedUntil).toBeNull();

    await first.after();
    await second.after();
    expect((await account(known.id)).lockedUntil).not.toBeNull();
    // "An address that belongs to no account is answered in the same way after
    // twenty failures", and nothing is made for it.
    expect((await sunk(sink)).filter((message) => message.to === unknown)).toEqual([]);
    expect((await attempt(unknown, WRONG)).response.status).toBe(401);
  });

  it('locks no account whose address is not verified, and sends that address nothing', async () => {
    const { email, id } = await person(false);
    await fail(email, MOST);
    expect((await account(id)).lockedUntil).toBeNull();
    expect((await sunk(sink)).filter((message) => message.to === email)).toEqual([]);
    expect(await links(id)).toEqual([]);
    // NFR-SE-19: where the conditional statement begins no lock, no entry says
    // one began; nor for an address that belongs to no account.
    await fail(address(), MOST);
    expect(await entriesOf('sign_in_locked')).toBe(0);
  });

  it('prints the class and code of the fault where the lock cannot be begun, and the limit still refuses', async () => {
    const { email, id } = await person();
    await fail(email, MOST - 1);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The transaction of `beginLock`, the next one that is opened.
    vi.spyOn(db(), '$transaction').mockRejectedValueOnce(
      Object.assign(new Error(`cannot reach the row of ${email}`), {
        name: 'PrismaClientKnownRequestError',
        code: 'P1001',
      }),
    );
    const twentieth = await attempt(email, WRONG);
    expect(await twentieth.response.text()).toBe(REFUSED);
    expect(twentieth.left).toBe(1);
    await twentieth.after();
    // NFR-SE-19: the work, the class and the code, and nothing of the message.
    expect(errors.mock.calls).toEqual([
      ['after response: sign-in lock failed (PrismaClientKnownRequestError P1001)'],
    ]);
    expect((await account(id)).lockedUntil).toBeNull();
    expect(await mailTo(email)).toHaveLength(0);
    // The limit that was reached refuses as the lock would have, the right password included.
    const next = await attempt(email);
    expect(next.response.status).toBe(401);
    expect(await next.response.text()).toBe(REFUSED);
    expect(await sessions(id)).toEqual([]);
  });

  it('leaves no work behind before the twentieth, and throws where none can be left', async () => {
    const { email } = await person();
    expect((await attempt(email, WRONG)).left).toBe(0);
    // Through the handler, and not as the route calls it: nothing collects. A
    // check of a password fails at its first use, and not at a twentieth failure.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const bare = await auth().handler(
      new Request(`${ORIGIN}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN, ...fresh() },
        body: JSON.stringify({ email, password: PASSWORD }),
      }),
    );
    expect(bare.status).toBe(500);
    expect(errors.mock.calls).toEqual([['identity: request failed (Error)']]);
  });
});

describe('while an account is locked (FR-AU-81)', () => {
  it('refuses every sign-in with the one statement, the right password included, by the lock alone', async () => {
    const { email, id } = await person();
    await lock(email);
    // The count that caused the lock is cleared, so that only the lock refuses.
    await clearFailedSignIns(email);
    const refused = await attempt(email);
    expect(refused.response.status).toBe(401);
    expect(await refused.response.text()).toBe(REFUSED);
    expect(refused.response.headers.getSetCookie()).toEqual([]);
    expect(await sessions(id)).toEqual([]);
    // NFR-SE-19: a sign-in refused, with the user and nothing else.
    expect(await logged()).toContainEqual({ kind: 'sign_in_refused', userId: id });
  });

  it('answers it as an address without an account and as a wrong password are answered', async () => {
    const locked = await person();
    await lock(locked.email);
    await clearFailedSignIns(locked.email);
    const other = await person();
    const answers = [
      await attempt(locked.email),
      await attempt(locked.email, WRONG),
      await attempt(address(), WRONG),
      await attempt(other.email, WRONG),
    ];
    const seen = await Promise.all(
      answers.map(async ({ response }) => [
        response.status,
        await response.text(),
        [...response.headers.keys()].sort().join(),
        response.headers.getSetCookie().length,
      ]),
    );
    for (const each of seen) expect(each).toEqual(seen[0]);
    expect(seen[0]![1]).toBe(REFUSED);
  });

  it('runs the password hashing function once and verifies nothing, as for an address without an account', async () => {
    const { email } = await person();
    await lock(email);
    await clearFailedSignIns(email);
    const context = await auth().$context;
    const verify = vi.spyOn(context.password, 'verify');
    const hash = vi.spyOn(context.password, 'hash');
    await attempt(email);
    expect([verify.mock.calls.length, hash.mock.calls.length]).toEqual([0, 1]);
    verify.mockClear();
    hash.mockClear();
    await attempt(address());
    expect([verify.mock.calls.length, hash.mock.calls.length]).toEqual([0, 1]);
  });

  it('counts no attempt that it refuses', async () => {
    const { email, id } = await person();
    await lock(email);
    await clearFailedSignIns(email);
    // More than the limit, each refused by the lock.
    for (let n = 0; n < MOST + 2; n++) await (await attempt(email, WRONG)).after();
    // The lock is taken away by hand: had the attempts been counted, the limit would refuse now.
    await db().user.update({ where: { id }, data: { lockedUntil: null } });
    expect((await attempt(email)).response.status).toBe(200);
  });

  it('gives a signed-in user the statement at a prompt for the password, and leaves the session', async () => {
    const { email, id } = await person();
    const cookie = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
    await lock(email);
    await clearFailedSignIns(email);
    const changed = await post(
      auth,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: NEW },
      { cookie, ...fresh() },
    );
    expect(changed.response.status).toBe(403);
    expect((await changed.response.json()).error.message).toBe(
      'The email address or the password is not correct.',
    );
    expect(await sessions(id)).toHaveLength(1);
    expect((await validateSessionRow(new Headers({ cookie }))).session?.userId).toBe(id);
  });

  it('ends when its time has passed, and its link is void with it', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    await clearFailedSignIns(email);
    // The lock ended a moment ago; the row of the link says it has minutes left.
    await db().user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    await db().verification.updateMany({
      where: { value: id, identifier: { startsWith: LINK } },
      data: { expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    expect(await findOpenSignInLink(token)).toBeNull();
    const late = await confirm(token);
    expect(late.response.status).toBe(409);
    expect(await late.response.text()).toBe(NOT_VALID);
    expect(await sessions(id)).toEqual([]);
    expect((await attempt(email)).response.status).toBe(200);
  });

  it('is begun again by twenty more failures once it has ended, with a new link and the old one void', async () => {
    const { email, id } = await person();
    const old = await lock(email);
    await clearFailedSignIns(email);
    await db().user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const next = await lock(email);
    expect(next).not.toBe(old);
    expect(await mailTo(email)).toHaveLength(2);
    expect(await links(id)).toHaveLength(1);
    expect((await confirm(old)).response.status).toBe(409);
    expect((await confirm(next)).response.status).toBe(200);
  });

  it('refuses the sign-in where the lock cannot be read, and never lets it through (NFR-SE-06 A10)', async () => {
    const { email, id } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = db().user.findFirst.bind(db().user);
    vi.spyOn(db().user, 'findFirst').mockImplementation(((args: { select?: { lockedUntil?: boolean } }) =>
      args?.select?.lockedUntil
        ? Promise.reject(new Error(`cannot read ${email}`))
        : read(args as never)) as never);
    const refused = await attempt(email);
    expect(refused.response.status).toBe(500);
    expect(refused.response.headers.getSetCookie()).toEqual([]);
    expect(await sessions(id)).toEqual([]);
    // NFR-SE-19: the class of the fault, and nothing of its message.
    expect(errors.mock.calls).toEqual([['identity: request failed (Error)']]);
  });
});

describe('the page of the link, which only reads (FR-AU-81; A104)', () => {
  it('finds the address to be signed in, and changes nothing by being opened', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    const before = JSON.stringify([await account(id), await links(id), await sessions(id)]);
    for (let n = 0; n < 3; n++) {
      expect(await findOpenSignInLink(token)).toMatchObject({ userId: id, email, twoFactorEnabled: false });
    }
    expect(JSON.stringify([await account(id), await links(id), await sessions(id)])).toBe(before);
    // And the link still works after it.
    expect((await confirm(token)).response.status).toBe(200);
  });

  it('finds nothing for a token that is not one, that is not known, or that is of another link', async () => {
    const { email, id } = await person();
    await lock(email);
    const other = 'B'.repeat(43);
    // The token of a reset link of the same account opens nothing here.
    await db().verification.create({
      data: {
        id: randomUUID(),
        identifier: `reset-password:${hashOf(other)}`,
        value: id,
        expiresAt: new Date(Date.now() + HOUR),
      },
    });
    for (const token of [undefined, null, 7, '', 'short', `${other}x`, other, hashOf(other)]) {
      expect(await findOpenSignInLink(token)).toBeNull();
    }
  });
});

describe('the confirmation of the link (FR-AU-81; A104)', () => {
  it('signs the person in with an ordinary session, lifts the lock, spends the link and clears the counts', async () => {
    const { email, id } = await person();
    const { password } = await db().account.findFirstOrThrow({ where: { userId: id } });
    const token = await lock(email);
    const confirmed = await confirm(token);
    expect(confirmed.response.status).toBe(200);
    expect(await confirmed.response.text()).toBe('{}');
    expect(confirmed.response.headers.get('cache-control')).toBe('no-store');

    const cookie = cookiesOf(confirmed.response);
    expect((await validateSessionRow(new Headers({ cookie }))).session?.userId).toBe(id);
    const [session] = await sessions(id);
    // FR-AU-84: the idle period of the settings, as any sign-in begins one.
    const life = session!.expiresAt.getTime() - Date.now();
    expect(life).toBeGreaterThan((settings().sessionIdleSeconds - 60) * 1000);
    expect(life).toBeLessThanOrEqual(settings().sessionIdleSeconds * 1000);
    for (const set of confirmed.response.headers.getSetCookie()) {
      expect(set).toMatch(/; HttpOnly/i);
      expect(set).toMatch(/; Secure/i);
      expect(set).toMatch(/; SameSite=Lax/i);
      expect(set).not.toMatch(/; Domain=/i);
    }

    expect((await account(id)).lockedUntil).toBeNull();
    expect(await links(id)).toEqual([]);
    // "The password is not changed."
    expect((await db().account.findFirstOrThrow({ where: { userId: id } })).password).toBe(password);
    // The counts are cleared: the next sign-in by password is not refused by them.
    expect((await attempt(email)).response.status).toBe(200);
    // NFR-SE-19: one entry for the sign-in by the link, with the user and
    // nothing else; a sign-in by password writes none of that kind.
    const written = await db().securityLogEntry.findMany({ where: { kind: 'sign_in_by_link' } });
    expect(written).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        kind: 'sign_in_by_link',
        userId: id,
        documentId: null,
      },
    ]);
  });

  it('writes the entry of the sign-in with the claim: where it cannot be written, no one is signed in and the link stands', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    failCreateIn('securityLogEntry', 'the entry was not written');
    const failed = await confirm(token);
    expect(failed.response.status).toBe(500);
    expect(failed.response.headers.getSetCookie()).toEqual([]);
    expect(errors.mock.calls).toEqual([['identity: request failed (Error)']]);
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await links(id)).toHaveLength(1);
    expect(await entries('sign_in_by_link', id)).toBe(0);
    // The link was not spent by the fault.
    expect((await confirm(token)).response.status).toBe(200);
    expect(await entries('sign_in_by_link', id)).toBe(1);
  });

  it('leaves no entry of a sign-in that did not complete: a transaction that fails after the entry undoes it', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failCreateIn('securityLogEntry', 'not committed', true);
    const failed = await confirm(token);
    expect(failed.response.status).toBe(500);
    expect(failed.response.headers.getSetCookie()).toEqual([]);
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await links(id)).toHaveLength(1);
    // An entry written outside the transaction would be here (the owner's
    // decision of 12 October 2026: R38; register row D153, pending).
    expect(await entriesOf('sign_in_by_link')).toBe(0);
  });

  it('works once: a second confirmation is answered with the fixed statement and signs no one in', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    expect((await confirm(token)).response.status).toBe(200);
    const again = await confirm(token);
    expect(again.response.status).toBe(409);
    expect(await again.response.text()).toBe(NOT_VALID);
    expect(again.response.headers.getSetCookie()).toEqual([]);
    expect(await sessions(id)).toHaveLength(1);
    // NFR-SE-19: the refused one is a sign-in refused, and no second sign-in by the link.
    expect(await entries('sign_in_by_link', id)).toBe(1);
    expect(await logged()).toContainEqual({ kind: 'sign_in_refused', userId: id });
  });

  it('begins one session where requests with one link arrive together', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    const answers = await Promise.all(Array.from({ length: 6 }, () => confirm(token)));
    const statuses = answers.map(({ response }) => response.status).sort();
    expect(statuses).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await sessions(id)).toHaveLength(1);
    expect(await entries('sign_in_by_link', id)).toBe(1);
    for (const { response } of answers) {
      if (response.status === 409) expect(response.headers.getSetCookie()).toEqual([]);
    }
  });

  it('refuses a link whose time has passed, on the server', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    await db().verification.updateMany({
      where: { value: id, identifier: { startsWith: LINK } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await findOpenSignInLink(token)).toBeNull();
    const late = await confirm(token);
    expect(late.response.status).toBe(409);
    expect(await late.response.text()).toBe(NOT_VALID);
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).not.toBeNull();
    // The claim asks both again, by itself: a link that ended, or whose lock
    // ended, between the read and the claim signs no one in.
    const [row] = await db().verification.findMany({ where: { value: id } });
    expect(await claimSignInLink(db(), { id: row!.id, userId: id, twoFactorEnabled: false })).toBe(false);
    await db().verification.updateMany({
      where: { id: row!.id },
      data: { expiresAt: new Date(Date.now() + HOUR) },
    });
    await db().user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect(await claimSignInLink(db(), { id: row!.id, userId: id, twoFactorEnabled: false })).toBe(false);
    await db().user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() + HOUR) } });
    // FR-AU-83: nor does a claim that makes a session take the link of an
    // account whose two-factor authentication is on, and it lifts nothing.
    await db().user.update({ where: { id }, data: { twoFactorEnabled: true } });
    expect(await claimSignInLink(db(), { id: row!.id, userId: id, twoFactorEnabled: false })).toBe(false);
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await links(id)).toHaveLength(1);
    await db().user.update({ where: { id }, data: { twoFactorEnabled: false } });
    // Nor does it take a row that is no sign-in link, a reset link among them.
    await db().verification.updateMany({
      where: { id: row!.id },
      data: { identifier: `reset-password:${hashOf(token)}` },
    });
    expect(await claimSignInLink(db(), { id: row!.id, userId: id, twoFactorEnabled: false })).toBe(false);
    await db().verification.updateMany({ where: { id: row!.id }, data: { expiresAt: new Date(0) } });
    // NFR-RE-15: the timer removes the row.
    await deleteExpiredTokens();
    expect(await links(id)).toEqual([]);
  });

  it('refuses a link where no lock is in force, whatever its row says', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    await db().user.update({ where: { id }, data: { lockedUntil: null } });
    expect((await confirm(token)).response.status).toBe(409);
    expect(await sessions(id)).toEqual([]);
    // NFR-SE-19: a link that is void signs no one in, and no entry says it did.
    expect(await entriesOf('sign_in_by_link')).toBe(0);
  });

  it('answers a token that is not known as one that is spent, and a request with anything else 422', async () => {
    const unknown = await confirm('C'.repeat(43));
    expect(unknown.response.status).toBe(409);
    expect(await unknown.response.text()).toBe(NOT_VALID);
    // NFR-SE-19: a sign-in refused; no user is known.
    expect(await logged()).toEqual([{ kind: 'sign_in_refused', userId: null }]);

    const { email } = await person();
    const token = await lock(email);
    for (const body of [{}, { token, email }, { token: 7 }, [token], { token, rememberMe: true }]) {
      const refused = await post(auth, '/sign-in/link', body, fresh());
      expect(refused.response.status).toBe(422);
      expect((await refused.response.json()).error.code).toBe('invalid_request');
    }
    expect((await confirm(token)).response.status).toBe(200);
  });

  it('answers no GET, and no request can ask for a link', async () => {
    const get = await handle(auth, new Request(`${ORIGIN}/api/auth/sign-in/link`, { headers: fresh() }));
    expect(get.status).toBe(404);
    // An account that is not locked has no link, and a sign-in leaves none.
    const { email, id } = await person();
    await fail(email, MOST - 1);
    await attempt(email);
    expect(await links(id)).toEqual([]);
  });

  it('ends the session the browser held, of another account, before it signs the person in', async () => {
    const other = await person();
    const held = cookiesOf(await signIn(auth, other.email, PASSWORD, fresh()));
    const { email, id } = await person();
    const token = await lock(email);
    const confirmed = await confirm(token, { cookie: held });
    expect(confirmed.response.status).toBe(200);
    expect(await sessions(other.id)).toEqual([]);
    expect((await validateSessionRow(new Headers({ cookie: held }))).session).toBeNull();
    const cookie = withCookies(held, confirmed.response);
    expect((await validateSessionRow(new Headers({ cookie }))).session?.userId).toBe(id);
    // FR-ED-40 (d): the collaboration server is told, once the claim had committed, by the account that held it.
    await until(() => channel.sessionsEnded(other.id).length === 1);
    // A link that no longer works ends nothing, and tells no one.
    const again = cookiesOf(await signIn(auth, other.email, PASSWORD, fresh()));
    expect((await confirm(token, { cookie: again })).response.status).toBe(409);
    expect(await sessions(other.id)).toHaveLength(1);
    await channel.quiet();
    expect(channel.sessionsEnded(other.id)).toHaveLength(1);
  });

  it('lands an account of the founding team without a second factor on the enrolment, as any sign-in does', async () => {
    const id = await createAccount(auth, 'founder@example.com');
    const confirmed = await confirm(await lock('founder@example.com'));
    expect(confirmed.response.status).toBe(200);
    const validation = await validateSessionRow(new Headers({ cookie: cookiesOf(confirmed.response) }));
    expect(validation.session).toBeNull();
    expect(validation.stopped?.userId).toBe(id);
  });
});

describe('what makes the link void (FR-AU-81, FR-AU-86)', () => {
  it('a completed password reset, which lifts the lock and clears the counts so that the person signs in at once', async () => {
    const { email, id } = await person();
    const token = await lock(email);
    const asked = await post(auth, '/request-password-reset', { email }, fresh());
    await asked.after();
    const mail = (await sunk(sink)).filter((message) => message.to === email).at(-1)!;
    const reset = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(mail.text)![1]!;
    const completed = await post(auth, '/reset-password', { token: reset, newPassword: NEW }, fresh());
    expect(completed.response.status).toBe(200);

    expect((await account(id)).lockedUntil).toBeNull();
    expect(await links(id)).toEqual([]);
    const late = await confirm(token);
    expect(late.response.status).toBe(409);
    expect(await late.response.text()).toBe(NOT_VALID);
    expect(await sessions(id)).toEqual([]);
    expect((await attempt(email, NEW)).response.status).toBe(200);
  });

  it('a change of the password', async () => {
    const { email, id } = await person();
    const cookie = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
    // A link that is outstanding, written as a lock writes one.
    await db().verification.create({
      data: {
        id: randomUUID(),
        identifier: LINK + hashOf('D'.repeat(43)),
        value: id,
        expiresAt: new Date(Date.now() + HOUR),
      },
    });
    const changed = await post(
      auth,
      '/change-password',
      { currentPassword: PASSWORD, newPassword: NEW },
      { cookie, ...fresh() },
    );
    expect(changed.response.status).toBe(200);
    expect(await links(id)).toEqual([]);
  });
});

describe('the link of an account with two-factor authentication on (FR-AU-81, FR-AU-83; A104)', () => {
  it('goes to the second step and never straight to a session; the code then signs in and lifts the lock', async () => {
    const { email, id, secret } = await enrolled();
    const token = await lock(email);
    const confirmed = await confirm(token);
    expect(confirmed.response.status).toBe(200);
    expect(await confirmed.response.text()).toBe('{"twoFactorRedirect":true}');
    // No session, and nothing is lifted or spent by the link alone.
    expect(await sessions(id)).toEqual([]);
    expect(confirmed.response.headers.getSetCookie().join()).not.toContain('session_token');
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await links(id)).toHaveLength(1);
    const [step] = await steps(id);
    expect(step!.identifier).toMatch(/^second-step:link:[0-9a-f]{64}$/);
    // NFR-SE-19: no one is signed in where the step merely opens.
    expect(await entriesOf('sign_in_by_link')).toBe(0);

    const cookie = withCookies('', confirmed.response);
    const done = await secondStep(auth, cookie, nextCode(secret), 'totp', fresh());
    expect(done.status).toBe(200);
    expect(await done.text()).toBe('{}');
    expect(
      (await validateSessionRow(new Headers({ cookie: withCookies(cookie, done) }))).session?.userId,
    ).toBe(id);
    expect(await sessions(id)).toHaveLength(1);
    expect((await account(id)).lockedUntil).toBeNull();
    expect(await links(id)).toEqual([]);
    expect(await steps(id)).toEqual([]);
    // NFR-SE-19: one entry, where the second step completed the sign-in.
    expect(await db().securityLogEntry.findMany({ where: { kind: 'sign_in_by_link' } })).toEqual([
      {
        id: expect.any(String),
        createdAt: expect.any(Date),
        kind: 'sign_in_by_link',
        userId: id,
        documentId: null,
      },
    ]);
    // The link is spent, and the counts are cleared.
    expect((await confirm(token)).response.status).toBe(409);
    expect(await passwordStep(auth, email, fresh())).toContain('two_factor');
  });

  it('spends the link where the step is abandoned after five wrong codes, counts no failed sign-in, and keeps the lock', async () => {
    const { email, id, secret } = await enrolled();
    const token = await lock(email);
    const { lockedUntil } = await account(id);
    const cookie = withCookies('', (await confirm(token)).response);
    const counted = vi.spyOn(valkey(), 'eval');
    const most = settings().secondStepWrongCodes;
    for (let n = 1; n < most; n++) {
      const wrong = await secondStep(auth, cookie, wrongCode(secret), 'totp', fresh());
      expect(wrong.status).toBe(401);
      expect((await wrong.json()).error.code).toBe('code_refused');
    }
    const last = await secondStep(auth, cookie, wrongCode(secret), 'totp', fresh());
    expect(last.status).toBe(401);
    expect(await last.text()).toBe(NOT_VALID);
    // NFR-SE-07: "the abandoned step is not counted": no limit is asked or counted at all.
    expect(counted).not.toHaveBeenCalled();
    expect(await links(id)).toEqual([]);
    expect(await steps(id)).toEqual([]);
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).toEqual(lockedUntil);
    expect(await mailTo(email)).toHaveLength(1);
    // "Nothing begins again": neither the step nor the link.
    expect((await secondStep(auth, cookie, nextCode(secret), 'totp', fresh())).status).toBe(401);
    expect((await confirm(token)).response.status).toBe(409);
    expect(await sessions(id)).toEqual([]);
    // NFR-SE-19: an abandoned step signed no one in.
    expect(await entriesOf('sign_in_by_link')).toBe(0);
  });

  it('gives a link five codes in all, however often it is opened again', async () => {
    const { email, id, secret } = await enrolled();
    const token = await lock(email);
    const most = settings().secondStepWrongCodes;
    let tried = 0;
    let last: Response | undefined;
    // Two codes for each step, and the link opened again after them.
    while (tried < most) {
      const opened = await confirm(token);
      expect(opened.response.status).toBe(200);
      const cookie = withCookies('', opened.response);
      for (let n = 0; n < 2 && tried < most; n++, tried++) {
        last = await secondStep(auth, cookie, wrongCode(secret), 'totp', fresh());
      }
    }
    expect(await last!.text()).toBe(NOT_VALID);
    expect(await links(id)).toEqual([]);
    expect((await confirm(token)).response.status).toBe(409);
    expect(await sessions(id)).toEqual([]);
  });

  it('completes no step whose link was made void meanwhile, and lifts nothing', async () => {
    const { email, id, secret } = await enrolled();
    const cookie = withCookies('', (await confirm(await lock(email))).response);
    await db().verification.deleteMany({ where: { value: id, identifier: { startsWith: LINK } } });
    const refused = await secondStep(auth, cookie, nextCode(secret), 'totp', fresh());
    expect(refused.status).toBe(401);
    expect(await refused.text()).toBe(NOT_VALID);
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await entriesOf('sign_in_by_link')).toBe(0);
  });

  // NFR-SE-19; the owner's decision of 12 October 2026 (R38; register row
  // D153, pending): the second place a sign-in by the link completes
  // (two-factor.ts), which had no test of its entry's transaction.
  it('writes the entry in the transaction that completes the step: where it cannot be written, no one is signed in and nothing is spent', async () => {
    const { email, id, secret } = await enrolled();
    const cookie = withCookies('', (await confirm(await lock(email))).response);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    failCreateIn('securityLogEntry', 'the entry was not written');
    const failed = await secondStep(auth, cookie, nextCode(secret), 'totp', fresh());
    expect(failed.status).toBe(500);
    expect(failed.headers.getSetCookie().join()).not.toContain('session_token');
    expect(errors.mock.calls).toEqual([['identity: request failed (Error)']]);
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await links(id)).toHaveLength(1);
    expect(await steps(id)).toHaveLength(1);
    expect(await entriesOf('sign_in_by_link')).toBe(0);
    // Neither the step nor the link was spent by the fault. The code is the
    // third of this secret, that of the step before: asked for with time left
    // in this step, or it would be two steps old when the server reads it.
    await midStep();
    expect((await secondStep(auth, cookie, nextCode(secret), 'totp', fresh())).status).toBe(200);
    expect(await entries('sign_in_by_link', id)).toBe(1);
  });

  it('leaves no entry of a step that did not complete: a transaction that fails after the entry undoes it', async () => {
    const { email, id, secret } = await enrolled();
    const cookie = withCookies('', (await confirm(await lock(email))).response);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    failCreateIn('securityLogEntry', 'not committed', true);
    expect((await secondStep(auth, cookie, nextCode(secret), 'totp', fresh())).status).toBe(500);
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).not.toBeNull();
    expect(await links(id)).toHaveLength(1);
    expect(await steps(id)).toHaveLength(1);
    // An entry written outside the transaction would be here (the owner's
    // decision of 12 October 2026: R38; register row D153, pending).
    expect(await entriesOf('sign_in_by_link')).toBe(0);
  });

  it('completes no step once the lock has ended, the link being void with it', async () => {
    const { email, id, secret } = await enrolled();
    const cookie = withCookies('', (await confirm(await lock(email))).response);
    await db().user.update({ where: { id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await secondStep(auth, cookie, nextCode(secret), 'totp', fresh())).status).toBe(401);
    expect(await sessions(id)).toEqual([]);
  });

  it('keeps the step of a link no longer than the link', async () => {
    const { email, id } = await enrolled();
    const token = await lock(email);
    const soon = new Date(Date.now() + 30_000);
    await db().user.update({ where: { id }, data: { lockedUntil: soon } });
    const confirmed = await confirm(token);
    const [step] = await steps(id);
    expect(step!.expiresAt.getTime()).toBeLessThanOrEqual(soon.getTime());
    const cookie = confirmed.response.headers.getSetCookie().find((set) => set.includes('two_factor='))!;
    expect(Number(/Max-Age=(\d+)/i.exec(cookie)![1])).toBeLessThanOrEqual(30);
  });

  it('refuses, while the account is locked, a step that a password began before the lock', async () => {
    const { email, id, secret } = await enrolled();
    const cookie = await passwordStep(auth, email, fresh());
    await lock(email);
    // Only the lock refuses: the count that caused it is cleared.
    await clearFailedSignIns(email);
    const refused = await secondStep(auth, cookie, nextCode(secret), 'totp', fresh());
    expect(refused.status).toBe(401);
    expect((await refused.json()).error.code).toBe('sign_in_again');
    expect(await sessions(id)).toEqual([]);
    expect((await account(id)).lockedUntil).not.toBeNull();
  });

  it('ends the session the browser held at the confirmation, before the code', async () => {
    const other = await person();
    const held = cookiesOf(await signIn(auth, other.email, PASSWORD, fresh()));
    const { email } = await enrolled();
    const confirmed = await confirm(await lock(email), { cookie: held });
    expect(confirmed.response.status).toBe(200);
    expect(await sessions(other.id)).toEqual([]);
    await until(() => channel.sessionsEnded(other.id).length === 1);
  });
});

describe('what is logged (NFR-SE-19)', () => {
  it('holds no address, no token and no link, at a lock, at a refusal, and at a confirmation', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { email, id } = await person();
    const token = await lock(email);
    await attempt(email);
    await confirm('E'.repeat(43));
    await confirm(token);
    await confirm(token);
    const printed = JSON.stringify(spies.flatMap((spy) => spy.mock.calls));
    expect(printed).not.toContain(email);
    expect(printed).not.toContain(token);
    expect(printed).not.toContain('sign-in/link');
    // The security log: the time, the kind, the user, and nothing else.
    const entries = await db().securityLogEntry.findMany();
    expect(entries.length).toBeGreaterThan(0);
    // The lock, the sign-in by its link, and the refusals, each once or more.
    expect(new Set(entries.map((entry) => entry.kind))).toEqual(
      new Set(['sign_in_locked', 'sign_in_by_link', 'sign_in_refused', 'rate_limit_reached']),
    );
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['createdAt', 'documentId', 'id', 'kind', 'userId']);
      expect([null, id]).toContain(entry.userId);
    }
    expect(JSON.stringify(entries)).not.toContain(token);
  });
});
