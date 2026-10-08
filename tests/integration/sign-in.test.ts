// Sign-in (FR-AU-81, FR-AU-84; the failed-sign-in rows of NFR-SE-07, without
// the lock), through the identity library's handler, against a provisioned
// database and Valkey. The limits that need a period to pass are in
// sign-in-period.test.ts.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, DAY, load, ORIGIN, PASSWORD, prepare } from './identity.ts';

const database = prepare('signin', {
  // One trusted proxy, so that an attempt can come from a network address of its own.
  TRUSTED_PROXY_COUNT: '1',
  // Not the initial values, to show that each comes from the settings.
  SESSION_IDLE_SECONDS: String(6 * DAY),
  SESSION_RENEW_SECONDS: String(DAY / 2),
  SESSION_MAX_SECONDS: String(20 * DAY),
});
const { auth, db, valkey, validateSession, validateSessionRow } = await load();

// FR-AU-81, written out here and not imported: every character is the requirement's.
const REFUSED =
  '{"error":{"code":"sign_in_refused","message":"The email address or the password is not correct."}}';
const WRONG = 'a wrong password, long enough';

function post(body: unknown, headers: Record<string, string> = {}) {
  return auth().handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
/** A network address, as the one trusted proxy reports it. */
const from = (n: number) => ({ 'x-forwarded-for': `198.51.100.${n}` });
const signIn = (email: string, password = PASSWORD, headers: Record<string, string> = from(1)) =>
  post({ email, password }, headers);

let people = 0;
/** A new address, so that each test has counts of its own. */
const address = () => `person${++people}@example.com`;
async function person(verified = true) {
  const email = address();
  return { email, id: await createAccount(auth, email, verified) };
}

async function expectRefused(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.text()).toBe(REFUSED);
  expect(response.headers.get('content-type')).toContain('application/json');
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.getSetCookie()).toEqual([]);
  expect(response.headers.get('retry-after')).toBeNull();
}
async function expectSignedIn(response: Response, userId: string) {
  expect(response.status).toBe(200);
  expect(await response.text()).toBe('{}');
  const { session } = await validateSessionRow(new Headers({ cookie: cookiesOf(response) }));
  expect(session?.userId).toBe(userId);
  return session!.sessionId;
}
const refusals = () => db().securityLogEntry.findMany({ where: { kind: 'sign_in_refused' } });

afterEach(async () => {
  vi.restoreAllMocks();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('a successful sign-in (FR-AU-81, FR-AU-84)', () => {
  it('answers {} and holds neither the token nor anything of the user in the body', async () => {
    const { email, id } = await person();
    const response = await signIn(email);
    const cookies = response.headers.getSetCookie();
    const body = await response.clone().text();
    await expectSignedIn(response, id);

    const token = decodeURIComponent(/session_token=([^;]+)/.exec(cookies.join('\n'))![1]!).split('.')[0]!;
    const row = await db().session.findFirstOrThrow({ where: { userId: id } });
    expect(row.token).toBe(token);
    for (const secret of [token, id, email, 'A Person', row.id]) expect(body).not.toContain(secret);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('location')).toBeNull();
  });

  it('sets the two cookies of a session, which scripts cannot read, and no other', async () => {
    const cookies = (await signIn((await person()).email)).headers.getSetCookie();
    expect(cookies.map((cookie) => cookie.split('=')[0]).sort()).toEqual([
      '__Secure-better-auth.session_data',
      '__Secure-better-auth.session_token',
    ]);
    for (const cookie of cookies) expect(cookie.toLowerCase()).toContain('httponly');
  });

  it('begins a session that expires after the idle period of the settings, and a cookie that lasts as long', async () => {
    const { email, id } = await person();
    const response = await signIn(email);
    const row = await db().session.findFirstOrThrow({ where: { userId: id } });
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY * 1000 - 60_000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 6 * DAY * 1000);
    expect(row.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.ipAddress).toBe('198.51.100.1');
    const cookie = response.headers.getSetCookie().find((each) => each.includes('session_token='));
    expect(cookie).toContain(`Max-Age=${6 * DAY}`);
  });

  it('compares the address in lower case', async () => {
    const { email, id } = await person();
    await expectSignedIn(await signIn(email.toUpperCase()), id);
    await expectSignedIn(await signIn(email.replace('person', 'PerSon')), id);
  });

  it('ends the session the browser already held, of the same account or of another', async () => {
    const first = await person();
    const second = await person();
    const held = await signIn(first.email);
    const heldId = await expectSignedIn(held.clone(), first.id);

    const again = await signIn(second.email, PASSWORD, { ...from(1), cookie: cookiesOf(held) });
    await expectSignedIn(again, second.id);
    expect(await db().session.count({ where: { id: heldId } })).toBe(0);
    expect(await db().session.count({ where: { userId: first.id } })).toBe(0);

    // Of the same account: the row it held is gone, and the one row is the new one.
    const once = await signIn(second.email, PASSWORD, { ...from(1), cookie: cookiesOf(again) });
    const onceId = await expectSignedIn(once, second.id);
    expect((await db().session.findMany({ where: { userId: second.id } })).map((row) => row.id)).toEqual([
      onceId,
    ]);
  });

  it('leaves the session the browser held where the sign-in fails', async () => {
    const { email, id } = await person();
    const held = await signIn(email);
    const heldId = await expectSignedIn(held.clone(), id);
    await expectRefused(await signIn(email, WRONG, { ...from(1), cookie: cookiesOf(held) }));
    expect(await db().session.count({ where: { id: heldId } })).toBe(1);
  });
});

describe('what the request may say (FR-AU-84; API design: "any other field is refused")', () => {
  it.each([
    ['rememberMe: false', { rememberMe: false }],
    ['rememberMe: true', { rememberMe: true }],
    ['callbackURL', { callbackURL: '/documents' }],
    ['a field of no meaning', { anything: null }],
  ])('refuses a body with %s, and begins no session', async (_name, extra) => {
    const { email, id } = await person();
    const response = await post({ email, password: PASSWORD, ...extra }, from(1));
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: 'invalid_request',
        message: 'The request must hold an email address and a password, and nothing else.',
      },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(response.headers.get('location')).toBeNull();
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it.each([
    ['no password', (email: string) => ({ email })],
    ['no address', () => ({ password: PASSWORD })],
    ['a password that is not text', (email: string) => ({ email, password: 15 })],
    ['an address that is not text', () => ({ email: ['a@example.com'], password: PASSWORD })],
    ['a list', (email: string) => [email, PASSWORD]],
    ['text', () => '"text"'],
    ['nothing', () => 'null'],
  ])('refuses %s with a 422, which is no failed sign-in', async (_name, body) => {
    const { email } = await person();
    for (let n = 0; n < 6; n++) expect((await post(body(email), from(1))).status).toBe(422);
    // Not counted, and not a refused sign-in in the log.
    expect((await signIn(email)).status).toBe(200);
    expect(await refusals()).toEqual([]);
  });

  it('is refused by the library before the endpoint where it names another origin', async () => {
    const { email, id } = await person();
    // The library's own refusals: a place to go to on another origin, and a
    // request with cookies from another origin. Each in the one shape of an
    // error, in the words of the proxy's 403 (the owner's answer to Q8).
    await db().securityLogEntry.deleteMany();
    const away = await post({ email, password: PASSWORD, callbackURL: 'https://evil.example/' }, from(1));
    const foreign = await signIn(email, PASSWORD, { origin: 'https://evil.example', cookie: 'a=b' });
    for (const response of [away, foreign]) {
      expect(response.status).toBe(403);
      expect(await response.text()).toBe(
        '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}',
      );
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(response.headers.get('location')).toBeNull();
    }
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // NFR-SE-19: a 403 has its entry, with no user: none is known there. The
    // library does not wait for the entry, so the test does.
    await vi.waitFor(async () =>
      expect((await db().securityLogEntry.findMany()).map(({ kind, userId }) => [kind, userId])).toEqual([
        ['forbidden', null],
        ['forbidden', null],
      ]),
    );
  });

  it('serves no session to a body that is not JSON', async () => {
    const { email, id } = await person();
    const form = await post(`email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}`, {
      ...from(1),
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(form.status).toBe(415);
    const cut = await post('{"email":', from(1));
    expect(cut.status).toBe(400);
    // The library's router refuses both, and each is answered in the one shape of an error.
    for (const response of [form, cut]) {
      expect(await response.text()).toBe(
        '{"error":{"code":"invalid_request","message":"The request could not be read, and nothing was changed. A request to this address holds JSON, sent with the content type application/json."}}',
      );
    }
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // Neither is a 403 or a refused sign-in: no entry (NFR-SE-19).
    expect(await refusals()).toEqual([]);
  });
});

describe('a refused sign-in (FR-AU-81)', () => {
  it('is answered with the one statement, byte for byte, whatever the cause', async () => {
    const known = await person();
    const unverified = await person(false);
    const withoutPassword = await person();
    await db().account.deleteMany({ where: { userId: withoutPassword.id } });
    const tombstone = await person();
    await db().account.deleteMany({ where: { userId: tombstone.id } });
    await db().user.update({ where: { id: tombstone.id }, data: { email: null, name: null } });

    await expectRefused(await signIn(known.email, WRONG));
    await expectRefused(await signIn(address()));
    await expectRefused(await signIn(unverified.email));
    await expectRefused(await signIn(unverified.email, WRONG));
    await expectRefused(await signIn(withoutPassword.email));
    await expectRefused(await signIn(tombstone.email));
    await expectRefused(await signIn('not an address'));
    await expectRefused(await signIn(''));
    await expectRefused(await signIn(known.email, ''));
    // FR-AU-82: longer than a password can be, so it is not the password.
    await expectRefused(await signIn(known.email, PASSWORD.padEnd(129, 'x')));
    await expectRefused(await signIn(known.email, 'x'.repeat(100_000)));

    for (const { id } of [unverified, withoutPassword]) {
      expect(await db().session.count({ where: { userId: id } })).toBe(0);
    }
  });

  it('writes one entry to the security log, with the user where the address has an account and none otherwise', async () => {
    const known = await person();
    const unverified = await person(false);
    await signIn(known.email, WRONG);
    await signIn(unverified.email);
    await signIn(address());
    await signIn(known.email.toUpperCase(), WRONG);

    const entries = await refusals();
    expect(entries.map((entry) => entry.userId).sort()).toEqual(
      [known.id, known.id, unverified.id, null].sort(),
    );
    // NFR-SE-19: the time, the kind, the user and the document, and nothing else.
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['createdAt', 'documentId', 'id', 'kind', 'userId']);
      expect(entry.documentId).toBeNull();
    }
  });

  it('writes nothing for a sign-in that succeeds', async () => {
    await signIn((await person()).email);
    expect(await db().securityLogEntry.count()).toBe(0);
  });

  it('writes nothing to the console, and no address or password anywhere (NFR-SE-19)', async () => {
    const { email } = await person();
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');

    await signIn(email, WRONG);
    await signIn(address(), WRONG);
    for (let n = 0; n < 6; n++) await signIn(email, WRONG, from(9));
    await signIn(email);
    await post({ email, password: PASSWORD, rememberMe: false }, from(1));

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    const stored = database.sql('SELECT * FROM "SecurityLogEntry"');
    expect(stored).not.toContain('example.com');
    expect(stored).not.toContain(WRONG);
  });
});

describe('the time a refusal takes (FR-AU-81)', () => {
  it('runs the password hashing function exactly once on every path, as a sign-in that succeeds does', async () => {
    const context = await auth().$context;
    const verify = vi.spyOn(context.password, 'verify');
    const hash = vi.spyOn(context.password, 'hash');
    /** How often scrypt ran, by verification and by the hash made in its place. */
    const work = async (attempt: () => Promise<Response>, status: number) => {
      verify.mockClear();
      hash.mockClear();
      expect((await attempt()).status).toBe(status);
      return { verified: verify.mock.calls.length, hashed: hash.mock.calls.length };
    };

    const known = await person();
    const unverified = await person(false);
    const withoutPassword = await person();
    await db().account.deleteMany({ where: { userId: withoutPassword.id } });
    const limited = await person();
    for (let n = 0; n < 5; n++) await signIn(limited.email, WRONG, from(7));
    const unknownLimited = address();
    for (let n = 0; n < 5; n++) await signIn(unknownLimited, WRONG, from(7));

    expect(await work(() => signIn(known.email), 200)).toEqual({ verified: 1, hashed: 0 });
    expect(await work(() => signIn(known.email, WRONG), 401)).toEqual({ verified: 1, hashed: 0 });
    const instead = { verified: 0, hashed: 1 };
    expect(await work(() => signIn(address()), 401)).toEqual(instead);
    expect(await work(() => signIn('not an address'), 401)).toEqual(instead);
    expect(await work(() => signIn(unverified.email), 401)).toEqual(instead);
    expect(await work(() => signIn(withoutPassword.email), 401)).toEqual(instead);
    expect(await work(() => signIn(known.email, 'x'.repeat(129)), 401)).toEqual(instead);
    // A limit already reached: refused without verifying, the right password included.
    expect(await work(() => signIn(limited.email, PASSWORD, from(7)), 401)).toEqual(instead);
    expect(await work(() => signIn(unknownLimited, PASSWORD, from(7)), 401)).toEqual(instead);
    // The hash made in place of a verification is of nothing the request sent.
    for (const [hashed] of hash.mock.calls) expect(hashed).toBe('');
  });

  it('reads the database and asks Valkey as often on every path', async () => {
    // The statements that reach the database, by table, and the scripts that reach Valkey.
    const users = vi.spyOn(db().user, 'findFirst');
    const accounts = vi.spyOn(db().account, 'findMany');
    const entries = vi.spyOn(db().securityLogEntry, 'create');
    const asked = vi.spyOn(valkey(), 'eval');
    const known = await person();
    const unverified = await person(false);
    const limited = await person();
    for (let n = 0; n < 5; n++) await signIn(limited.email, WRONG, from(7));
    const unknownLimited = address();
    for (let n = 0; n < 5; n++) await signIn(unknownLimited, WRONG, from(7));

    const work = async (attempt: () => Promise<Response>) => {
      for (const spy of [users, accounts, entries, asked]) spy.mockClear();
      expect((await attempt()).status).toBe(401);
      return [users, accounts, entries, asked].map((spy) => spy.mock.calls.length);
    };
    // The user, its credentials, the entry in the log; the two checks, the two
    // counts of a failure, and the release of the turn.
    const failed = [1, 1, 1, 5];
    expect(await work(() => signIn(known.email, WRONG))).toEqual(failed);
    expect(await work(() => signIn(address(), WRONG))).toEqual(failed);
    expect(await work(() => signIn(unverified.email))).toEqual(failed);
    // Refused by a limit: nothing is counted, for an address with an account or
    // without. The first such refusal of a period also writes the entry of a
    // limit reached (NFR-SE-19), so two entries, and each later one writes the
    // one; the same for both addresses, so the numbers tell them apart no more
    // than before.
    const firstRefused = [1, 1, 2, 3];
    const refused = [1, 1, 1, 3];
    expect(await work(() => signIn(limited.email, PASSWORD, from(7)))).toEqual(firstRefused);
    expect(await work(() => signIn(unknownLimited, PASSWORD, from(7)))).toEqual(firstRefused);
    expect(await work(() => signIn(limited.email, PASSWORD, from(7)))).toEqual(refused);
    expect(await work(() => signIn(unknownLimited, PASSWORD, from(7)))).toEqual(refused);
  });
});

describe('the limits on failed sign-ins (NFR-SE-07; the owner’s answers to Q1 and Q10)', () => {
  it('refuses after 5 failures for one address from one network address, the right password included', async () => {
    const { email, id } = await person();
    for (let n = 0; n < 4; n++) await expectRefused(await signIn(email, WRONG, from(20)));
    // Four failures are not five.
    await expectSignedIn(await signIn(email, PASSWORD, from(20)), id);
    await expectRefused(await signIn(email, WRONG, from(20)));

    // The sixth attempt: the same statement, the same status, and no 429.
    await expectRefused(await signIn(email, PASSWORD, from(20)));
    await expectRefused(await signIn(email.toUpperCase(), PASSWORD, from(20)));
    // Another network address is not held back, and its success clears nothing for the first.
    await expectSignedIn(await signIn(email, PASSWORD, from(21)), id);
    await expectRefused(await signIn(email, PASSWORD, from(20)));
    // Another address entered from the same network address is not held back.
    const other = await person();
    await expectSignedIn(await signIn(other.email, PASSWORD, from(20)), other.id);
  });

  it('counts the failures of one address in whatever case it was entered', async () => {
    const { email } = await person();
    for (const entered of [email, email.toUpperCase(), email.replace('person', 'Person')]) {
      await signIn(entered, WRONG, from(22));
    }
    await signIn(email, WRONG, from(22));
    await signIn(email.toUpperCase(), WRONG, from(22));
    await expectRefused(await signIn(email, PASSWORD, from(22)));
  });

  it('counts an IPv6 network address by its first 64 bits', async () => {
    const { email, id } = await person();
    for (let n = 0; n < 5; n++) {
      await signIn(email, WRONG, { 'x-forwarded-for': `2001:db8:1:2::${n + 1}` });
    }
    await expectRefused(await signIn(email, PASSWORD, { 'x-forwarded-for': '2001:db8:1:2:ffff::9' }));
    await expectSignedIn(await signIn(email, PASSWORD, { 'x-forwarded-for': '2001:db8:1:3::1' }), id);
  });

  it('refuses everywhere after 20 failures for one address from all network addresses', async () => {
    const { email, id } = await person();
    // Four from each of five network addresses, so that no one of them reaches its own limit.
    for (let n = 0; n < 19; n++) await expectRefused(await signIn(email, WRONG, from(30 + (n % 5))));
    // Nineteen are not twenty.
    await expectSignedIn(await signIn(email, PASSWORD, from(40)), id);
    await expectRefused(await signIn(email, WRONG, from(40)));

    await expectRefused(await signIn(email, PASSWORD, from(41)));
    await expectRefused(await signIn(email, PASSWORD, from(30)));
    await expectRefused(await signIn(email, PASSWORD, {}));
    // One entry for each refusal, the refusals by the limit included, each with the user.
    const entries = await refusals();
    expect(entries).toHaveLength(23);
    expect(entries.every((entry) => entry.userId === id)).toBe(true);
  }, 30_000);

  it('does not count an attempt that a limit refused', async () => {
    const { email, id } = await person();
    for (let n = 0; n < 5; n++) await signIn(email, WRONG, from(50));
    // Thirty more from the same network address: each refused by its limit of
    // 5. Were they counted, the address would now be refused everywhere.
    for (let n = 0; n < 30; n++) await expectRefused(await signIn(email, WRONG, from(50)));
    await expectSignedIn(await signIn(email, PASSWORD, from(51)), id);
    // And exactly fifteen more failures are needed to reach 20.
    for (let n = 0; n < 14; n++) await signIn(email, WRONG, from(52 + (n % 4)));
    await expectSignedIn(await signIn(email, PASSWORD, from(58)), id);
    await signIn(email, WRONG, from(58));
    await expectRefused(await signIn(email, PASSWORD, from(59)));
  }, 30_000);

  it('counts an address that belongs to no account exactly as one that does', async () => {
    // Shown by giving the address an account afterwards: the failures made
    // before it existed hold it back.
    const perAddress = address();
    for (let n = 0; n < 5; n++) await expectRefused(await signIn(perAddress, WRONG, from(60)));
    const everywhere = address();
    for (let n = 0; n < 20; n++) await expectRefused(await signIn(everywhere, WRONG, from(61 + (n % 5))));
    expect((await refusals()).every((entry) => entry.userId === null)).toBe(true);

    const first = await createAccount(auth, perAddress);
    await expectRefused(await signIn(perAddress, PASSWORD, from(60)));
    await expectSignedIn(await signIn(perAddress, PASSWORD, from(69)), first);
    await createAccount(auth, everywhere);
    await expectRefused(await signIn(everywhere, PASSWORD, from(69)));
  }, 30_000);

  it('counts a refusal of an address that is not verified, so that it is told from nothing', async () => {
    const { email } = await person(false);
    for (let n = 0; n < 5; n++) await signIn(email, PASSWORD, from(70));
    await db().user.updateMany({ where: { email }, data: { emailVerified: true } });
    await expectRefused(await signIn(email, PASSWORD, from(70)));
  });

  it('verifies no more passwords than the limit when the attempts arrive together', async () => {
    const { email } = await person();
    const context = await auth().$context;
    const verify = vi.spyOn(context.password, 'verify');
    const answers = await Promise.all(Array.from({ length: 12 }, () => signIn(email, WRONG, from(80))));
    for (const answer of answers) await expectRefused(answer);
    expect(verify).toHaveBeenCalledTimes(5);
  }, 30_000);

  it('refuses the request where the limiter cannot answer, and verifies nothing (NFR-SE-06, A10)', async () => {
    const { email, id } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = await auth().$context;
    const verify = vi.spyOn(context.password, 'verify');
    vi.spyOn(valkey(), 'eval').mockRejectedValue(new Error('ECONNREFUSED redis://secret@host'));
    const response = await signIn(email);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: {
        code: 'internal',
        message:
          'The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes.',
      },
    });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(verify).not.toHaveBeenCalled();
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    // NFR-SE-19: the class of the fault, and nothing it carried. The library's
    // router would print the error whole. The turn could not be given back
    // either, which is said and does not take the place of the fault.
    expect(errors.mock.calls).toEqual([['sign-in: turn not released'], ['identity: request failed (Error)']]);
  });

  it('keeps the outcome of a sign-in where its turn cannot be given back', async () => {
    const { email, id } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const evaluate = valkey().eval.bind(valkey()) as (...args: unknown[]) => Promise<unknown>;
    // The script that gives the turn back, and no other, cannot reach Valkey.
    vi.spyOn(valkey(), 'eval').mockImplementation(((...args: unknown[]) =>
      String(args[0]).includes("redis.call('DEL'")
        ? Promise.reject(new Error('ECONNRESET redis://secret@host'))
        : evaluate(...args)) as never);
    await expectSignedIn(await signIn(email), id);
    expect(errors.mock.calls).toEqual([['sign-in: turn not released']]);
  });

  it('refuses an attempt that gets no turn in time as any other, and neither verifies nor counts (FR-AU-81)', async () => {
    const { email } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const context = await auth().$context;
    const verify = vi.spyOn(context.password, 'verify');
    const hash = vi.spyOn(context.password, 'hash');
    const asked = vi.spyOn(valkey(), 'eval');
    // Another attempt for the address holds the turn, and the 10 seconds an
    // attempt waits for it pass at the first look.
    const now = Date.now.bind(Date);
    let passed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => now() + passed);
    vi.spyOn(valkey(), 'set').mockImplementation((async () => {
      passed = 11_000;
      return null;
    }) as never);

    await expectRefused(await signIn(email));
    expect(verify).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
    // No limit was asked, and none counted.
    expect(asked).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    // One entry, and no user: nothing was read of the address.
    expect((await db().securityLogEntry.findMany()).map(({ kind, userId }) => ({ kind, userId }))).toEqual([
      { kind: 'sign_in_refused', userId: null },
    ]);
    // The right password signs in once the turn is free.
    expect((await signIn(email)).status).toBe(200);
  });

  // NFR-SE-19 lists "a rate limit reached" as an event of its own.
  it('writes one entry for each period of a limit that refuses a sign-in, with the user where there is one', async () => {
    const known = await person();
    const unknown = address();
    const reached = () =>
      db().securityLogEntry.findMany({ where: { kind: 'rate_limit_reached' }, select: { userId: true } });

    for (let n = 0; n < 5; n++) await signIn(known.email, WRONG, from(90));
    for (let n = 0; n < 5; n++) await signIn(unknown, WRONG, from(90));
    // Reaching a limit is not being refused by it: nothing yet.
    expect(await reached()).toEqual([]);

    await expectRefused(await signIn(known.email, PASSWORD, from(90)));
    expect(await reached()).toEqual([{ userId: known.id }]);
    await expectRefused(await signIn(unknown, PASSWORD, from(90)));
    expect((await reached()).map((entry) => entry.userId).sort()).toEqual([known.id, null].sort());
    // Once for the period, however many are refused in it.
    for (let n = 0; n < 4; n++) await expectRefused(await signIn(known.email, WRONG, from(90)));
    await expectRefused(await signIn(unknown, WRONG, from(90)));
    expect(await reached()).toHaveLength(2);
    // Each refusal still has its own entry, and the response is as it was.
    expect(await refusals()).toHaveLength(17);

    // The mark is kept under a keyed digest: Valkey holds no address (NFR-SE-01).
    const keys = (await valkey().keys('limit-logged:*')).join(' ');
    expect(keys).not.toContain('example.com');
    expect(keys).not.toContain('198.51.100');
  });

  it('writes no such entry for a sign-in refused for any other reason', async () => {
    const { email } = await person();
    await signIn(email, WRONG, from(91));
    await signIn(address(), PASSWORD, from(91));
    expect(await db().securityLogEntry.count({ where: { kind: 'rate_limit_reached' } })).toBe(0);
  });

  it('refuses the request where the database cannot answer, and prints nothing of the fault', async () => {
    const { email } = await person();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.sql('ALTER TABLE "User" RENAME TO "UserAway"');
    try {
      const response = await signIn(email);
      expect(response.status).toBe(500);
      expect(response.headers.getSetCookie()).toEqual([]);
    } finally {
      database.sql('ALTER TABLE "UserAway" RENAME TO "User"');
    }
    expect(errors.mock.calls).toHaveLength(1);
    expect(errors.mock.calls[0]).toEqual(['identity: request failed (PrismaClientKnownRequestError P2021)']);
    // The turn was given back: the next attempt does not wait for it.
    expect((await signIn(email)).status).toBe(200);
  });
});

describe('an account with two-factor authentication on (FR-AU-81, FR-AU-83)', () => {
  it('gets no session by the password alone', async () => {
    const { email, id } = await person();
    await db().user.update({ where: { id }, data: { twoFactorEnabled: true } });
    const response = await signIn(email);
    // The library's own signal for the second step, which a later slice builds.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ twoFactorRedirect: true, twoFactorMethods: [] });

    expect(await db().session.count({ where: { userId: id } })).toBe(0);
    const cookies = response.headers.getSetCookie();
    // No cookie of a session is left in the answer with a value, not even one that is then cleared.
    for (const cookie of cookies.filter((each) => /session_(token|data)/.test(each))) {
      expect(cookie).toMatch(/session_(token|data)=;/);
      expect(cookie).toContain('Max-Age=0');
    }
    const headers = new Headers({ cookie: cookiesOf(response) });
    expect((await validateSessionRow(headers)).session).toBeNull();
    expect((await validateSession('GET', headers)).session).toBeNull();
    // A wrong password is refused as for any account, and counted.
    await expectRefused(await signIn(email, WRONG));
  });
});

describe('the two periods of a session begun by a sign-in (FR-AU-84)', () => {
  it('renews at most once in the renewal period of the settings, and ends at the longest period', async () => {
    const { email, id } = await person();
    const headers = new Headers({ cookie: cookiesOf(await signIn(email)) });
    const row = () => db().session.findFirstOrThrow({ where: { userId: id } });
    const began = await row();

    // Within the 12 hours of the settings: a validation writes nothing.
    await validateSessionRow(headers);
    expect((await row()).expiresAt).toEqual(began.expiresAt);

    // Thirteen hours on, a validation renews, once.
    const earlier = new Date(Date.now() - 13 * 60 * 60 * 1000);
    await db().session.update({
      where: { id: began.id },
      data: {
        createdAt: earlier,
        updatedAt: earlier,
        expiresAt: new Date(earlier.getTime() + 6 * DAY * 1000),
      },
    });
    expect((await validateSessionRow(headers)).session?.userId).toBe(id);
    const renewed = await row();
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY * 1000 - 60_000);
    expect(renewed.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 6 * DAY * 1000);
    expect(renewed.createdAt).toEqual(earlier);
    await validateSessionRow(headers);
    expect((await row()).expiresAt).toEqual(renewed.expiresAt);

    // Twenty days after it began, however lately it was renewed, it has ended.
    await db().session.update({
      where: { id: began.id },
      data: { createdAt: new Date(Date.now() - 20 * DAY * 1000 - 1000) },
    });
    expect((await validateSessionRow(headers)).session).toBeNull();
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });
});
