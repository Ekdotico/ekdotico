// Two-factor authentication (FR-AU-83; FR-AU-81; FR-AU-87 (f), (g); NFR-SE-07,
// the row of wrong codes; NFR-SE-17 (a), (c), (d); NFR-SE-19; the owner's
// answers to Q1, Q8 and Q10), through the identity library's handler as the
// route calls it, against a provisioned database, Valkey, and the local sink
// of email. The founding-team gate is in founding-gate.test.ts, and requests
// that cross one another in two-factor-races.test.ts.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import {
  codeAt,
  enrol,
  midStep,
  nextCode,
  passwordStep,
  secondStep,
  unbase32,
  withCookies,
} from './second-factor.ts';

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-two-factor-mail-'));
const database = prepare('twofactor', { TRUSTED_PROXY_COUNT: '1', EMAIL_SINK_DIRECTORY: sink });
const { auth, db, valkey, settings, validateSession, validateSessionRow } = await load();

// Written out here and not imported: every character is the requirement's.
// FR-AU-81, at a prompt for the password (the owner's answer to Q10).
const PASSWORD_REFUSED =
  '{"error":{"code":"password_refused","message":"The email address or the password is not correct."}}';
const SIGN_IN_REFUSED =
  '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}';
const UNAUTHENTICATED =
  '{"error":{"code":"unauthenticated","message":"This request needs a signed-in session. Sign in and try again."}}';
// FR-AU-87 (f) and (g).
const ON_SUBJECT = 'Two-factor authentication was turned on for your Ekdotico account';
const ON_TEXT =
  'Two-factor authentication was turned on for your Ekdotico account. If you did not do this, set a new password from the sign-in page.';
const OFF_SUBJECT = 'Two-factor authentication was turned off for your Ekdotico account';
const OFF_TEXT =
  'Two-factor authentication was turned off for your Ekdotico account. If you did not do this, set a new password from the sign-in page.';
const CODES_SUBJECT = 'The recovery codes of your Ekdotico account were replaced';
const CODES_TEXT =
  'The recovery codes of your Ekdotico account were replaced, and the earlier codes no longer work. If you did not do this, set a new password from the sign-in page.';

const WRONG = 'a wrong password, long enough';
const RECOVERY_CODE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;

let addresses = 0;
/** A network address no earlier request came from. */
const fresh = () => ({ 'x-forwarded-for': `10.7.${Math.floor(++addresses / 250)}.${addresses % 250}` });
let people = 0;
/** A new account with one session, as the Cookie header of its browser. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  const cookie = cookiesOf(await signIn(auth, email, PASSWORD, fresh()));
  return { id, email, cookie };
}
/** A new account with two-factor authentication on. */
async function enrolled() {
  const who = await person();
  return { ...who, ...(await enrol(auth, who.cookie, fresh())) };
}
const enable = (cookie: string, body: unknown = { password: PASSWORD }, net = fresh()) =>
  post(auth, '/two-factor/enable', body, { cookie, ...net });
const confirm = (cookie: string, code: unknown) =>
  post(auth, '/two-factor/verify-totp', { code }, { cookie, ...fresh() });
const turnOff = (cookie: string, body: unknown, net = fresh()) =>
  post(auth, '/two-factor/disable', body, { cookie, ...net });
const replace = (cookie: string, body: unknown = { password: PASSWORD }, net = fresh()) =>
  post(auth, '/two-factor/generate-backup-codes', body, { cookie, ...net });
const isOn = async (id: string) => (await db().user.findUniqueOrThrow({ where: { id } })).twoFactorEnabled;
const rowOf = (userId: string) => db().twoFactor.findUnique({ where: { userId } });
const mail = async (email: string, subject: string) =>
  (await sunk(sink)).filter((message) => message.to === email && message.subject === subject);
const stands = async (cookie: string) => (await validateSessionRow(new Headers({ cookie }))).session !== null;
/** Whether a sign-in with the right password, from this network address, is answered and not refused by a count. */
const passwordAccepted = async (email: string, net: Record<string, string>) =>
  (await signIn(auth, email, PASSWORD, net)).status === 200;
const wrongPassword = async (email: string, net: Record<string, string>) =>
  expect(await (await signIn(auth, email, WRONG, net)).text()).toBe(SIGN_IN_REFUSED);
/** A code of six digits that is none of the three this secret would be accepted for. */
function wrongCode(secret: string): string {
  const right = [-1, 0, 1].map((steps) => codeAt(secret, steps));
  for (let n = 0; ; n++) {
    const code = String(n).padStart(6, '0');
    if (!right.includes(code)) return code;
  }
}
const error = async (response: Response) =>
  ((await response.json()) as { error: { code: string; message: string } }).error;

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the code of an authenticator application (FR-AU-83: RFC 6238)', () => {
  it('is the code the identity library computes for the same secret', { timeout: 20_000 }, async () => {
    await midStep();
    const { secret } = await enrolled();
    // The library's plugin as it ships, apart from the application's
    // configuration, which has none of its endpoints (auth-config.test.ts).
    const { twoFactor } = await import('better-auth/plugins');
    const { code } = await twoFactor().endpoints.generateTOTP({ body: { secret } });
    expect(code).toBe(codeAt(secret, 0));
    expect(code).toMatch(/^[0-9]{6}$/);
  });
});

describe('turning two-factor authentication on (FR-AU-83)', () => {
  it('shows the secret as text and as an address for the authenticator, and turns nothing on', async () => {
    const { id, email, cookie } = await person();
    const begun = await enable(cookie);
    expect(begun.response.status).toBe(200);
    expect(begun.response.headers.get('cache-control')).toBe('no-store');
    const body = (await begun.response.json()) as { secret: string; totpURI: string };
    expect(Object.keys(body).sort()).toEqual(['secret', 'totpURI']);
    // RFC 4648 base32, as an authenticator application takes it typed in.
    expect(body.secret).toMatch(/^[A-Z2-7]{52}$/);
    const uri = new URL(body.totpURI);
    expect(uri.protocol).toBe('otpauth:');
    expect(body.totpURI.startsWith(`otpauth://totp/Ekdotico:${encodeURIComponent(email)}?`)).toBe(true);
    expect(Object.fromEntries(uri.searchParams)).toEqual({
      secret: body.secret,
      issuer: 'Ekdotico',
      digits: '6',
      period: '30',
    });

    // "Only then is it on": nothing is, and nothing was sent.
    expect(await isOn(id)).toBe(false);
    expect(await rowOf(id)).toMatchObject({ verified: false });
    expect(begun.left).toBe(0);
    expect(await mail(email, ON_SUBJECT)).toHaveLength(0);
    // A sign-in is not asked for a code, and gets its session by the password.
    const signed = await signIn(auth, email, PASSWORD, fresh());
    expect(await signed.text()).toBe('{}');
    expect(await stands(cookiesOf(signed))).toBe(true);
    // The session that asked keeps its cookies as they were.
    expect(begun.response.headers.getSetCookie()).toEqual([]);
  });

  it('is on once the first code confirms it, and then shows ten recovery codes, once', async () => {
    const { id, email, cookie } = await person();
    const secret = unbase32(((await (await enable(cookie)).response.json()) as { secret: string }).secret);

    const refused = await confirm(cookie, wrongCode(secret));
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'invalid',
        message: 'The code is not correct. Enter the code that the authenticator application shows now.',
        fields: {
          code: 'The code is not correct. Enter the code that the authenticator application shows now.',
        },
      },
    });
    expect(refused.left).toBe(0);
    expect(await isOn(id)).toBe(false);

    const confirmed = await confirm(cookie, nextCode(secret));
    expect(confirmed.response.status).toBe(200);
    expect(confirmed.response.headers.get('cache-control')).toBe('no-store');
    const body = (await confirmed.response.json()) as { recoveryCodes: string[] };
    expect(Object.keys(body)).toEqual(['recoveryCodes']);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set(body.recoveryCodes).size).toBe(10);
    for (const code of body.recoveryCodes) expect(code).toMatch(RECOVERY_CODE);
    expect(await isOn(id)).toBe(true);
    expect(await rowOf(id)).toMatchObject({ verified: true });

    // FR-AU-87 (f): the notice, with its fixed text, after the answer.
    expect(await mail(email, ON_SUBJECT)).toHaveLength(0);
    expect(confirmed.left).toBe(1);
    await confirmed.after();
    const sent = await mail(email, ON_SUBJECT);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(ON_TEXT);

    // The session that turned it on stays, and its signed copy is a fresh one
    // that says so; no token of a session is set again.
    const set = confirmed.response.headers.getSetCookie();
    expect(set.map((each) => each.split('=')[0])).toEqual(['__Secure-better-auth.session_data']);
    expect(await stands(withCookies(cookie, confirmed.response))).toBe(true);
    // From now a sign-in is asked for the code, and the password alone begins no session.
    const signed = await signIn(auth, email, PASSWORD, fresh());
    expect(await signed.text()).toBe('{"twoFactorRedirect":true}');
    expect(await db().session.count({ where: { userId: id } })).toBe(1);

    // "Once": the first code confirms nothing a second time, and no request shows the codes again.
    const again = await confirm(cookie, codeAt(secret, 1));
    expect(again.response.status).toBe(409);
    expect((await error(again.response)).code).toBe('two_factor_not_begun');
    expect(again.left).toBe(0);
  });

  it('takes a code typed with the spaces or the hyphen it is shown with', async () => {
    const { id, cookie } = await person();
    const secret = unbase32(((await (await enable(cookie)).response.json()) as { secret: string }).secret);
    const code = nextCode(secret);
    expect((await confirm(cookie, `${code.slice(0, 3)} ${code.slice(3)}`)).response.status).toBe(200);
    expect(await isOn(id)).toBe(true);
  });

  it('requires the current password, and counts a wrong one as a failed sign-in (Q10)', async () => {
    const { id, email, cookie } = await person();
    const net = fresh();
    for (let n = 0; n < 4; n++) {
      const refused = await enable(cookie, { password: WRONG }, net);
      expect(refused.response.status).toBe(403);
      expect(await refused.response.text()).toBe(PASSWORD_REFUSED);
    }
    expect(await rowOf(id)).toBeNull();
    // Four are not five.
    expect(await passwordAccepted(email, net)).toBe(true);
    expect((await enable(cookie, { password: WRONG }, net)).response.status).toBe(403);
    // The limit of NFR-SE-07 is reached: the prompt refuses the right password
    // too, in the same words and with no 429, and so does a sign-in.
    const held = await enable(cookie, { password: PASSWORD }, net);
    expect(held.response.status).toBe(403);
    expect(await held.response.text()).toBe(PASSWORD_REFUSED);
    expect(held.response.headers.get('retry-after')).toBeNull();
    expect(await passwordAccepted(email, net)).toBe(false);
    expect(await rowOf(id)).toBeNull();
    // NFR-SE-19: each 403 has its entry, with the user.
    const entries = await db().securityLogEntry.findMany({ where: { kind: 'forbidden' } });
    expect(entries.map((entry) => entry.userId)).toEqual(Array(6).fill(id));
  });

  it('replaces the secret of an enrolment that was not confirmed, and never that of one that was', async () => {
    const { id, cookie } = await person();
    const first = unbase32(((await (await enable(cookie)).response.json()) as { secret: string }).secret);
    const second = unbase32(((await (await enable(cookie)).response.json()) as { secret: string }).secret);
    expect(second).not.toBe(first);
    expect(await db().twoFactor.count({ where: { userId: id } })).toBe(1);
    // The code of the secret that was replaced confirms nothing.
    expect((await confirm(cookie, codeAt(first))).response.status).toBe(422);
    expect(await isOn(id)).toBe(false);
    expect((await confirm(cookie, codeAt(second))).response.status).toBe(200);

    const stored = await rowOf(id);
    const refused = await enable(cookie);
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'two_factor_on',
        message: 'Two-factor authentication is already turned on for this account.',
      },
    });
    expect(await rowOf(id)).toEqual(stored);
  });

  it('confirms nothing where no enrolment was begun', async () => {
    const { id, cookie } = await person();
    const refused = await confirm(cookie, '123456');
    expect(refused.response.status).toBe(409);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'two_factor_not_begun',
        message: 'No secret is waiting for its first code. Enter the password to begin again.',
      },
    });
    expect(await isOn(id)).toBe(false);
  });
});

describe('what is stored, answered and logged (NFR-SE-17 (a), NFR-SE-19)', () => {
  it('holds the secret and the recovery codes encrypted, and never in clear', async () => {
    const { id, cookie } = await person();
    const begun = (await (await enable(cookie)).response.json()) as { secret: string; totpURI: string };
    const secret = unbase32(begun.secret);
    const dump = () => database.sql(`SELECT row_to_json(t) FROM "TwoFactor" t`);
    for (const clear of [secret, begun.secret]) expect(dump()).not.toContain(clear);

    const { recoveryCodes } = (await (await confirm(cookie, nextCode(secret))).response.json()) as {
      recoveryCodes: string[];
    };
    const stored = dump();
    for (const clear of [secret, begun.secret, ...recoveryCodes]) expect(stored).not.toContain(clear);
    // What is stored opens only with the key of the environment (the library's own function).
    const { symmetricDecrypt } = await import('better-auth/crypto');
    const row = (await rowOf(id))!;
    const key = settings().authSecret;
    expect(await symmetricDecrypt({ key, data: row.secret })).toBe(secret);
    expect(JSON.parse(await symmetricDecrypt({ key, data: row.backupCodes }))).toEqual(recoveryCodes);
    await expect(
      symmetricDecrypt({ key: 'another-key-of-at-least-32-characters', data: row.secret }),
    ).rejects.toThrow();
    // Nor is either anywhere else in the database.
    for (const table of ['User', 'Session', 'Account', 'Verification', 'SecurityLogEntry']) {
      const rows = database.sql(`SELECT row_to_json(t) FROM "${table}" t`);
      for (const clear of [secret, begun.secret, ...recoveryCodes]) expect(rows).not.toContain(clear);
    }
  });

  it('shows neither again in any answer, and writes neither, nor a code, to a log', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');

    const { email, id, cookie, secret, recoveryCodes } = await enrolled();
    const secrets = [secret, ...recoveryCodes];
    const bodies: string[] = [];
    const keep = async (response: Response) => {
      bodies.push(await response.text());
      return response;
    };
    // Every request an account with it on can make, right and wrong.
    await keep((await enable(cookie)).response);
    await keep((await confirm(cookie, codeAt(secret, 0))).response);
    await keep(await signIn(auth, email, PASSWORD, fresh()));
    const step = await passwordStep(auth, email, fresh());
    await keep(await secondStep(auth, step, wrongCode(secret)));
    await keep(await secondStep(auth, step, 'not-a-code', 'backup-code'));
    const signed = await keep(await secondStep(auth, step, nextCode(secret)));
    expect(signed.status).toBe(200);
    await keep((await turnOff(cookie, { password: PASSWORD, code: wrongCode(secret) })).response);
    await keep((await turnOff(cookie, { password: WRONG, code: codeAt(secret, 1) })).response);
    // The plugin's endpoint that would show the secret again, and its view of the codes.
    const again = await keep(
      (await post(auth, '/two-factor/get-totp-uri', { password: PASSWORD }, { cookie })).response,
    );
    expect(again.status).toBe(404);
    for (const body of bodies) for (const clear of secrets) expect(body).not.toContain(clear);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    const logged = database.sql('SELECT row_to_json(t) FROM "SecurityLogEntry" t');
    for (const clear of [...secrets, 'example.com', PASSWORD, codeAt(secret, 0)]) {
      expect(logged).not.toContain(clear);
    }
    expect(logged).toContain(id);
  });

  it('leaves the library’s own count and lock of wrong codes unwritten: the only count is that of NFR-SE-07', async () => {
    const { email, id, secret } = await enrolled();
    for (let round = 0; round < 3; round++) {
      const step = await passwordStep(auth, email, fresh());
      for (let n = 0; n < 5; n++) await secondStep(auth, step, wrongCode(secret));
    }
    // Fifteen wrong codes: the library would have locked the account at ten, for 15 minutes.
    expect(await rowOf(id)).toMatchObject({ failedVerificationCount: 0, lockedUntil: null });
    const step = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, step, nextCode(secret))).status).toBe(200);
  });
});

describe('the second step of a sign-in (FR-AU-81, FR-AU-83)', () => {
  it('begins the session only after the code, with an ordinary session and no token in any answer', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });

    const password = await signIn(auth, email, PASSWORD, fresh());
    expect(await password.text()).toBe('{"twoFactorRedirect":true}');
    expect(password.headers.get('cache-control')).toBe('no-store');
    // No session, and no cookie of one: one cookie, that of the step, with the
    // attributes of every cookie of the application and the 10 minutes of FR-AU-83.
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    const set = password.headers.getSetCookie();
    expect(set).toHaveLength(1);
    expect(set[0]).toMatch(/^__Secure-better-auth\.two_factor=/);
    const attributes = set[0]!.toLowerCase().split('; ').slice(1);
    expect(attributes).toEqual(expect.arrayContaining(['max-age=600', 'httponly', 'secure', 'samesite=lax']));
    expect(attributes.some((each) => each.startsWith('domain'))).toBe(false);
    const step = cookiesOf(password);
    expect((await validateSessionRow(new Headers({ cookie: step }))).session).toBeNull();
    expect((await validateSession('GET', new Headers({ cookie: step }))).session).toBeNull();
    // The token of the step is stored only as a hash, for 10 minutes.
    const row = await db().verification.findFirstOrThrow({ where: { value: id } });
    expect(row.identifier).toMatch(/^second-step:[0-9a-f]{64}$/);
    expect(step).not.toContain(row.identifier.slice('second-step:'.length));
    const minutes = (row.expiresAt.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9.9);
    expect(minutes).toBeLessThanOrEqual(10);

    const done = await secondStep(auth, step, nextCode(secret), 'totp', fresh());
    expect(done.status).toBe(200);
    expect(await done.text()).toBe('{}');
    expect(done.headers.get('cache-control')).toBe('no-store');
    // The session: its two cookies, as a sign-in without a second step sets them.
    const cookies = done.headers.getSetCookie();
    const named = (name: string) => cookies.find((each) => each.startsWith(`__Secure-better-auth.${name}=`))!;
    for (const name of ['session_token', 'session_data']) {
      const parts = named(name).toLowerCase().split('; ').slice(1);
      expect(parts).toEqual(expect.arrayContaining(['httponly', 'secure', 'samesite=lax']));
      expect(parts.some((each) => each.startsWith('domain'))).toBe(false);
    }
    expect(named('session_token').toLowerCase()).toContain(`max-age=${settings().sessionIdleSeconds}`);
    // The cookie of the step is cleared, and its row is gone.
    expect(named('two_factor')).toMatch(/two_factor=;.*Max-Age=0/i);
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    const browser = withCookies(step, done);
    const { session } = await validateSessionRow(new Headers({ cookie: browser }));
    expect(session?.userId).toBe(id);
    const stored = await db().session.findMany({ where: { userId: id } });
    expect(stored).toHaveLength(1);
    // FR-AU-84: the network address it began from, as the application derives it.
    expect(stored[0]!.ipAddress).toMatch(/^10\.7\./);
    expect(stored[0]!.expiresAt.getTime() - Date.now()).toBeGreaterThan(
      (settings().sessionIdleSeconds - 60) * 1000,
    );
    // No answer holds the token of the session.
    expect(cookies.join('\n')).toContain(stored[0]!.token);
    for (const body of ['{"twoFactorRedirect":true}', '{}']) expect(body).not.toContain(stored[0]!.token);
  });

  it('remembers no device: the code is asked for at every sign-in, whatever the browser sends back', async () => {
    const { email, id, secret } = await enrolled();
    const first = await passwordStep(auth, email, fresh());
    const done = await secondStep(auth, first, nextCode(secret));
    expect(done.status).toBe(200);
    // Nothing but the session was set: no cookie that would stand for the code.
    expect(
      done.headers
        .getSetCookie()
        .map((each) => each.split('=')[0]!.replace(/^.*\./, ''))
        .sort(),
    ).toEqual(['session_data', 'session_token', 'two_factor']);
    // And no row stands for the device: the library's would be a `trust-device` one.
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    expect(await db().verification.count({ where: { identifier: { startsWith: 'trust-device' } } })).toBe(0);
    await db().session.deleteMany({ where: { userId: id } });

    // The same browser, with every cookie it was ever given.
    const again = await signIn(auth, email, PASSWORD, { ...fresh(), cookie: withCookies(first, done) });
    expect(await again.text()).toBe('{"twoFactorRedirect":true}');
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it.each([
    ['trustDevice', { trustDevice: true }],
    ['disableSession', { disableSession: true }],
    ['a field of no meaning', { anything: null }],
  ])('refuses a request that also holds %s, and remembers nothing', async (_name, extra) => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    for (const kind of ['totp', 'backup-code'] as const) {
      const step = await passwordStep(auth, email, fresh());
      const response = await auth().handler(
        new Request(`${ORIGIN}/api/auth/two-factor/verify-${kind}`, {
          method: 'POST',
          headers: { origin: ORIGIN, 'content-type': 'application/json', cookie: step },
          body: JSON.stringify({ code: nextCode(secret), ...extra }),
        }),
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toEqual({
        error: { code: 'invalid_request', message: 'The request must hold a code, and nothing else.' },
      });
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    expect(await db().verification.count({ where: { identifier: { startsWith: 'trust-device' } } })).toBe(0);
  });

  it.each([
    ['a code that is not text', 123456],
    ['a list', ['123456']],
  ])('refuses %s', async (_name, code) => {
    const { email } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, step, code)).status).toBe(422);
  });

  // It names steps, so it may first wait for a step of 30 seconds to begin.
  it(
    'accepts the code of the step before and of the step after, and of no other',
    { timeout: 20_000 },
    async () => {
      await midStep();
      const { email, secret } = await enrolled();
      for (const steps of [-2, 2, -3, 3]) {
        const step = await passwordStep(auth, email, fresh());
        const refused = await secondStep(auth, step, codeAt(secret, steps));
        expect(refused.status, `${steps} steps away`).toBe(401);
        expect((await error(refused)).code).toBe('code_refused');
      }
      // The enrolment spent the code of this step.
      for (const steps of [-1, 1]) {
        const step = await passwordStep(auth, email, fresh());
        expect((await secondStep(auth, step, codeAt(secret, steps))).status, `${steps} steps away`).toBe(200);
      }
    },
  );

  it('accepts a code once: used again within its 90 seconds it is a wrong code (RFC 6238, 5.2)', async () => {
    const { email, secret } = await enrolled();
    const code = nextCode(secret);
    expect((await secondStep(auth, await passwordStep(auth, email, fresh()), code)).status).toBe(200);
    const step = await passwordStep(auth, email, fresh());
    const replayed = await secondStep(auth, step, code);
    expect(replayed.status).toBe(401);
    expect((await error(replayed)).code).toBe('code_refused');
    // Another code signs in, at the same second step.
    expect((await secondStep(auth, step, nextCode(secret))).status).toBe(200);
    // The mark of a code used is kept where every instance reads it, under a
    // digest: nothing in Valkey names the account.
    expect(await valkey().keys('*totp*')).toEqual([]);
  });

  it('answers a wrong code with its statement, begins no session, and leaves the step open', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    // Four: the fifth would abandon the sign-in.
    for (const code of [wrongCode(secret), '', '1234567', codeAt(secret, 0).slice(0, 5)]) {
      const refused = await secondStep(auth, step, code);
      expect(refused.status).toBe(401);
      // No 429 for this row (the owner's answer to Q1).
      expect(refused.headers.get('retry-after')).toBeNull();
      expect(refused.headers.get('cache-control')).toBe('no-store');
      expect(await refused.json()).toEqual({
        error: {
          code: 'code_refused',
          message: 'The code is not correct. Enter the code that the authenticator application shows now.',
        },
      });
      expect(refused.headers.getSetCookie()).toEqual([]);
    }
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // NFR-SE-19: each is a sign-in refused, with the user.
    const entries = await db().securityLogEntry.findMany();
    expect(entries.map(({ kind, userId }) => [kind, userId])).toEqual(Array(4).fill(['sign_in_refused', id]));
    // The step is still open: the right code completes it.
    expect((await secondStep(auth, step, nextCode(secret))).status).toBe(200);
  });
});

describe('wrong codes, for each sign-in (NFR-SE-07; FR-AU-83; the owner’s answer to Q1)', () => {
  const AGAIN = {
    error: {
      code: 'sign_in_again',
      message:
        'This sign-in can no longer be completed, because its time has passed or too many codes were not correct. Begin again with the email address and the password.',
    },
  };

  it('abandons the sign-in at the fifth, which then begins again with the password', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    for (let n = 0; n < 4; n++) {
      expect((await error(await secondStep(auth, step, wrongCode(secret)))).code).toBe('code_refused');
    }
    const fifth = await secondStep(auth, step, wrongCode(secret));
    expect(fifth.status).toBe(401);
    expect(fifth.headers.get('retry-after')).toBeNull();
    expect(await fifth.json()).toEqual(AGAIN);
    // The step is over: its row is gone and its cookie is cleared.
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    expect(fifth.headers.getSetCookie().join()).toMatch(/two_factor=;.*Max-Age=0/i);

    // A sixth attempt needs the password again: the right code is refused, by
    // a code of the authenticator and by a recovery code alike.
    const code = nextCode(secret);
    const sixth = await secondStep(auth, step, code);
    expect(sixth.status).toBe(401);
    expect(await sixth.json()).toEqual(AGAIN);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // With the password, it begins again, and the code that was refused signs in.
    const next = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, next, code)).status).toBe(200);
  });

  it('counts the wrong codes of both kinds together, and a recovery code does not get five of its own', async () => {
    const { email, id, secret, recoveryCodes } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    for (let n = 0; n < 2; n++) await secondStep(auth, step, wrongCode(secret));
    for (let n = 0; n < 2; n++) await secondStep(auth, step, 'aaaaa-bbbbb', 'backup-code');
    expect(await (await secondStep(auth, step, 'ccccc-ddddd', 'backup-code')).json()).toEqual(AGAIN);
    expect((await secondStep(auth, step, recoveryCodes[0], 'backup-code')).status).toBe(401);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  // The owner's answer G1 of the pull request: "a second step that had at
  // least one wrong code and did not complete counts as one failed sign-in,
  // counted at its first wrong code."
  it('counts one failed sign-in for a second step at its first wrong code, and none for one that completes at once', async () => {
    const { email, secret } = await enrolled();
    const net = fresh();
    // A second step that completes at once counts nothing.
    expect(
      (await secondStep(auth, await passwordStep(auth, email, net), nextCode(secret), 'totp', net)).status,
    ).toBe(200);
    // One wrong code, and the step left open: one failure already, under the
    // 5 in 15 minutes of this address and this network address. Four wrong
    // passwords make five, at which the right password is refused.
    const left = await passwordStep(auth, email, net);
    await secondStep(auth, left, wrongCode(secret), 'totp', net);
    for (let n = 0; n < 4; n++) await wrongPassword(email, net);
    expect(await passwordAccepted(email, net)).toBe(false);
    // From another network address the password is still answered.
    expect(await passwordAccepted(email, fresh())).toBe(true);
  });

  it('counts one for a step of five wrong codes, and keeps the count of a step that then completed', async () => {
    const { email, secret, recoveryCodes } = await enrolled();
    const net = fresh();
    // Five wrong codes of both kinds at one step: one failure.
    const abandoned = await passwordStep(auth, email, net);
    for (let n = 0; n < 3; n++) await secondStep(auth, abandoned, wrongCode(secret), 'totp', net);
    for (let n = 0; n < 2; n++) await secondStep(auth, abandoned, 'aaaaa-bbbbb', 'backup-code', net);
    // One wrong code and then the right one: a failure that happened, and stays.
    const completed = await passwordStep(auth, email, net);
    await secondStep(auth, completed, wrongCode(secret), 'totp', net);
    expect((await secondStep(auth, completed, recoveryCodes[0], 'backup-code', net)).status).toBe(200);
    // Two so far: two wrong passwords make four, and the third makes five.
    for (let n = 0; n < 2; n++) await wrongPassword(email, net);
    expect(await passwordAccepted(email, net)).toBe(true);
    await wrongPassword(email, net);
    expect(await passwordAccepted(email, net)).toBe(false);
  });

  it('counts it toward the 20 in an hour too, from whatever network address', async () => {
    const { email, secret } = await enrolled();
    // Twenty second steps abandoned, each from a network address of its own.
    for (let round = 0; round < 20; round++) {
      const net = fresh();
      expect(await passwordAccepted(email, fresh()), `round ${round}`).toBe(true);
      const step = await passwordStep(auth, email, net);
      for (let n = 0; n < 5; n++) await secondStep(auth, step, wrongCode(secret), 'totp', net);
    }
    // No more than 100 codes in an hour: the password is now refused from everywhere.
    expect(await passwordAccepted(email, fresh())).toBe(false);
  });

  it('sends no notice for it, and logs each refusal and, at the fifth, a rate limit reached (NFR-SE-19)', async () => {
    const { email, id, secret } = await enrolled();
    const before = (await sunk(sink)).filter((message) => message.to === email).length;
    const step = await passwordStep(auth, email, fresh());
    for (let n = 0; n < 6; n++) await secondStep(auth, step, wrongCode(secret));
    expect((await sunk(sink)).filter((message) => message.to === email)).toHaveLength(before);
    const entries = await db().securityLogEntry.findMany({ orderBy: { createdAt: 'asc' } });
    const refusals = entries.filter(({ kind }) => kind === 'sign_in_refused');
    expect(refusals.map(({ userId }) => userId)).toEqual([
      ...Array(5).fill(id),
      // The sixth carries the cookie of a step that no longer exists: no user is known.
      null,
    ]);
    // The owner's answer of the pull request: one entry of a rate limit
    // reached where the step is abandoned, with the user, and nothing else.
    const reached = entries.filter(({ kind }) => kind !== 'sign_in_refused');
    expect(reached.map(({ kind, userId, documentId }) => [kind, userId, documentId])).toEqual([
      ['rate_limit_reached', id, null],
    ]);
    // Four wrong codes and the right one reach no limit.
    await db().securityLogEntry.deleteMany();
    const next = await passwordStep(auth, email, fresh());
    for (let n = 0; n < 4; n++) await secondStep(auth, next, wrongCode(secret));
    expect((await secondStep(auth, next, nextCode(secret))).status).toBe(200);
    expect(await db().securityLogEntry.count({ where: { kind: 'rate_limit_reached' } })).toBe(0);
  });

  it('takes the number from the settings', async () => {
    expect(settings().secondStepWrongCodes).toBe(5);
    expect(settings().secondStepSeconds).toBe(600);
  });

  it('holds the count where every instance reads it, for no longer than the step', async () => {
    const { email, id, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    await secondStep(auth, step, wrongCode(secret));
    const row = await db().verification.findFirstOrThrow({ where: { value: id } });
    const key = `second-step-codes:${row.id}`;
    expect(await valkey().get(key)).toBe('1');
    const seconds = await valkey().ttl(key);
    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThanOrEqual(600);
  });

  it('counts requests that arrive together one by one: no more than five codes are looked at', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => secondStep(auth, step, wrongCode(secret))),
    );
    const codes = await Promise.all(answers.map(async (answer) => (await error(answer)).code));
    expect(codes.filter((code) => code === 'code_refused')).toHaveLength(4);
    expect(codes.filter((code) => code === 'sign_in_again')).toHaveLength(8);
    expect((await secondStep(auth, step, nextCode(secret))).status).toBe(401);
  });
});

describe('a second step that cannot be completed', () => {
  it('is refused without the cookie of a step, with one that was made up, and with one of another secret', async () => {
    const { email, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    const [name, value] = step.split('=') as [string, string];
    const code = nextCode(secret);
    for (const cookie of [
      '',
      `${name}=made-up`,
      `${name}=${value.split('.')[0]}.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA%3D`,
      // The token alone, without the signature of the library's secret.
      `${name}=${value.split('.')[0]}`,
    ]) {
      const refused = await secondStep(auth, cookie, code);
      expect(refused.status, cookie).toBe(401);
      expect((await error(refused)).code).toBe('sign_in_again');
    }
    // The step itself was not touched by any of them.
    expect((await secondStep(auth, step, code)).status).toBe(200);
  });

  it('is over 10 minutes after the password: "or the sign-in begins again"', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    await db().verification.updateMany({
      where: { value: id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const row = await db().verification.findFirstOrThrow({ where: { value: id } });
    const late = await secondStep(auth, step, nextCode(secret));
    expect(late.status).toBe(401);
    expect((await error(late)).code).toBe('sign_in_again');
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // Refused where the step is read, before a code is looked at: nothing was
    // counted for it, and the refusal knows no user (two-factor-races.test.ts
    // has the step that reaches its time after it was read).
    expect(await valkey().exists(`second-step-codes:${row.id}`)).toBe(0);
    expect((await db().securityLogEntry.findMany()).map(({ userId }) => userId)).toEqual([null]);
  });

  it('is over once it has signed in: its cookie signs no one in a second time', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, step, nextCode(secret))).status).toBe(200);
    const second = await secondStep(auth, step, codeAt(secret, 1));
    expect(second.status).toBe(401);
    expect((await error(second)).code).toBe('sign_in_again');
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
  });

  it('is over where two-factor authentication was turned off meanwhile', async () => {
    const { email, id, cookie, secret } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    expect((await turnOff(cookie, { password: PASSWORD, code: nextCode(secret) })).response.status).toBe(200);
    const late = await secondStep(auth, step, codeAt(secret, 1));
    expect(late.status).toBe(401);
    expect((await error(late)).code).toBe('sign_in_again');
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
  });

  it('is asked of a browser without a session: the password ends the one it held, whoever it belonged to', async () => {
    const { email, id, secret } = await enrolled();
    const other = await person();
    const password = await signIn(auth, email, PASSWORD, { ...fresh(), cookie: other.cookie });
    expect(await password.text()).toBe('{"twoFactorRedirect":true}');
    expect(await stands(other.cookie)).toBe(false);
    // Its cookies are cleared, the signed copy among them, and none of a session is set.
    for (const cookie of password.headers
      .getSetCookie()
      .filter((each) => /session_(token|data)/.test(each))) {
      expect(cookie).toMatch(/session_(token|data)=;/);
      expect(cookie).toContain('Max-Age=0');
    }
    const step = withCookies(other.cookie, password);
    expect(step).not.toContain('session_');
    const done = await secondStep(auth, step, nextCode(secret));
    expect(done.status).toBe(200);
    expect((await validateSessionRow(new Headers({ cookie: withCookies(step, done) }))).session?.userId).toBe(
      id,
    );
  });

  it('is not what a request under a session makes: such a request is the first code of an enrolment, or nothing', async () => {
    const { email, id, secret } = await enrolled();
    const other = await person();
    // A step that is open for one account, and the session of another, in one request.
    const step = await passwordStep(auth, email, fresh());
    const sessions = await db().session.count({ where: { userId: id } });
    const mixed = await post(
      auth,
      '/two-factor/verify-totp',
      { code: nextCode(secret) },
      {
        cookie: `${step}; ${other.cookie}`,
      },
    );
    expect(mixed.response.status).toBe(409);
    expect((await error(mixed.response)).code).toBe('two_factor_not_begun');
    expect(mixed.response.headers.getSetCookie()).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(sessions);
    expect(await isOn(other.id)).toBe(false);
  });

  it('is refused by the library where the request comes from another origin', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    const refused = await secondStep(auth, step, nextCode(secret), 'totp', {
      origin: 'https://evil.example',
    });
    expect(refused.status).toBe(403);
    expect((await error(refused)).code).toBe('forbidden');
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });
});

describe('a recovery code (FR-AU-83)', () => {
  it('is accepted in place of a code, once, and is then spent', async () => {
    const { email, id, recoveryCodes } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const [first, second] = recoveryCodes as [string, string];

    const step = await passwordStep(auth, email, fresh());
    const done = await secondStep(auth, step, first, 'backup-code');
    expect(done.status).toBe(200);
    expect(await done.text()).toBe('{}');
    expect((await validateSessionRow(new Headers({ cookie: withCookies(step, done) }))).session?.userId).toBe(
      id,
    );

    // Spent: the same code signs no one in again.
    const again = await passwordStep(auth, email, fresh());
    const refused = await secondStep(auth, again, first, 'backup-code');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: {
        code: 'code_refused',
        message:
          'The recovery code is not correct, or it has been used. Enter a recovery code that has not been used.',
      },
    });
    // Nine are left, and another of them works.
    const { symmetricDecrypt } = await import('better-auth/crypto');
    const left = JSON.parse(
      await symmetricDecrypt({ key: settings().authSecret, data: (await rowOf(id))!.backupCodes }),
    );
    expect(left).toEqual(recoveryCodes.slice(1));
    expect((await secondStep(auth, again, second, 'backup-code')).status).toBe(200);
  });

  it('is its own kind: not a code of the authenticator, and not accepted where one is asked for', async () => {
    const { email, secret, recoveryCodes } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, step, recoveryCodes[0])).status).toBe(401);
    expect((await secondStep(auth, step, nextCode(secret), 'backup-code')).status).toBe(401);
    expect((await secondStep(auth, step, recoveryCodes[0]!.toUpperCase(), 'backup-code')).status).toBe(401);
    expect((await secondStep(auth, step, ` ${recoveryCodes[0]} `, 'backup-code')).status).toBe(200);
  });

  it('is spent by one of two requests that arrive together', async () => {
    const { email, id, recoveryCodes } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    // One step: an account has one open at a time.
    const step = await passwordStep(auth, email, fresh());
    const answers = await Promise.all(
      [0, 1].map(() => secondStep(auth, step, recoveryCodes[0], 'backup-code')),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401]);
    expect(await db().session.count({ where: { userId: id } })).toBe(1);
    const { symmetricDecrypt } = await import('better-auth/crypto');
    const left = JSON.parse(
      await symmetricDecrypt({ key: settings().authSecret, data: (await rowOf(id))!.backupCodes }),
    );
    expect(left).toEqual(recoveryCodes.slice(1));
  });
});

describe('replacing the recovery codes (FR-AU-83)', () => {
  it('gives ten new ones after the password, makes the old ones void, and sends the notice after the answer', async () => {
    const { email, id, cookie, recoveryCodes } = await enrolled();
    const replaced = await replace(cookie);
    expect(replaced.response.status).toBe(200);
    expect(replaced.response.headers.get('cache-control')).toBe('no-store');
    const body = (await replaced.response.json()) as { recoveryCodes: string[] };
    expect(Object.keys(body)).toEqual(['recoveryCodes']);
    expect(body.recoveryCodes).toHaveLength(10);
    expect(new Set([...body.recoveryCodes, ...recoveryCodes]).size).toBe(20);
    for (const code of body.recoveryCodes) expect(code).toMatch(RECOVERY_CODE);
    expect(replaced.response.headers.getSetCookie()).toEqual([]);

    // FR-AU-87 (g), with its fixed text, after the answer.
    expect(await mail(email, CODES_SUBJECT)).toHaveLength(0);
    expect(replaced.left).toBe(1);
    await replaced.after();
    const sent = await mail(email, CODES_SUBJECT);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(CODES_TEXT);
    // FR-AU-87: an email never carries a recovery code.
    for (const code of body.recoveryCodes) expect(sent[0]!.text).not.toContain(code);

    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, step, recoveryCodes[0], 'backup-code')).status).toBe(401);
    expect((await secondStep(auth, step, body.recoveryCodes[0], 'backup-code')).status).toBe(200);
    // It stays on, with the same secret.
    expect(await isOn(id)).toBe(true);
  });

  it('requires the password, and nothing else: a wrong one is refused and counted', async () => {
    const { email, id, cookie } = await enrolled();
    const before = await rowOf(id);
    const net = fresh();
    const refused = await replace(cookie, { password: WRONG }, net);
    expect(refused.response.status).toBe(403);
    expect(await refused.response.text()).toBe(PASSWORD_REFUSED);
    expect(refused.left).toBe(0);
    for (const body of [{}, { password: PASSWORD, code: '123456' }, { password: 1 }, [PASSWORD]]) {
      const shape = await replace(cookie, body, net);
      expect(shape.response.status).toBe(422);
      expect(await shape.response.json()).toEqual({
        error: {
          code: 'invalid_request',
          message: 'The request must hold the current password, and nothing else.',
        },
      });
    }
    expect(await rowOf(id)).toEqual(before);
    expect(await mail(email, CODES_SUBJECT)).toHaveLength(0);
    // Counted as a failed sign-in (Q10): four more from that network address make five.
    for (let n = 0; n < 4; n++) await replace(cookie, { password: WRONG }, net);
    expect((await replace(cookie, { password: PASSWORD }, net)).response.status).toBe(403);
    expect(await rowOf(id)).toEqual(before);
  });

  it('is refused where two-factor authentication is not on, an enrolment not yet confirmed included', async () => {
    const { id, cookie } = await person();
    for (const begin of [false, true]) {
      if (begin) await enable(cookie);
      const before = await rowOf(id);
      const refused = await replace(cookie);
      expect(refused.response.status).toBe(409);
      expect(await refused.response.json()).toEqual({
        error: {
          code: 'two_factor_not_on',
          message: 'Two-factor authentication is not turned on for this account.',
        },
      });
      expect(refused.left).toBe(0);
      expect(await rowOf(id)).toEqual(before);
    }
  });
});

describe('turning two-factor authentication off (FR-AU-83)', () => {
  it('requires the password and a current code, and sends the notice after the answer', async () => {
    const { email, id, cookie, secret } = await enrolled();
    const off = await turnOff(cookie, { password: PASSWORD, code: nextCode(secret) });
    expect(off.response.status).toBe(200);
    expect(await off.response.text()).toBe('{}');
    expect(off.response.headers.get('cache-control')).toBe('no-store');
    expect(await isOn(id)).toBe(false);
    expect(await rowOf(id)).toBeNull();

    // FR-AU-87 (f): "turned off" in place of "turned on".
    expect(await mail(email, OFF_SUBJECT)).toHaveLength(0);
    expect(off.left).toBe(1);
    await off.after();
    const sent = await mail(email, OFF_SUBJECT);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toBe(OFF_TEXT);

    // The session stays, with a fresh signed copy and no new token.
    expect(off.response.headers.getSetCookie().map((each) => each.split('=')[0])).toEqual([
      '__Secure-better-auth.session_data',
    ]);
    expect(await stands(withCookies(cookie, off.response))).toBe(true);
    // A sign-in is no longer asked for a code.
    expect(await (await signIn(auth, email, PASSWORD, fresh())).text()).toBe('{}');
    // And it can be turned on again, with another secret.
    const again = await enrol(auth, cookie, fresh());
    expect(again.secret).not.toBe(secret);
  });

  it('takes a recovery code in place of the current code', async () => {
    const { id, cookie, recoveryCodes } = await enrolled();
    const off = await turnOff(cookie, { password: PASSWORD, code: recoveryCodes[3] });
    expect(off.response.status).toBe(200);
    expect(await isOn(id)).toBe(false);
  });

  it('is refused with the password alone, with a wrong code, and with a code used before', async () => {
    const { email, id, cookie, secret, recoveryCodes } = await enrolled();
    const before = await rowOf(id);
    // The password alone, as the library's own endpoint would take it.
    for (const body of [{ password: PASSWORD }, { code: '123456' }, { password: PASSWORD, code: 1 }, {}]) {
      const shape = await turnOff(cookie, body);
      expect(shape.response.status).toBe(422);
      expect(await shape.response.json()).toEqual({
        error: {
          code: 'invalid_request',
          message: 'The request must hold the current password and a code, and nothing else.',
        },
      });
    }
    // A recovery code that was spent at a sign-in.
    const step = await passwordStep(auth, email, fresh());
    expect((await secondStep(auth, step, recoveryCodes[0], 'backup-code')).status).toBe(200);
    // A code of the authenticator that was used at a sign-in.
    const used = nextCode(secret);
    expect((await secondStep(auth, await passwordStep(auth, email, fresh()), used)).status).toBe(200);
    const spent = await rowOf(id);

    for (const code of [wrongCode(secret), '', 'aaaaa-bbbbb', recoveryCodes[0], used, codeAt(secret, 3)]) {
      const refused = await turnOff(cookie, { password: PASSWORD, code });
      expect(refused.response.status, String(code)).toBe(403);
      expect(await refused.response.json()).toEqual({
        error: {
          code: 'code_refused',
          message:
            'The code is not correct. Enter the code that the authenticator application shows now, or a recovery code that has not been used.',
        },
      });
      expect(refused.left).toBe(0);
    }
    expect(await isOn(id)).toBe(true);
    expect(await rowOf(id)).toEqual(spent);
    expect(spent!.secret).toBe(before!.secret);
    expect(await mail(email, OFF_SUBJECT)).toHaveLength(0);
    // NFR-SE-19: each 403 has its entry, with the user.
    const entries = await db().securityLogEntry.findMany({ where: { kind: 'forbidden' } });
    expect(entries.map((entry) => entry.userId)).toEqual(Array(6).fill(id));
  });

  it('is refused with a wrong password, whatever the code, and the wrong password is counted', async () => {
    const { email, id, cookie, secret } = await enrolled();
    const net = fresh();
    const refused = await turnOff(cookie, { password: WRONG, code: nextCode(secret) }, net);
    expect(refused.response.status).toBe(403);
    expect(await refused.response.text()).toBe(PASSWORD_REFUSED);
    expect(refused.left).toBe(0);
    expect(await isOn(id)).toBe(true);
    for (let n = 0; n < 4; n++) await turnOff(cookie, { password: WRONG, code: '000000' }, net);
    // Five wrong passwords: the right one is now refused at this prompt, and nothing is turned off.
    const held = await turnOff(cookie, { password: PASSWORD, code: codeAt(secret, 1) }, net);
    expect(await held.response.text()).toBe(PASSWORD_REFUSED);
    expect(await isOn(id)).toBe(true);
    expect(await passwordAccepted(email, net)).toBe(false);
  });

  // The owner's answer G2 of the pull request: "a wrong code at any prompt
  // counts as a failed sign-in, as Q10 does for passwords."
  it('counts each wrong code as a failed sign-in, and is then refused like one, the right code included', async () => {
    const { email, id, cookie, secret, recoveryCodes } = await enrolled();
    const net = fresh();
    for (const code of [wrongCode(secret), 'aaaaa-bbbbb', '', wrongCode(secret)]) {
      const refused = await turnOff(cookie, { password: PASSWORD, code }, net);
      expect(refused.response.status).toBe(403);
      expect((await error(refused.response)).code).toBe('code_refused');
    }
    // Four are not five: a sign-in from there is still answered.
    expect(await passwordAccepted(email, net)).toBe(true);
    expect(
      (await turnOff(cookie, { password: PASSWORD, code: wrongCode(secret) }, net)).response.status,
    ).toBe(403);
    // Five: the prompt now refuses the right password with a right code, in
    // the words of a wrong password and with no 429, and so does a sign-in.
    for (const code of [nextCode(secret), recoveryCodes[0]]) {
      const held = await turnOff(cookie, { password: PASSWORD, code }, net);
      expect(held.response.status).toBe(403);
      expect(await held.response.text()).toBe(PASSWORD_REFUSED);
      expect(held.response.headers.get('retry-after')).toBeNull();
    }
    expect(await passwordAccepted(email, net)).toBe(false);
    expect(await isOn(id)).toBe(true);
    // NFR-SE-19: each 403 has its entry, with the user, as a wrong password's has.
    const entries = await db().securityLogEntry.findMany({ where: { kind: 'forbidden' } });
    expect(entries.map((entry) => entry.userId)).toEqual(Array(7).fill(id));
    // From another network address the prompt still answers, and a right code is not counted.
    expect((await turnOff(cookie, { password: PASSWORD, code: recoveryCodes[1] })).response.status).toBe(200);
  });

  it('counts a wrong code toward the 20 in an hour for the address, from wherever it came', async () => {
    const { email, id, cookie, secret } = await enrolled();
    for (let n = 0; n < 20; n++) {
      expect((await turnOff(cookie, { password: PASSWORD, code: wrongCode(secret) })).response.status).toBe(
        403,
      );
    }
    const held = await turnOff(cookie, { password: PASSWORD, code: nextCode(secret) });
    expect(await held.response.text()).toBe(PASSWORD_REFUSED);
    expect(await isOn(id)).toBe(true);
    expect(await passwordAccepted(email, fresh())).toBe(false);
  });

  it('is refused where it is not on', async () => {
    const { cookie } = await person();
    const refused = await turnOff(cookie, { password: PASSWORD, code: '123456' });
    expect(refused.response.status).toBe(409);
    expect((await error(refused.response)).code).toBe('two_factor_not_on');
  });
});

describe('the session of each request (NFR-SE-17 (c), FR-AU-07)', () => {
  const requests = [
    ['/two-factor/enable', { password: PASSWORD }],
    ['/two-factor/disable', { password: PASSWORD, code: '123456' }],
    ['/two-factor/generate-backup-codes', { password: PASSWORD }],
  ] as const;

  it.each(requests)('%s requires one, before anything is said of the body', async (path, body) => {
    for (const headers of [{}, { cookie: '__Secure-better-auth.session_token=made-up.c2ln' }] as Record<
      string,
      string
    >[]) {
      for (const sent of [body, { nothing: 1 }]) {
        const refused = await post(auth, path, sent, headers);
        expect(refused.response.status).toBe(401);
        expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      }
    }
  });

  it.each(requests)(
    '%s reads the row: a session that has ended changes nothing, though its signed copy still reads',
    async (path, body) => {
      const { id, cookie, secret } = await enrolled();
      const before = await rowOf(id);
      await db().session.deleteMany({ where: { userId: id } });
      expect(cookie).toContain('session_data=');
      expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);

      const sent = 'code' in body ? { ...body, code: nextCode(secret) } : body;
      const refused = await post(auth, path, sent, { cookie, ...fresh() });
      expect(refused.response.status).toBe(401);
      expect(await refused.response.text()).toBe(UNAUTHENTICATED);
      expect(refused.left).toBe(0);
      expect(await rowOf(id)).toEqual(before);
      expect(await isOn(id)).toBe(true);
    },
  );

  it('reads the row for the first code of an enrolment too: under a session that has ended it is no enrolment', async () => {
    const { id, cookie } = await person();
    const secret = unbase32(((await (await enable(cookie)).response.json()) as { secret: string }).secret);
    await db().session.deleteMany({ where: { userId: id } });
    expect((await validateSession('GET', new Headers({ cookie }))).session?.userId).toBe(id);
    // Without a session the request is a second step, and there is none.
    const refused = await confirm(cookie, nextCode(secret));
    expect(refused.response.status).toBe(401);
    expect((await error(refused.response)).code).toBe('sign_in_again');
    expect(await isOn(id)).toBe(false);
  });

  it('refuses a request from another origin', async () => {
    const { id, cookie, secret } = await enrolled();
    const refused = await post(
      auth,
      '/two-factor/disable',
      { password: PASSWORD, code: nextCode(secret) },
      { cookie, origin: 'https://evil.example' },
    );
    expect(refused.response.status).toBe(403);
    expect((await error(refused.response)).code).toBe('forbidden');
    expect(await isOn(id)).toBe(true);
  });
});

describe('what a request may say (API design: "any other field is refused")', () => {
  it.each([
    // The plugin's own fields: the name shown in the authenticator, and a code by email.
    ['issuer', { password: PASSWORD, issuer: 'Another name' }],
    ['method: otp', { password: PASSWORD, method: 'otp' }],
    ['a field of no meaning', { password: PASSWORD, anything: null }],
    ['no password', {}],
    ['a password that is not text', { password: 12345678 }],
    ['a list', [PASSWORD]],
  ])('refuses an enrolment with %s, and begins nothing', async (_name, body) => {
    const { id, cookie } = await person();
    const refused = await enable(cookie, body);
    expect(refused.response.status).toBe(422);
    expect(await refused.response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request must hold the current password, and nothing else.',
      },
    });
    expect(await rowOf(id)).toBeNull();
  });
});

describe('a code by email or by telephone (FR-AU-83; NFR-SE-17 (d))', () => {
  it('is not offered: the endpoints answer 404, signed in, at the second step, and signed out', async () => {
    const { email, cookie } = await enrolled();
    const step = await passwordStep(auth, email, fresh());
    for (const held of [cookie, step, '']) {
      for (const path of ['/two-factor/send-otp', '/two-factor/verify-otp']) {
        const response = await post(auth, path, { code: '123456' }, { cookie: held });
        expect(response.response.status).toBe(404);
      }
    }
    expect((await sunk(sink)).filter((message) => /code/i.test(message.subject ?? ''))).toEqual(
      (await sunk(sink)).filter((message) => message.subject === CODES_SUBJECT),
    );
  });
});

// The request holds a session and no password: a session in another's hands
// must not be able to guess at the first code until one is right.
describe('the first code of an enrolment, under its two bounds (FR-AU-83; NFR-SE-07, the row of wrong codes)', () => {
  const NOT_BEGUN = {
    error: {
      code: 'two_factor_not_begun',
      message: 'No secret is waiting for its first code. Enter the password to begin again.',
    },
  };
  const begin = async (cookie: string) =>
    unbase32(((await (await enable(cookie)).response.json()) as { secret: string }).secret);

  it('ends the enrolment at the fifth wrong code: the secret is gone, and the password is asked for again', async () => {
    const { id, email, cookie } = await person();
    const secret = await begin(cookie);
    for (let n = 0; n < 4; n++) expect((await confirm(cookie, wrongCode(secret))).response.status).toBe(422);
    expect(await rowOf(id)).not.toBeNull();
    const fifth = await confirm(cookie, wrongCode(secret));
    expect(fifth.response.status).toBe(409);
    expect(await fifth.response.json()).toEqual(NOT_BEGUN);
    expect(await rowOf(id)).toBeNull();

    // The right code of that secret now confirms nothing.
    const late = await confirm(cookie, nextCode(secret));
    expect(late.response.status).toBe(409);
    expect(await late.response.json()).toEqual(NOT_BEGUN);
    expect(late.left).toBe(0);
    expect(await isOn(id)).toBe(false);
    // It is no sign-in: nothing is logged as one refused, and none is counted as failed.
    expect(await db().securityLogEntry.count()).toBe(0);
    expect(await (await signIn(auth, email, PASSWORD, fresh())).text()).toBe('{}');

    // With the password it begins again, and five more codes may be tried.
    const again = await begin(cookie);
    expect((await confirm(cookie, wrongCode(again))).response.status).toBe(422);
    expect((await confirm(cookie, nextCode(again))).response.status).toBe(200);
    expect(await isOn(id)).toBe(true);
  });

  it('accepts the right code as the fifth, and counts requests that arrive together one by one', async () => {
    const one = await person();
    const secret = await begin(one.cookie);
    for (let n = 0; n < 4; n++) await confirm(one.cookie, wrongCode(secret));
    expect((await confirm(one.cookie, nextCode(secret))).response.status).toBe(200);

    const two = await person();
    const other = await begin(two.cookie);
    const answers = await Promise.all(
      Array.from({ length: 12 }, () => confirm(two.cookie, wrongCode(other))),
    );
    // No more than four are answered as a wrong code: the rest met the end.
    expect(answers.filter((answer) => answer.response.status === 422).length).toBeLessThanOrEqual(4);
    expect(await rowOf(two.id)).toBeNull();
    expect((await confirm(two.cookie, nextCode(other))).response.status).toBe(409);
  });

  it('holds the count where every instance reads it, under the row and for no longer than the secret waits', async () => {
    const { id, cookie } = await person();
    const secret = await begin(cookie);
    await confirm(cookie, wrongCode(secret));
    const key = `enrolment-codes:${(await rowOf(id))!.id}`;
    expect(await valkey().get(key)).toBe('1');
    const seconds = await valkey().ttl(key);
    expect(seconds).toBeGreaterThan(590);
    expect(seconds).toBeLessThanOrEqual(600);
  });

  it('refuses the right code where the count cannot be made, and turns nothing on (NFR-SE-06 A10)', async () => {
    const { id, cookie } = await person();
    const secret = await begin(cookie);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(valkey(), 'incr').mockRejectedValue(new Error('ECONNREFUSED redis://secret@host'));
    const refused = await confirm(cookie, nextCode(secret));
    expect(refused.response.status).toBe(500);
    expect(await refused.response.text()).not.toContain('recoveryCodes');
    expect(await isOn(id)).toBe(false);
    expect(await rowOf(id)).toMatchObject({ verified: false });
  });

  it('is asked for within 10 minutes of the password: a secret that waited longer is deleted', async () => {
    const { id, cookie } = await person();
    const secret = await begin(cookie);
    const waited = (await rowOf(id))!.createdAt.getTime();
    expect(Date.now() - waited).toBeLessThan(5_000);
    // One second short of the time is still within it.
    await db().twoFactor.update({
      where: { userId: id },
      data: { createdAt: new Date(Date.now() - (settings().secondStepSeconds - 1) * 1000) },
    });
    expect((await confirm(cookie, wrongCode(secret))).response.status).toBe(422);
    await db().twoFactor.update({
      where: { userId: id },
      data: { createdAt: new Date(Date.now() - settings().secondStepSeconds * 1000) },
    });
    const late = await confirm(cookie, nextCode(secret));
    expect(late.response.status).toBe(409);
    expect(await late.response.json()).toEqual(NOT_BEGUN);
    expect(await rowOf(id)).toBeNull();
    expect(await isOn(id)).toBe(false);
  });

  it('counts the 10 minutes from the password that began it again, not from the first', async () => {
    const { id, cookie } = await person();
    await begin(cookie);
    await db().twoFactor.update({
      where: { userId: id },
      data: { createdAt: new Date(Date.now() - settings().secondStepSeconds * 1000) },
    });
    // Begun again over the same row: its time is that of this password.
    const secret = await begin(cookie);
    expect(Date.now() - (await rowOf(id))!.createdAt.getTime()).toBeLessThan(5_000);
    expect((await confirm(cookie, nextCode(secret))).response.status).toBe(200);
  });

  it('never deletes a second factor that is on, however long ago it was begun', async () => {
    const { id, cookie, secret } = await enrolled();
    await db().twoFactor.update({ where: { userId: id }, data: { createdAt: new Date(0) } });
    for (let n = 0; n < 6; n++) expect((await confirm(cookie, wrongCode(secret))).response.status).toBe(409);
    expect(await rowOf(id)).toMatchObject({ verified: true });
    expect(await isOn(id)).toBe(true);
  });

  it('is false in a row that does not say: a row written without it is no second factor', async () => {
    const { id } = await person();
    await db().twoFactor.create({ data: { id: `row-of-${id}`, userId: id, secret: 'x', backupCodes: 'x' } });
    expect(await rowOf(id)).toMatchObject({ verified: false });
  });

  it('still shows the recovery codes where the signed copy could not be written again after the commit', async () => {
    const { id, cookie } = await person();
    const secret = await begin(cookie);
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A fault of every read of a session once the change has committed.
    const { internalAdapter } = await auth().$context;
    let committed = false;
    const transaction = db().$transaction.bind(db()) as (...args: unknown[]) => Promise<unknown>;
    vi.spyOn(db() as unknown as { $transaction: typeof transaction }, '$transaction').mockImplementation(
      async (...args) => {
        const result = await transaction(...args);
        committed = true;
        return result;
      },
    );
    const find = internalAdapter.findSession.bind(internalAdapter);
    vi.spyOn(internalAdapter, 'findSession').mockImplementation(async (...args) => {
      if (committed) throw new Error('quoting person@example.com and a row');
      return find(...args);
    });

    const confirmed = await confirm(cookie, nextCode(secret));
    expect(confirmed.response.status).toBe(200);
    const body = (await confirmed.response.json()) as { recoveryCodes: string[] };
    expect(body.recoveryCodes).toHaveLength(10);
    expect(await isOn(id)).toBe(true);
    // The notice is still left for after the answer.
    expect(confirmed.left).toBe(1);
    // NFR-SE-19: the class of the fault, and nothing of its message.
    expect(printed.mock.calls).toEqual([['two-factor: changed, signed copy not written again (Error)']]);
  });
});

describe('one step for an account, and no code past the failed sign-ins of an hour (NFR-SE-07: "no more than 100 codes")', () => {
  it('ends the steps opened earlier when another is opened', async () => {
    const { email, id, secret } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const first = await passwordStep(auth, email, fresh());
    const second = await passwordStep(auth, email, fresh());
    const third = await passwordStep(auth, email, fresh());
    expect(await db().verification.count({ where: { value: id } })).toBe(1);
    for (const earlier of [first, second]) {
      // A right code, which is not looked at: it is not used up by this.
      const refused = await secondStep(auth, earlier, codeAt(secret, 1));
      expect(refused.status).toBe(401);
      expect((await error(refused)).code).toBe('sign_in_again');
    }
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    expect((await secondStep(auth, third, nextCode(secret))).status).toBe(200);
  });

  it('leaves the step of another account as it is', async () => {
    const one = await enrolled();
    const two = await enrolled();
    const step = await passwordStep(auth, one.email, fresh());
    await passwordStep(auth, two.email, fresh());
    expect((await secondStep(auth, step, nextCode(one.secret))).status).toBe(200);
  });

  it('refuses a right code at a step that is still open once the 20 failed sign-ins of the hour are reached', async () => {
    const { email, id, secret, recoveryCodes } = await enrolled();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    // Twenty wrong passwords, each from a network address of its own: the
    // step stays open, since a wrong password opens none.
    for (let n = 0; n < 20; n++) await wrongPassword(email, fresh());
    expect(await passwordAccepted(email, fresh())).toBe(false);
    const row = await db().verification.findFirstOrThrow({ where: { value: id } });

    const refused = await secondStep(auth, step, nextCode(secret), 'totp', fresh());
    expect(refused.status).toBe(401);
    expect(refused.headers.get('retry-after')).toBeNull();
    expect((await error(refused)).code).toBe('sign_in_again');
    // The step is over, as an abandoned one is, and no code was looked at.
    expect(await db().verification.count({ where: { value: id } })).toBe(0);
    expect(refused.headers.getSetCookie().join()).toMatch(/two_factor=;.*Max-Age=0/i);
    expect(await valkey().exists(`second-step-codes:${row.id}`)).toBe(0);
    expect((await secondStep(auth, step, recoveryCodes[0], 'backup-code', fresh())).status).toBe(401);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });
});

describe('the session the browser held (the owner’s decision S5: "a sign-in ends the session the browser held")', () => {
  it('is ended by a second step completed under it, whoever it belonged to', async () => {
    const { email, id, recoveryCodes } = await enrolled();
    const other = await person();
    const step = await passwordStep(auth, email, fresh());
    // A recovery code is taken under a session too: the session of another
    // account, which this browser was given after the password.
    const browser = `${step}; ${other.cookie}`;
    expect(await stands(other.cookie)).toBe(true);
    const done = await secondStep(auth, browser, recoveryCodes[0], 'backup-code', fresh());
    expect(done.status).toBe(200);
    expect(await stands(other.cookie)).toBe(false);
    expect(await db().session.count({ where: { userId: other.id } })).toBe(0);
    expect(
      (await validateSessionRow(new Headers({ cookie: withCookies(browser, done) }))).session?.userId,
    ).toBe(id);
  });

  it('stands where the second step is refused', async () => {
    const { email, recoveryCodes } = await enrolled();
    const other = await person();
    const step = await passwordStep(auth, email, fresh());
    const refused = await secondStep(auth, `${step}; ${other.cookie}`, 'aaaaa-bbbbb', 'backup-code');
    expect(refused.status).toBe(401);
    expect(await stands(other.cookie)).toBe(true);
    // And where the step was over before the code was right.
    await db().verification.deleteMany({ where: { identifier: { startsWith: 'second-step:' } } });
    expect((await secondStep(auth, `${step}; ${other.cookie}`, recoveryCodes[0], 'backup-code')).status).toBe(
      401,
    );
    expect(await stands(other.cookie)).toBe(true);
  });

  it('leaves no cookie of a second step behind a sign-in that needs none', async () => {
    const { email } = await person();
    const stale = '__Secure-better-auth.two_factor=left-by-an-earlier-sign-in';
    const signed = await signIn(auth, email, PASSWORD, { ...fresh(), cookie: stale });
    expect(await signed.text()).toBe('{}');
    expect(signed.headers.getSetCookie().join('\n')).toMatch(/two_factor=;.*Max-Age=0/i);
    expect(withCookies(stale, signed)).not.toContain('two_factor');
    // A browser that holds none is sent nothing about one.
    const plain = await signIn(auth, email, PASSWORD, fresh());
    expect(plain.headers.getSetCookie().join('\n')).not.toContain('two_factor');
  });
});

describe('a fault while a second step is completed (FR-AU-83: "accepted in its place and is then spent")', () => {
  it('spends no recovery code, ends no session and leaves the step open: the same code then signs in', async () => {
    const { email, id, recoveryCodes } = await enrolled();
    const other = await person();
    await db().session.deleteMany({ where: { userId: id } });
    const step = await passwordStep(auth, email, fresh());
    const stored = (await rowOf(id))!.backupCodes;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(db(), '$transaction').mockRejectedValueOnce(new Error('the connection was lost'));

    const browser = `${step}; ${other.cookie}`;
    const failed = await secondStep(auth, browser, recoveryCodes[0], 'backup-code', fresh());
    expect(failed.status).toBe(500);
    expect(failed.headers.getSetCookie().filter((cookie) => /session_token=[^;]/.test(cookie))).toEqual([]);
    expect((await rowOf(id))!.backupCodes).toBe(stored);
    expect(await stands(other.cookie)).toBe(true);
    expect(await db().verification.count({ where: { value: id } })).toBe(1);

    expect((await secondStep(auth, browser, recoveryCodes[0], 'backup-code', fresh())).status).toBe(200);
    expect((await rowOf(id))!.backupCodes).not.toBe(stored);
  });
});
