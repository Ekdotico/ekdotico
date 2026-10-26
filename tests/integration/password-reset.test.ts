// The reset of a password by an emailed link (FR-AU-86, FR-AU-87 (c), (d); the
// reset rows of NFR-SE-07; NFR-RE-15), through the identity library's handler
// as the route calls it, against a provisioned database, Valkey, and the local
// sink of email.
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-reset-mail-'));
const database = prepare('reset', {
  // One trusted proxy, so that a request can come from a network address of its own.
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: sink,
});
// What the route hands to `after` of Next.js, kept here and not run, so that a
// test can look between the answer and the work that follows it.
const scheduled = vi.hoisted(() => [] as (() => Promise<unknown>)[]);
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (task: () => Promise<unknown>) => void scheduled.push(task),
}));

const { auth, db, valkey, validateSession, validateSessionRow } = await load();
const { findOpenReset, deleteExpiredTokens } = await import('../../src/lib/auth/password.ts');
const { proxy } = await import('../../src/proxy.ts');
const route = await import('../../src/app/api/auth/[...all]/route.ts');

// Written out here and not imported: every character is the requirement's.
// FR-AU-86.
const REQUESTED =
  '{"message":"If this address belongs to an account, Ekdotico has sent it an email with a link to set a new password."}';
// FR-AU-87 (c), around the link.
const RESET_SUBJECT = 'Set a new password for Ekdotico';
const RESET_TEXT = (link: string) =>
  `You asked to set a new password for your Ekdotico account. To set it, open this link: ${link}. The link works once and is valid for 1 hour. If you did not ask for this, you can ignore this email, and your password stays as it is.`;
// FR-AU-87 (d).
const NOTICE_SUBJECT = 'The password of your Ekdotico account was changed';
const NOTICE_TEXT =
  'The password of your Ekdotico account was changed. If you did not change it, set a new password from the sign-in page.';
// FR-AU-81.
const SIGN_IN_REFUSED =
  '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}';
// The application's own words (the owner's answer to Q6 of the plan).
const NOT_VALID =
  '{"error":{"code":"reset_link_not_valid","message":"This link is no longer valid. A link to set a new password works once and is valid for 1 hour. Ask for a new one."}}';

const NEW = 'a new password, long enough';
const WRONG = 'a wrong password, long enough';
const HOUR = 60 * 60 * 1000;

let addresses = 0;
/** A network address no earlier request came from, as the one trusted proxy reports it. */
const fresh = () => ({ 'x-forwarded-for': `10.${Math.floor(++addresses / 250)}.${addresses % 250}.7` });
const from = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}` });

let people = 0;
const address = () => `person${++people}@example.com`;
/**
 * An address that no account can have (the owner's decision of 9 October 2026:
 * a full-width letter in its domain). A request for a reset does not refuse it
 * for that: it finds no account, as any unknown address.
 */
const neverStored = () => `person${++people}@\u{ff45}xample.com`;
async function person(verified = true) {
  const email = address();
  return { email, id: await createAccount(auth, email, verified) };
}

const request = (email: unknown, headers: Record<string, string> = fresh()) =>
  post(auth, '/request-password-reset', { email }, headers);
const complete = (token: unknown, newPassword: unknown, headers: Record<string, string> = {}) =>
  post(auth, '/reset-password', { token, newPassword }, headers);
const mailTo = async (email: string, subject: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject === subject);
/** Asks for a reset and reads the token of the link from the email, as the person would. */
async function linkFor(email: string): Promise<string> {
  const asked = await request(email);
  expect(asked.response.status).toBe(200);
  await asked.after();
  const message = (await mailTo(email, RESET_SUBJECT)).at(-1);
  return /\/reset-password\/([A-Za-z0-9_-]+)/.exec(message!.text)![1]!;
}
const links = (userId: string) => db().verification.findMany({ where: { value: userId } });
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');
/** Next.js continues to the route only on this header of the proxy's response. */
const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a request for a reset (FR-AU-86)', () => {
  it('sends the verified address of an account one email, with the fixed text and a link of this origin', async () => {
    const { email, id } = await person();
    const asked = await request(email);
    expect(asked.response.status).toBe(200);
    expect(await asked.response.text()).toBe(REQUESTED);
    await asked.after();

    const messages = await mailTo(email, RESET_SUBJECT);
    expect(messages).toHaveLength(1);
    const token = /\/reset-password\/([A-Za-z0-9_-]+)/.exec(messages[0]!.text)![1]!;
    expect(messages[0]!.text).toBe(RESET_TEXT(`${ORIGIN}/reset-password/${token}`));
    // 256 bits, in the alphabet the allow-list of the proxy takes a token to be made of.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await links(id)).toHaveLength(1);
  });

  it('compares the address in lower case, and sends to the address as it is stored', async () => {
    const { email } = await person();
    const asked = await request(email.toUpperCase());
    await asked.after();
    expect(await mailTo(email, RESET_SUBJECT)).toHaveLength(1);
    expect(await mailTo(email.toUpperCase(), RESET_SUBJECT)).toHaveLength(0);
  });

  it.each([
    ['an extra field', (email: string) => ({ email, redirectTo: '/settings' })],
    ['a callback', (email: string) => ({ email, callbackURL: '/x' })],
    ['an address that is not text', () => ({ email: ['a@example.com'] })],
    ['no address', () => ({})],
    ['a list', (email: string) => [email]],
    ['nothing', () => 'null'],
  ])('refuses %s with a 422, and sends nothing', async (_name, body) => {
    const { email, id } = await person();
    const asked = await post(auth, '/request-password-reset', body(email), fresh());
    expect(asked.response.status).toBe(422);
    expect(await asked.response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request must hold an email address, and nothing else.',
      },
    });
    expect(asked.left).toBe(0);
    expect(await links(id)).toHaveLength(0);
  });

  it('takes no place to go to from the request: one on another origin is refused by the library first', async () => {
    const { email, id } = await person();
    const asked = await post(
      auth,
      '/request-password-reset',
      { email, redirectTo: 'https://evil.example/' },
      fresh(),
    );
    expect(asked.response.status).toBe(403);
    // In the one shape of an error, and in the words of the proxy's 403 (the owner's answer to Q8).
    expect(await asked.response.text()).toBe(
      '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}',
    );
    expect(asked.left).toBe(0);
    expect(await links(id)).toHaveLength(0);
    // NFR-SE-19: a 403 has its entry, with no user. The library does not wait for it.
    await vi.waitFor(async () =>
      expect((await db().securityLogEntry.findMany()).map(({ kind, userId }) => [kind, userId])).toEqual([
        ['forbidden', null],
      ]),
    );
  });
});

describe('the answer does not show who is registered (FR-AU-86, FR-AU-81)', () => {
  it('is the same status, body and headers for an account, an unverified one, no account, and no address at all', async () => {
    const known = await person();
    const unverified = await person(false);
    const answers: string[] = [];
    for (const email of [
      known.email,
      unverified.email,
      address(),
      neverStored(),
      'not an address',
      '',
      'x'.repeat(5000),
    ]) {
      const { response } = await request(email);
      expect(response.status).toBe(200);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get('retry-after')).toBeNull();
      answers.push(
        JSON.stringify([
          await response.text(),
          response.headers.get('content-type'),
          response.headers.get('cache-control'),
        ]),
      );
    }
    expect(new Set(answers)).toEqual(new Set([JSON.stringify([REQUESTED, 'application/json', 'no-store'])]));
  });

  it('does the same work before the answer for every address: Valkey twice, no statement, no hash', async () => {
    const known = await person();
    const unverified = await person(false);
    const context = await auth().$context;
    const statements = [
      vi.spyOn(db().user, 'findUnique'),
      vi.spyOn(db().user, 'findFirst'),
      vi.spyOn(db().verification, 'create'),
      vi.spyOn(db().verification, 'findFirst'),
      vi.spyOn(db().securityLogEntry, 'create'),
      vi.spyOn(context.password, 'hash'),
      vi.spyOn(context.password, 'verify'),
    ];
    const asked = vi.spyOn(valkey(), 'eval');

    for (const email of [known.email, unverified.email, address(), neverStored(), 'not an address']) {
      asked.mockClear();
      const { response, left } = await request(email);
      expect(response.status).toBe(200);
      // The two limits, and nothing else.
      expect(asked).toHaveBeenCalledTimes(2);
      for (const statement of statements) expect(statement).not.toHaveBeenCalled();
      // One piece of work is left for after the answer, for every address alike.
      expect(left).toBe(1);
    }
    // Nothing was written or sent while the answers were made.
    expect(await mailTo(known.email, RESET_SUBJECT)).toHaveLength(0);
    expect(await links(known.id)).toHaveLength(0);
  });

  it('answers without the database: the account is looked up only after the answer', async () => {
    const known = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.sql('ALTER TABLE "User" RENAME TO "UserAway"');
    try {
      for (const email of [known.email, address()]) {
        const asked = await request(email);
        expect(asked.response.status).toBe(200);
        expect(await asked.response.text()).toBe(REQUESTED);
        await asked.after();
      }
    } finally {
      database.sql('ALTER TABLE "UserAway" RENAME TO "User"');
    }
    // NFR-SE-19: the work that failed is named, with the class and code of
    // the fault, and nothing it held.
    expect(errors.mock.calls).toEqual([
      ['after response: password reset link failed (PrismaClientKnownRequestError P2021)'],
      ['after response: password reset link failed (PrismaClientKnownRequestError P2021)'],
    ]);
    expect(await mailTo(known.email, RESET_SUBJECT)).toHaveLength(0);
  });

  it('is returned by the route before any of that work starts, which the route hands to `after`', async () => {
    const known = await person();
    scheduled.length = 0;
    const answers: string[] = [];
    for (const email of [known.email, address()]) {
      const response = await route.POST(
        new Request(`${ORIGIN}/api/auth/request-password-reset`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, ...fresh() },
          body: JSON.stringify({ email }),
        }),
      );
      expect(response.status).toBe(200);
      answers.push(await response.text());
    }
    expect(answers).toEqual([REQUESTED, REQUESTED]);
    // One piece of work for each, and neither has run.
    expect(scheduled).toHaveLength(2);
    expect(await mailTo(known.email, RESET_SUBJECT)).toHaveLength(0);
    expect(await links(known.id)).toHaveLength(0);

    for (const task of scheduled.splice(0)) await task();
    expect(await mailTo(known.email, RESET_SUBJECT)).toHaveLength(1);
    expect(await links(known.id)).toHaveLength(1);
  });

  it('hands the notice of a completed reset and of a change of password to `after`, through the route (FR-AU-87 (d))', async () => {
    const { email } = await person();
    const token = await linkFor(email);
    scheduled.length = 0;
    const through = (path: string, body: unknown, headers: Record<string, string> = {}) =>
      route.POST(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN, ...fresh(), ...headers },
          body: JSON.stringify(body),
        }),
      );

    expect((await through('/reset-password', { token, newPassword: NEW })).status).toBe(200);
    const cookie = cookiesOf(await signIn(auth, email, NEW, fresh()));
    const changed = await through(
      '/change-password',
      { currentPassword: NEW, newPassword: 'another password, long enough' },
      { cookie },
    );
    expect(changed.status).toBe(200);
    // One piece of work for each, and neither has run.
    expect(scheduled).toHaveLength(2);
    expect(await mailTo(email, NOTICE_SUBJECT)).toHaveLength(0);

    for (const task of scheduled.splice(0)) await task();
    const notices = await mailTo(email, NOTICE_SUBJECT);
    expect(notices.map((notice) => notice.text)).toEqual([NOTICE_TEXT, NOTICE_TEXT]);
  });

  it('sends nothing, and writes no link, for an address that is not verified or belongs to no account', async () => {
    const unverified = await person(false);
    const unknown = address();
    const before = (await sunk(sink)).length;
    for (const email of [
      unverified.email,
      unknown,
      neverStored(),
      'not an address',
      '',
      'a\u0000b@example.com',
    ]) {
      const asked = await request(email);
      await asked.after();
    }
    expect((await sunk(sink)).length).toBe(before);
    expect(await links(unverified.id)).toHaveLength(0);
    expect(await db().user.count({ where: { email: unknown } })).toBe(0);
  });
});

describe('the limits on requests for a reset (NFR-SE-07; the owner’s answer to Q1)', () => {
  it('sends nothing over 3 in an hour for one email address, with the same answer and no 429', async () => {
    const { email, id } = await person();
    for (let n = 0; n < 3; n++) await (await request(n === 1 ? email.toUpperCase() : email)).after();
    expect(await mailTo(email, RESET_SUBJECT)).toHaveLength(3);

    for (let n = 0; n < 3; n++) {
      const over = await request(email);
      expect(over.response.status).toBe(200);
      expect(await over.response.text()).toBe(REQUESTED);
      expect(over.response.headers.get('retry-after')).toBeNull();
      await over.after();
    }
    expect(await mailTo(email, RESET_SUBJECT)).toHaveLength(3);
    expect(await links(id)).toHaveLength(3);
    // NFR-SE-19: one entry for the limit reached, not one for each request over
    // it, and without a user: the address is not looked up for it.
    const entries = await db().securityLogEntry.findMany();
    expect(entries.map(({ kind, userId }) => [kind, userId])).toEqual([['rate_limit_reached', null]]);

    // Another address is not held back.
    const other = await person();
    await (await request(other.email)).after();
    expect(await mailTo(other.email, RESET_SUBJECT)).toHaveLength(1);
  });

  it('counts an address that belongs to no account as one that does', async () => {
    // Shown by giving the address an account afterwards.
    const email = address();
    for (let n = 0; n < 3; n++) await (await request(email)).after();
    await createAccount(auth, email);
    const over = await request(email);
    expect(await over.response.text()).toBe(REQUESTED);
    await over.after();
    expect(await mailTo(email, RESET_SUBJECT)).toHaveLength(0);
  });

  it('answers 429 over 10 in an hour from one network address, says when to try again, and processes nothing', async () => {
    const { email } = await person();
    for (let n = 0; n < 10; n++) expect((await request(address(), from(1))).response.status).toBe(200);

    const over = await request(email, from(1));
    expect(over.response.status).toBe(429);
    const seconds = Number(over.response.headers.get('retry-after'));
    expect(seconds).toBeGreaterThan(3500);
    expect(seconds).toBeLessThanOrEqual(3600);
    expect(await over.response.json()).toEqual({
      error: {
        code: 'rate_limited',
        message: `Too many requests were made in a short time. Try again in ${seconds} seconds.`,
      },
    });
    expect(over.left).toBe(0);
    expect(await mailTo(email, RESET_SUBJECT)).toHaveLength(0);
    expect(await db().securityLogEntry.count({ where: { kind: 'rate_limit_reached' } })).toBe(1);

    // The request that was refused did not count toward the 3 of its email address.
    for (let n = 0; n < 3; n++) await (await request(email)).after();
    expect(await mailTo(email, RESET_SUBJECT)).toHaveLength(3);
    // Another network address is not held back.
    expect((await request(address(), from(2))).response.status).toBe(200);
  });
});

describe('the link (FR-AU-86)', () => {
  it('is stored only as a hash, and is valid for 1 hour', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const [row] = await links(id);
    expect(row!.identifier).toBe(`reset-password:${hashOf(token)}`);
    expect(row!.expiresAt.getTime()).toBeGreaterThan(Date.now() + HOUR - 60_000);
    expect(row!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + HOUR);
    // Nowhere in the database, in any column of any row.
    expect(database.sql('SELECT * FROM "Verification"')).not.toContain(token);
    expect(database.sql('SELECT * FROM "SecurityLogEntry"')).not.toContain(token);
  });

  it('is a different token each time', async () => {
    const { email } = await person();
    expect(await linkFor(email)).not.toBe(await linkFor(email));
  });

  it('is left valid when another is asked for, so that a third party cannot void it', async () => {
    const { email, id } = await person();
    const first = await linkFor(email);
    const second = await linkFor(email);
    expect(await links(id)).toHaveLength(2);
    expect((await findOpenReset(first))?.userId).toBe(id);
    expect((await findOpenReset(second))?.userId).toBe(id);
    expect((await complete(first, NEW)).response.status).toBe(200);
  });

  it('changes nothing when it is opened, however often', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const before = await links(id);
    for (let n = 0; n < 3; n++) expect(await findOpenReset(token)).toMatchObject({ userId: id, email });
    expect(await links(id)).toEqual(before);
    expect((await signIn(auth, email, PASSWORD, fresh())).status).toBe(200);
  });

  it('is refused once its hour has passed, to the page and to the completion', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    await db().verification.updateMany({
      where: { value: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await findOpenReset(token)).toBeNull();
    const done = await complete(token, NEW);
    expect(done.response.status).toBe(409);
    expect(await done.response.text()).toBe(NOT_VALID);
    expect((await signIn(auth, email, PASSWORD, fresh())).status).toBe(200);
  });

  it('works once', async () => {
    const { email } = await person();
    const token = await linkFor(email);
    expect((await complete(token, NEW)).response.status).toBe(200);
    expect(await findOpenReset(token)).toBeNull();

    const again = await complete(token, 'another password, long enough');
    expect(again.response.status).toBe(409);
    expect(await again.response.text()).toBe(NOT_VALID);
    expect(again.left).toBe(0);
    expect((await signIn(auth, email, NEW, fresh())).status).toBe(200);
  });

  it('sets one password where two submissions of it arrive together', async () => {
    const { email } = await person();
    const token = await linkFor(email);
    const answers = await Promise.all([
      complete(token, 'the first password, long enough'),
      complete(token, 'the second password, long enough'),
    ]);
    expect(answers.map(({ response }) => response.status).sort()).toEqual([200, 409]);
    const won = answers[0]!.response.status === 200 ? 'first' : 'second';
    expect((await signIn(auth, email, `the ${won} password, long enough`, fresh())).status).toBe(200);
    // One notice, for the one change.
    expect(answers.map(({ left }) => left).sort()).toEqual([0, 1]);
  });

  it('answers a token that is not known, not a token, or of an account without an address in the one way', async () => {
    const gone = await person();
    const ofGone = await linkFor(gone.email);
    // A tombstone (FR-AU-58): the row stays, the address does not.
    await db().user.update({ where: { id: gone.id }, data: { email: null, name: null } });

    for (const token of ['x'.repeat(43), 'short', '', '../../etc', 'x'.repeat(5000), ofGone]) {
      expect(await findOpenReset(token)).toBeNull();
      const done = await complete(token, NEW);
      expect(done.response.status, token.slice(0, 12)).toBe(409);
      expect(await done.response.text()).toBe(NOT_VALID);
    }
  });

  it('makes void every other link of the account when one completes, and no link of another account', async () => {
    const { email, id } = await person();
    const other = await person();
    const [first, second, third] = [await linkFor(email), await linkFor(email), await linkFor(email)];
    const ofOther = await linkFor(other.email);

    expect((await complete(second, NEW)).response.status).toBe(200);
    expect(await links(id)).toHaveLength(0);
    for (const token of [first, third]) {
      expect(await findOpenReset(token)).toBeNull();
      expect((await complete(token, 'another password, long enough')).response.status).toBe(409);
    }
    expect((await findOpenReset(ofOther))?.userId).toBe(other.id);
  });
});

describe('the completion of a reset (FR-AU-86, FR-AU-82, FR-AU-85)', () => {
  it('sets the new password: it signs in, and the old one no longer does', async () => {
    const { email, id } = await person();
    const done = await complete(await linkFor(email), NEW);
    expect(done.response.status).toBe(200);
    expect(await done.response.text()).toBe('{}');
    expect(done.response.headers.get('cache-control')).toBe('no-store');

    expect((await signIn(auth, email, NEW, fresh())).status).toBe(200);
    const old = await signIn(auth, email, PASSWORD, fresh());
    expect(old.status).toBe(401);
    expect(await old.text()).toBe(SIGN_IN_REFUSED);
    // NFR-SE-17 (a): stored only as the library's salted scrypt hash.
    const { password } = await db().account.findFirstOrThrow({ where: { userId: id } });
    expect(password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(password).not.toContain(NEW);
  });

  it('does not sign the person in', async () => {
    const { email, id } = await person();
    const done = await complete(await linkFor(email), NEW);
    expect(done.response.status).toBe(200);
    expect(done.response.headers.getSetCookie()).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('judges the password by the rules of FR-AU-82, says which was not met, and spends nothing', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const local = email.split('@')[0]!;
    for (const [password, rule] of [
      ['short', 'A password has at least 8 characters. Choose a longer one.'],
      ['x'.repeat(33), 'A password has at most 32 characters. Choose a shorter one.'],
      // The library alone would take this: it counts 32 units, where there are 33 characters.
      ['𝒳'.repeat(4) + 'x'.repeat(29), 'A password has at most 32 characters. Choose a shorter one.'],
      [
        `${local} and more`,
        'A password cannot contain your email address or the part of it before the @ sign, because that makes it easier to guess. Choose a different one.',
      ],
      [
        'PasswordPassword',
        'This password is on a list of commonly used and known-compromised passwords, so it cannot be used. Choose a different one.',
      ],
    ] as const) {
      const refused = await complete(token, password);
      expect(refused.response.status, password).toBe(422);
      expect(await refused.response.json()).toEqual({
        error: {
          code: 'invalid',
          message:
            'The password was not changed, because the new password does not meet its rule. Change what is marked and try again.',
          fields: { newPassword: rule },
        },
      });
      expect(refused.left).toBe(0);
    }
    // The link is still good, and the old password still signs in.
    expect((await findOpenReset(token))?.userId).toBe(id);
    expect((await signIn(auth, email, PASSWORD, fresh())).status).toBe(200);
    expect((await complete(token, NEW)).response.status).toBe(200);
  });

  it('settles whether the link is valid before it says anything of the password', async () => {
    const done = await complete('x'.repeat(43), 'short');
    expect(done.response.status).toBe(409);
    expect(await done.response.text()).toBe(NOT_VALID);
  });

  it.each([
    ['an extra field', (token: string) => ({ token, newPassword: NEW, revokeOtherSessions: false })],
    ['no password', (token: string) => ({ token })],
    ['no token', () => ({ newPassword: NEW })],
    ['a password that is not text', (token: string) => ({ token, newPassword: 12345678 })],
    ['a token that is not text', (token: string) => ({ token: [token], newPassword: NEW })],
  ])('refuses %s with a 422, and changes nothing', async (_name, body) => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const refused = await post(auth, '/reset-password', body(token));
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request must hold the token of a link and a new password, and nothing else.',
      },
    });
    expect((await findOpenReset(token))?.userId).toBe(id);
    expect((await signIn(auth, email, PASSWORD, fresh())).status).toBe(200);
  });

  it('ends every session of the account, which a request that reads the row refuses at once', async () => {
    const { email, id } = await person();
    const other = await person();
    const browsers = [
      cookiesOf(await signIn(auth, email, PASSWORD, fresh())),
      cookiesOf(await signIn(auth, email, PASSWORD, fresh())),
    ];
    const ofOther = cookiesOf(await signIn(auth, other.email, PASSWORD, fresh()));
    expect(await db().session.count({ where: { userId: id } })).toBe(2);

    expect((await complete(await linkFor(email), NEW)).response.status).toBe(200);

    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    for (const cookie of browsers) {
      const headers = new Headers({ cookie });
      expect((await validateSessionRow(headers)).session).toBeNull();
      expect((await validateSession('POST', headers)).session).toBeNull();
      // Through an endpoint that changes state, and through the proxy.
      const ended = await post(auth, '/revoke-other-sessions', undefined, { cookie });
      expect(ended.response.status).toBe(401);
      const refused = await proxy(
        new NextRequest(`${ORIGIN}/api/auth/change-password`, {
          method: 'POST',
          headers: { cookie, origin: ORIGIN },
        }),
      );
      expect(refused.status).toBe(401);
    }
    // The sessions of another account stand.
    expect((await validateSessionRow(new Headers({ cookie: ofOther }))).session?.userId).toBe(other.id);
  });

  it('clears the cookies of a browser that held a session of the account, and of no other', async () => {
    const { email } = await person();
    const other = await person();
    const own = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
    const done = await complete(await linkFor(email), NEW, { cookie: own });
    const cleared = done.response.headers.getSetCookie();
    for (const name of ['session_token', 'session_data']) {
      expect(cleared.find((cookie) => cookie.includes(`${name}=;`))).toContain('Max-Age=0');
    }
    // What the browser sends afterwards is refused on a read too: no signed copy is left.
    expect(
      (await validateSession('GET', new Headers({ cookie: cookiesOf(done.response) }))).session,
    ).toBeNull();

    // A browser that holds a session of another account keeps it.
    const foreign = cookiesOf(await signIn(auth, other.email, PASSWORD, fresh()));
    const second = await complete(await linkFor(email), 'another password, long enough', { cookie: foreign });
    expect(second.response.status).toBe(200);
    expect(second.response.headers.getSetCookie()).toEqual([]);
    expect((await validateSessionRow(new Headers({ cookie: foreign }))).session?.userId).toBe(other.id);
  });

  it('sends the notice of a changed password, with its fixed text, after the answer', async () => {
    const { email } = await person();
    const token = await linkFor(email);
    const done = await complete(token, NEW);
    expect(done.response.status).toBe(200);
    // Not before the answer has been returned (FR-AU-87).
    expect(await mailTo(email, NOTICE_SUBJECT)).toHaveLength(0);
    expect(done.left).toBe(1);
    await done.after();

    const notices = await mailTo(email, NOTICE_SUBJECT);
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toBe(NOTICE_TEXT);
    // FR-AU-87: no personal data but the address it is sent to, and never a password.
    for (const message of await sunk(sink)) expect(message.text).not.toContain(NEW);
  });

  it('does not turn two-factor authentication off', async () => {
    const { email, id } = await person();
    await db().user.update({ where: { id }, data: { twoFactorEnabled: true } });
    await db().twoFactor.create({ data: { id: `tf-${id}`, userId: id, secret: 's', backupCodes: 'c' } });
    expect((await complete(await linkFor(email), NEW)).response.status).toBe(200);

    expect((await db().user.findUniqueOrThrow({ where: { id } })).twoFactorEnabled).toBe(true);
    expect(await db().twoFactor.count({ where: { userId: id } })).toBe(1);
    // The new password is followed by the second step, and begins no session by itself.
    const response = await signIn(auth, email, NEW, fresh());
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('writes nothing to the console, and neither the token nor a password anywhere (NFR-SE-19)', async () => {
    const { email } = await person();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');

    const token = await linkFor(email);
    await (await request(address())).after();
    await complete(token, 'short');
    const done = await complete(token, NEW);
    await done.after();
    await complete(token, NEW);
    await complete('x'.repeat(43), NEW);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    const stored = database.sql('SELECT * FROM "SecurityLogEntry"');
    for (const secret of [token, NEW, 'example.com']) expect(stored).not.toContain(secret);
  });

  it('changes nothing where the database cannot answer, and prints nothing of the fault', async () => {
    const { email, id } = await person();
    const token = await linkFor(email);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.sql('ALTER TABLE "Account" RENAME TO "AccountAway"');
    try {
      const done = await complete(token, NEW);
      expect(done.response.status).toBe(500);
      expect(done.left).toBe(0);
    } finally {
      database.sql('ALTER TABLE "AccountAway" RENAME TO "Account"');
    }
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toEqual(['identity: request failed (PrismaClientKnownRequestError P2021)']);
    // The link was not spent, and the password is the old one.
    expect((await findOpenReset(token))?.userId).toBe(id);
    expect((await signIn(auth, email, PASSWORD, fresh())).status).toBe(200);
  });
});

describe('a completed reset clears the counts of failed sign-ins (NFR-SE-07, FR-AU-86)', () => {
  it('clears the 5 of one network address, so that the person signs in at once, and the count starts again', async () => {
    const { email } = await person();
    for (let n = 0; n < 5; n++) expect((await signIn(auth, email, WRONG, from(20))).status).toBe(401);
    // Held back, the right password included.
    expect((await signIn(auth, email, PASSWORD, from(20))).status).toBe(401);

    expect((await complete(await linkFor(email), NEW)).response.status).toBe(200);
    expect((await signIn(auth, email, NEW, from(20))).status).toBe(200);

    // The count starts again: four failures are not five, and five are.
    for (let n = 0; n < 4; n++) expect((await signIn(auth, email, WRONG, from(20))).status).toBe(401);
    expect((await signIn(auth, email, NEW, from(20))).status).toBe(200);
    expect((await signIn(auth, email, WRONG, from(20))).status).toBe(401);
    expect((await signIn(auth, email, NEW, from(20))).status).toBe(401);
  });

  it('clears the 5 of every network address, not only of the one the reset came from', async () => {
    const { email } = await person();
    for (const net of [30, 31]) {
      for (let n = 0; n < 5; n++) await signIn(auth, email, WRONG, from(net));
      expect((await signIn(auth, email, PASSWORD, from(net))).status).toBe(401);
    }
    expect((await complete(await linkFor(email), NEW, from(32))).response.status).toBe(200);
    for (const net of [30, 31]) expect((await signIn(auth, email, NEW, from(net))).status).toBe(200);
  });

  it('clears the 20 of all network addresses', async () => {
    const { email } = await person();
    for (let n = 0; n < 20; n++) await signIn(auth, email, WRONG, from(40 + (n % 5)));
    expect((await signIn(auth, email, PASSWORD, from(50))).status).toBe(401);

    expect((await complete(await linkFor(email), NEW)).response.status).toBe(200);
    expect((await signIn(auth, email, NEW, from(50))).status).toBe(200);
  }, 30_000);

  it('clears nothing for another address, and nothing where the reset does not complete', async () => {
    const { email } = await person();
    const other = await person();
    for (const each of [email, other.email]) {
      for (let n = 0; n < 5; n++) await signIn(auth, each, WRONG, from(60));
    }
    const token = await linkFor(email);
    // Asked for, opened, and refused for its password: none of these clears.
    await findOpenReset(token);
    expect((await complete(token, 'short')).response.status).toBe(422);
    expect((await signIn(auth, email, PASSWORD, from(60))).status).toBe(401);

    expect((await complete(token, NEW)).response.status).toBe(200);
    expect((await signIn(auth, other.email, PASSWORD, from(60))).status).toBe(401);
  });

  it('completes the reset where Valkey cannot clear, and says so without a word of the fault', async () => {
    const { email } = await person();
    const token = await linkFor(email);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    // The number is raised in a transaction of Valkey that gives it its lifetime (src/lib/auth/sign-in.ts).
    vi.spyOn(valkey(), 'multi').mockImplementation(() => {
      throw new Error('ECONNREFUSED redis://secret@host');
    });
    const done = await complete(token, NEW);
    expect(done.response.status).toBe(200);
    expect(errors.mock.calls).toEqual([['password reset: completed, counts of failed sign-ins not cleared']]);
    vi.restoreAllMocks();
    expect((await signIn(auth, email, NEW, fresh())).status).toBe(200);
  });
});

describe('the two endpoints at the request-interception layer (NFR-SE-05, NFR-SE-17 (c))', () => {
  const through = (path: string, headers: Record<string, string>, method = 'POST') =>
    proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers: { ...fresh(), ...headers } }));

  it('reach the handler without a session, from the application’s own origin alone', async () => {
    for (const path of ['/api/auth/request-password-reset', '/api/auth/reset-password']) {
      expect(passed(await through(path, { origin: ORIGIN }))).toBe(true);
      for (const origin of [{}, { origin: 'https://evil.example' }, { origin: 'null' }] as Record<
        string,
        string
      >[]) {
        const refused = await through(path, origin);
        expect(passed(refused)).toBe(false);
        expect(refused.status).toBe(403);
      }
      // And under no other method.
      expect(passed(await through(path, {}, 'GET'))).toBe(false);
    }
  });

  it('serve the pages of a reset without a session', async () => {
    expect(passed(await through('/reset-password', {}, 'GET'))).toBe(true);
    expect(passed(await through(`/reset-password/${'x'.repeat(43)}`, {}, 'GET'))).toBe(true);
    expect(passed(await through('/settings', {}, 'GET'))).toBe(false);
  });
});

describe('the removal of expired tokens (NFR-RE-15)', () => {
  it('removes the tokens whose time has passed and no other, and a second run finds nothing', async () => {
    const { email, id } = await person();
    const kept = await linkFor(email);
    await linkFor(email);
    const rows = await links(id);
    await db().verification.update({
      where: { id: rows.find((row) => row.identifier !== `reset-password:${hashOf(kept)}`)!.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    // Two instances at once, then one again: the effect once, and no error.
    const removed = await Promise.all([deleteExpiredTokens(), deleteExpiredTokens()]);
    expect(removed.reduce((sum, count) => sum + count, 0)).toBeGreaterThanOrEqual(1);
    expect(await deleteExpiredTokens()).toBe(0);
    expect(await links(id)).toHaveLength(1);
    expect((await findOpenReset(kept))?.userId).toBe(id);
  });
});
