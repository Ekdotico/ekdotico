// The acceptance of an admission invitation, `POST /api/sign-up` (FR-AU-90,
// FR-AU-09, FR-AU-82, FR-AU-02), through its route handler, against a
// provisioned database. The limit for each network address is the proxy's,
// and is tested with it; the origin check is the proxy's and the route's own.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

// One step of the transaction, made to fail on demand.
const fault = vi.hoisted(() => ({ workspace: false }));
vi.mock('../../src/lib/workspace.ts', async (original) => {
  const actual = await original<typeof import('../../src/lib/workspace.ts')>();
  return {
    ...actual,
    createPersonalWorkspace: (...args: Parameters<typeof actual.createPersonalWorkspace>) =>
      fault.workspace
        ? Promise.reject(new Error('the workspace of private.person@example.com was not written'))
        : actual.createPersonalWorkspace(...args),
  };
});

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-sign-up-'));
const database = prepare('sign_up', { EMAIL_SINK_DIRECTORY: sink, TRUSTED_PROXY_COUNT: '1' });
const { auth, db, valkey, validateSessionRow } = await load();
const { acceptInvitation, createInvitation, findOpenInvitation } =
  await import('../../src/lib/admission/invitations.ts');
const { POST } = await import('../../src/app/api/sign-up/route.ts');

const STATEMENT = 'This invitation is not open. Ask the Ekdotico team for a new one.';
const PASSWORD = 'a long and private phrase';
const BROWSER = 'Mozilla/5.0 (a browser of the tests)';

let invitations = 0;
/** An invitation as the endpoint creates it; the token as only the email carries it. */
async function invite(email: string, now?: Date) {
  const result = await createInvitation({ email, requestId: `request-${++invitations}` }, now);
  if (result.outcome !== 'created') throw new Error(`not created: ${result.outcome}`);
  return { id: result.invitation.id, token: /\/sign-up\/([A-Za-z0-9_-]+)/.exec(result.message.text)![1]! };
}

function submit(body: unknown, raw?: string, headers: Record<string, string> = {}) {
  return POST(
    new Request(`${ORIGIN}/api/sign-up`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: ORIGIN,
        'user-agent': BROWSER,
        'x-forwarded-for': '198.51.100.7',
        ...headers,
      },
      body: raw ?? JSON.stringify(body),
    }),
  );
}

const counts = async () => ({
  users: await db().user.count(),
  accounts: await db().account.count(),
  workspaces: await db().workspace.count(),
  sessions: await db().session.count(),
});
const NOTHING = { users: 0, accounts: 0, workspaces: 0, sessions: 0 };

afterEach(async () => {
  vi.restoreAllMocks();
  fault.workspace = false;
  await db().session.deleteMany();
  await db().workspace.deleteMany();
  await db().account.deleteMany();
  await db().user.deleteMany();
  await db().admissionInvitation.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
  rmSync(sink, { recursive: true, force: true });
});

describe('a pending invitation', () => {
  it('creates the account, its password, its workspace, and marks the invitation accepted', async () => {
    const { id, token } = await invite('New.Person@example.com');
    const response = await submit({ token, name: '  Ada Lovelace  ', password: PASSWORD });
    expect(response.status).toBe(201);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('{"signedIn":true}');

    // FR-AU-02, FR-AU-90: the invited address, lower case, recorded as verified.
    const user = await db().user.findUniqueOrThrow({ where: { email: 'new.person@example.com' } });
    expect(user).toMatchObject({ name: 'Ada Lovelace', emailVerified: true, twoFactorEnabled: false });

    // NFR-SE-17 (a): the hash of the identity library's own function, and no password.
    const [account, ...others] = await db().account.findMany({ where: { userId: user.id } });
    expect(others).toEqual([]);
    expect(account).toMatchObject({ providerId: 'credential', accountId: user.id });
    if (!account?.password) throw new Error('the account has no password hash');
    expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    const context = await auth().$context;
    expect(await context.password.verify({ hash: account.password!, password: PASSWORD })).toBe(true);
    expect(database.sql('SELECT string_agg(row_to_json(a)::text, \' \') FROM "Account" a')).not.toContain(
      PASSWORD,
    );

    // FR-AU-09: the personal workspace, in the same transaction.
    const workspace = await db().workspace.findUniqueOrThrow({ where: { ownerId: user.id } });
    expect(workspace.type).toBe('PERSONAL');

    const invitation = await db().admissionInvitation.findUniqueOrThrow({ where: { id } });
    expect(invitation).toMatchObject({ state: 'ACCEPTED', acceptedById: user.id });
    expect(Date.now() - invitation.acceptedAt!.getTime()).toBeLessThan(60_000);
    expect(await findOpenInvitation(token)).toBeNull();
  });

  it('then signs the person in: an ordinary session, whose row validates', async () => {
    const { token } = await invite('person@example.com');
    const response = await submit({ token, name: 'A Person', password: PASSWORD });
    const user = await db().user.findUniqueOrThrow({ where: { email: 'person@example.com' } });

    // NFR-SE-17 (c): HttpOnly, Secure, SameSite=Lax, host-only.
    const cookie = response.headers.getSetCookie().find((value) => value.includes('session_token'));
    expect(cookie).toBeDefined();
    const attributes = cookie!.toLowerCase();
    for (const attribute of ['httponly', 'secure', 'samesite=lax', 'path=/']) {
      expect(attributes).toContain(attribute);
    }
    expect(attributes).not.toContain('domain=');

    // FR-AU-84: the row records the address and the browser it began from.
    // Read before the validation below, which may renew its expiry.
    const [row, ...others] = await db().session.findMany({ where: { userId: user.id } });
    expect(others).toEqual([]);
    if (!row) throw new Error('no session was created');
    expect(row).toMatchObject({ ipAddress: '198.51.100.7', userAgent: BROWSER });
    // The 7 days of an ordinary session, not the 1 day of one that is not remembered.
    expect(row.expiresAt.getTime() - Date.now()).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);

    const { session } = await validateSessionRow(new Headers({ cookie: cookiesOf(response) }));
    expect(session).toEqual({ userId: user.id, sessionId: row.id });
  });

  it('accepts a name of 100 characters, counted as code points, and refuses 101', async () => {
    const first = await invite('first@example.com');
    const hundred = '𝒜'.repeat(100);
    expect((await submit({ token: first.token, name: hundred, password: PASSWORD })).status).toBe(201);
    expect((await db().user.findUniqueOrThrow({ where: { email: 'first@example.com' } })).name).toBe(hundred);

    const second = await invite('second@example.com');
    const response = await submit({ token: second.token, name: `${hundred}𝒜`, password: PASSWORD });
    expect(response.status).toBe(422);
    expect(await findOpenInvitation(second.token)).not.toBeNull();
  });

  it('works once: the same link creates nothing a second time', async () => {
    const { token } = await invite('person@example.com');
    expect((await submit({ token, name: 'A Person', password: PASSWORD })).status).toBe(201);
    const before = await counts();
    const again = await submit({ token, name: 'Another', password: `${PASSWORD} again` });
    expect(again.status).toBe(409);
    expect(again.headers.getSetCookie()).toEqual([]);
    expect(await counts()).toEqual(before);
  });

  it('creates exactly one account where one token is submitted many times at once', async () => {
    const { token } = await invite('person@example.com');
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, n) => submit({ token, name: `Person ${n}`, password: PASSWORD })),
    );
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await counts()).toEqual({ users: 1, accounts: 1, workspaces: 1, sessions: 1 });
    // Only the one that created the account is signed in.
    expect(responses.filter((response) => response.headers.getSetCookie().length > 0).length).toBe(1);
  });
});

describe('an invitation that is not open', () => {
  it('gives the one fixed statement, identical whichever reason applies, and creates nothing', async () => {
    const accepted = await invite('accepted@example.com');
    await db().admissionInvitation.update({ where: { id: accepted.id }, data: { state: 'ACCEPTED' } });
    const revoked = await invite('revoked@example.com');
    await db().admissionInvitation.update({
      where: { id: revoked.id },
      data: { state: 'REVOKED', revokedAt: new Date() },
    });
    // Past its expiry, and still stored as pending: no timer has touched it.
    const expired = await invite('expired@example.com', new Date(Date.now() - 31 * 24 * 60 * 60 * 1000));
    const cleared = await invite('cleared@example.com');
    await db().admissionInvitation.update({ where: { id: cleared.id }, data: { email: null } });

    const fields = { name: 'A Person', password: PASSWORD };
    const answers = await Promise.all([
      submit({ ...fields, token: accepted.token }),
      submit({ ...fields, token: revoked.token }),
      submit({ ...fields, token: expired.token }),
      submit({ ...fields, token: cleared.token }),
      submit({ ...fields, token: 'A'.repeat(43) }), // well formed, and no invitation's
      submit({ ...fields, token: 'not-a-token' }),
      submit({ ...fields, token: '' }),
      submit({ ...fields, token: 42 }),
      submit(fields), // without a token
      submit({}),
    ]);
    const bodies = new Set<string>();
    for (const response of answers) {
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.getSetCookie()).toEqual([]);
      bodies.add(await response.text());
    }
    expect([...bodies]).toEqual([
      JSON.stringify({ error: { code: 'invitation_not_open', message: STATEMENT } }),
    ]);
    expect(await counts()).toEqual(NOTHING);
  });

  it('is refused twice over: by the lookup the page makes, and by the transaction itself', async () => {
    const tokens: Record<string, string> = {};
    for (const state of ['ACCEPTED', 'REVOKED', 'EXPIRED'] as const) {
      const { id, token } = await invite(`${state.toLowerCase()}@example.com`);
      await db().admissionInvitation.update({ where: { id }, data: { state } });
      tokens[state] = token;
    }
    // Past its expiry and still stored as pending.
    tokens.late = (await invite('late@example.com', new Date(Date.now() - 31 * 24 * 60 * 60 * 1000))).token;
    const cleared = await invite('cleared@example.com');
    await db().admissionInvitation.update({ where: { id: cleared.id }, data: { email: null } });
    tokens.cleared = cleared.token;
    tokens.unknown = 'B'.repeat(43);

    for (const token of Object.values(tokens)) {
      expect(await findOpenInvitation(token)).toBeNull();
      // Called as if the lookup had let it through.
      expect(await acceptInvitation({ token, name: 'A Person', passwordHash: 'a-hash' })).toBeNull();
    }
    expect(await counts()).toEqual(NOTHING);
    const states = (await db().admissionInvitation.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (row) => `${row.state} ${row.acceptedById}`,
    );
    expect(states.sort()).toEqual(
      ['ACCEPTED null', 'EXPIRED null', 'PENDING null', 'PENDING null', 'REVOKED null'].sort(),
    );
  });

  it('is told so before anything is said of the name or the password', async () => {
    const response = await submit({ token: 'A'.repeat(43), name: '', password: 'short' });
    expect(response.status).toBe(409);
  });

  it('is what a replaced invitation is: the old link creates nothing', async () => {
    const old = await invite('person@example.com');
    const current = await invite('person@example.com');
    expect((await submit({ token: old.token, name: 'A Person', password: PASSWORD })).status).toBe(409);
    expect(await counts()).toEqual(NOTHING);
    expect((await submit({ token: current.token, name: 'A Person', password: PASSWORD })).status).toBe(201);
  });

  it('is what an invitation is whose address has since gained an account, and the team is told', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, token } = await invite('taken@example.com');
    await createAccount(auth, 'taken@example.com');
    const before = await counts();
    const response = await submit({ token, name: 'A Person', password: PASSWORD });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: 'invitation_not_open', message: STATEMENT } });
    expect(await counts()).toEqual(before);
    // The claim was rolled back with the rest.
    expect((await db().admissionInvitation.findUniqueOrThrow({ where: { id } })).state).toBe('PENDING');
    // One line, which names neither the invitation nor the address (NFR-SE-19).
    expect(printed.mock.calls).toEqual([['admission: invitation not accepted (address has an account)']]);
  });

  it('prints nothing for an invitation that is simply not open', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await submit({ token: 'A'.repeat(43), name: 'A Person', password: PASSWORD })).status).toBe(409);
    expect(printed).not.toHaveBeenCalled();
  });
});

// A request that cannot be read says nothing of its invitation: it is not
// answered "not open", which would take the form away from a person whose
// invitation stands.
describe('a request that cannot be read', () => {
  async function refused(response: Response, status: number, token: string) {
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = await response.json();
    expect(Object.keys(body)).toEqual(['error']);
    expect(Object.keys(body.error)).toEqual(['code', 'message']);
    expect(body.error.code).toBe('invalid');
    expect(body.error.message).not.toBe(STATEMENT);
    expect(await counts()).toEqual(NOTHING);
    expect(await findOpenInvitation(token)).not.toBeNull();
    return body.error.message as string;
  }

  it('is answered 413 where it is longer than 4,096 bytes, before the invitation is looked at', async () => {
    const { token } = await invite('open@example.com');
    const looked = vi.spyOn(db().admissionInvitation, 'findFirst');
    const fields = { token, password: PASSWORD };
    const response = await submit({ ...fields, name: 'n'.repeat(5000) });
    expect(looked).not.toHaveBeenCalled();
    expect(await refused(response, 413, token)).toBe(
      'The account was not created, because the request is longer than a name and a password can make it. Shorten the name or the password and try again.',
    );
    // To the byte: 4,096 are read, and 4,097 are not.
    const padded = (bytes: number) => {
      const empty = JSON.stringify({ ...fields, name: 'A Person', padding: '' });
      return JSON.stringify({ ...fields, name: 'A Person', padding: 'x'.repeat(bytes - empty.length) });
    };
    await refused(await submit(undefined, padded(4097)), 413, token);
    expect((await submit(undefined, padded(4096))).status).toBe(201);
  });

  it.each([
    ['is not JSON', 'token=abc'],
    ['is empty', ''],
    ['is JSON and no object: null', 'null'],
    ['is JSON and no object: a list', '[]'],
    ['is JSON and no object: text', '"text"'],
  ])('is answered 422 where it %s, before the invitation is looked at', async (_, raw) => {
    const { token } = await invite('open@example.com');
    const looked = vi.spyOn(db().admissionInvitation, 'findFirst');
    const response = await submit(undefined, raw);
    expect(looked).not.toHaveBeenCalled();
    expect(await refused(response, 422, token)).toBe(
      'The account was not created, because Ekdotico could not read the request. Reload the page and try again.',
    );
  });
});

describe('an account whose session cannot be started (FR-AU-90)', () => {
  it('stands, and the answer says that the person is not signed in', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, token } = await invite('private.person@example.com');
    const context = await auth().$context;
    vi.spyOn(context.internalAdapter, 'createSession').mockRejectedValue(
      Object.assign(new Error('no session for private.person@example.com'), { code: 'P1001' }),
    );
    const response = await submit({ token, name: 'A Person', password: PASSWORD });
    // Created, so 201; and nothing that signs the browser in.
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ signedIn: false });
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await counts()).toEqual({ users: 1, accounts: 1, workspaces: 1, sessions: 0 });
    expect((await db().admissionInvitation.findUniqueOrThrow({ where: { id } })).state).toBe('ACCEPTED');
    // NFR-SE-19: the class and the code of the fault, and nothing it said.
    expect(printed.mock.calls).toEqual([['sign-up: account created, session not started (Error P1001)']]);
    // The person signs in on the sign-in page.
    vi.restoreAllMocks();
    expect((await signIn(auth, 'private.person@example.com', PASSWORD)).status).toBe(200);
  });
});

// The owner's decision of 8 October 2026: a sign-up ends the session the
// browser already held, as a sign-in does (sign-in.test.ts).
describe('a browser that already holds a session', () => {
  /** Another account, signed in: its cookies, and the row of its session. */
  async function holder() {
    const userId = await createAccount(auth, 'holder@example.com');
    const cookie = cookiesOf(await signIn(auth, 'holder@example.com'));
    const { id } = await db().session.findFirstOrThrow({ where: { userId } });
    return { userId, cookie, sessionId: id };
  }

  it('loses that session at a sign-up, and gets the cookies of the new one alone', async () => {
    const held = await holder();
    const { token } = await invite('person@example.com');
    const response = await submit({ token, name: 'A Person', password: PASSWORD }, undefined, {
      cookie: held.cookie,
    });
    expect(await response.json()).toEqual({ signedIn: true });

    expect(await db().session.count({ where: { id: held.sessionId } })).toBe(0);
    expect(await db().session.count({ where: { userId: held.userId } })).toBe(0);
    const user = await db().user.findUniqueOrThrow({ where: { email: 'person@example.com' } });
    const cookies = response.headers.getSetCookie();
    expect(cookies.map((cookie) => cookie.split('=')[0]).sort()).toEqual([
      '__Secure-better-auth.session_data',
      '__Secure-better-auth.session_token',
    ]);
    const { session } = await validateSessionRow(new Headers({ cookie: cookiesOf(response) }));
    expect(session?.userId).toBe(user.id);
    // The cookies it held open nothing any more.
    expect((await validateSessionRow(new Headers({ cookie: held.cookie }))).session).toBeNull();
  });

  it('keeps that session where the sign-up creates nothing', async () => {
    const held = await holder();
    const { token } = await invite('person@example.com');
    const sent = { cookie: held.cookie };
    expect(
      (await submit({ token: 'A'.repeat(43), name: 'A Person', password: PASSWORD }, undefined, sent)).status,
    ).toBe(409);
    expect((await submit({ token, name: '', password: 'short' }, undefined, sent)).status).toBe(422);
    expect((await submit(undefined, 'not JSON', sent)).status).toBe(422);
    expect(await db().session.count({ where: { id: held.sessionId } })).toBe(1);
    expect((await validateSessionRow(new Headers({ cookie: held.cookie }))).session?.userId).toBe(
      held.userId,
    );
  });

  it('is told of nothing in silence where that session cannot be ended: the fault is printed, and the cookies are cleared', async () => {
    const held = await holder();
    const { token } = await invite('person@example.com');
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    // A fault of the database itself, as in sign-out.test.ts.
    database.sql('ALTER TABLE "Session" RENAME TO "SessionAway"');
    let response: Response;
    try {
      response = await submit({ token, name: 'A Person', password: PASSWORD }, undefined, {
        cookie: held.cookie,
      });
    } finally {
      database.sql('ALTER TABLE "SessionAway" RENAME TO "Session"');
    }
    // The account stands (FR-AU-90), and the browser is signed in as no one.
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ signedIn: false });
    expect(printed.mock.calls).toEqual([
      ['sign-up: account created, session not started (PrismaClientKnownRequestError P2021)'],
    ]);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((each) => each.includes('session_token=;'))).toBe(true);
    expect(cookies.some((each) => /session_token=[^;]/.test(each))).toBe(false);
  });
});

describe('a name or a password that does not meet its rule (FR-AU-82)', () => {
  async function refused(body: Record<string, unknown>, email = 'ada.lovelace@example.com') {
    const { token } = await invite(email);
    const response = await submit({ token, ...body });
    expect(response.status).toBe(422);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.getSetCookie()).toEqual([]);
    const { error, ...rest } = await response.json();
    expect(rest).toEqual({});
    expect(Object.keys(error)).toEqual(['code', 'message', 'fields']);
    expect(error.code).toBe('invalid');
    // Nothing was created, and the invitation is still open.
    expect(await counts()).toEqual(NOTHING);
    expect(await findOpenInvitation(token)).not.toBeNull();
    await db().admissionInvitation.deleteMany();
    return error.fields as { name?: string; password?: string };
  }

  it.each([
    ['no name', { password: PASSWORD }],
    ['an empty name', { name: '', password: PASSWORD }],
    ['a name of spaces alone', { name: '   ', password: PASSWORD }],
    ['a name of 101 characters', { name: 'n'.repeat(101), password: PASSWORD }],
    ['a name that is not text', { name: { first: 'Ada' }, password: PASSWORD }],
  ])('names the name alone, for %s', async (_, body) => {
    const fields = await refused(body);
    expect(Object.keys(fields)).toEqual(['name']);
    expect(fields.name).toContain('1 to 100 characters');
  });

  it.each([
    ['too short', '7 chars', /at least 8 characters/],
    ['too long', 'x'.repeat(33), /at most 32 characters/],
    ['one that contains the address', 'ADA.LOVELACE@example.com 1', /cannot contain your email address/],
    ['one that contains its local part', 'i am Ada.Lovelace!', /cannot contain your email address/],
    ['one on the list', 'PasswordPassword', /on a list of commonly used and known-compromised/],
    ['none', undefined, /at least 8 characters/],
    ['one that is not text', 123456789012345, /at least 8 characters/],
  ])('says which rule the password did not meet: %s', async (_, password, rule) => {
    const fields = await refused({ name: 'Ada Lovelace', password });
    expect(Object.keys(fields)).toEqual(['password']);
    expect(fields.password).toMatch(rule);
  });

  it('names both where both fail', async () => {
    const fields = await refused({ name: '', password: 'short' });
    expect(Object.keys(fields).sort()).toEqual(['name', 'password']);
  });

  it('never repeats the password in its answer', async () => {
    const { token } = await invite('person@example.com');
    const response = await submit({ token, name: 'A Person', password: 'passwordpassword' });
    expect(await response.text()).not.toContain('passwordpassword');
  });
});

describe('one transaction', () => {
  it('is rolled back whole where one step fails, and the invitation stays open', async () => {
    const printed = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { id, token } = await invite('private.person@example.com');
    fault.workspace = true;
    const response = await submit({ token, name: 'A Person', password: PASSWORD });
    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toEqual([]);
    const body = await response.json();
    expect(Object.keys(body.error)).toEqual(['code', 'message']);
    expect(body.error.code).toBe('internal');
    expect(JSON.stringify(body)).not.toContain('private.person');

    // Neither the account, nor its password, nor the acceptance was kept.
    expect(await counts()).toEqual(NOTHING);
    const invitation = await db().admissionInvitation.findUniqueOrThrow({ where: { id } });
    expect(invitation).toMatchObject({ state: 'PENDING', acceptedAt: null, acceptedById: null });
    // NFR-SE-19: the class of the fault, and nothing it said.
    expect(JSON.stringify(printed.mock.calls)).toBe('[["sign-up: request failed (Error)"]]');

    // The person can try again with the same link.
    fault.workspace = false;
    expect((await submit({ token, name: 'A Person', password: PASSWORD })).status).toBe(201);
    expect(await counts()).toEqual({ users: 1, accounts: 1, workspaces: 1, sessions: 1 });
  });
});

describe('what no log holds (NFR-SE-19)', () => {
  it('neither the address, the name, the password, nor the token, through every answer', async () => {
    const outputs = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
      vi.spyOn(console, method as 'log').mockImplementation(() => {}),
    );
    const { token } = await invite('private.person@example.com');
    await submit({ token, name: 'Private Name', password: 'short private' });
    await submit({ token, name: 'Private Name', password: 'a private.person password' });
    await submit({ token, name: 'Private Name', password: PASSWORD });
    await submit({ token, name: 'Private Name', password: PASSWORD });
    const printed = JSON.stringify(outputs.flatMap((output) => output.mock.calls));
    for (const secret of ['private.person', 'Private Name', 'short private', PASSWORD, token]) {
      expect(printed).not.toContain(secret);
    }
  });
});

describe('the endpoint inside the identity library', () => {
  it('cannot be reached through the library’s handler, by any spelling', async () => {
    const { token } = await invite('person@example.com');
    const body = JSON.stringify({ token, name: 'A Person', password: PASSWORD });
    for (const path of [
      '/accept-admission-invitation',
      '/acceptAdmissionInvitation',
      '/sign-up',
      '/sign-up/email',
      '/sign-up/admission',
      '',
      '/',
    ]) {
      const response = await auth().handler(
        new Request(`${ORIGIN}/api/auth${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: ORIGIN },
          body,
        }),
      );
      expect(response.status).toBe(404);
    }
    expect(await counts()).toEqual(NOTHING);
    expect(await findOpenInvitation(token)).not.toBeNull();
  });

  it('has no path for the library’s router to match', () => {
    const endpoint = auth().api.acceptAdmissionInvitation as unknown as { path?: string };
    expect(endpoint.path).toBeUndefined();
  });
});

// NFR-SE-17 (c): the route checks the origin itself, since the proxy can be
// skipped (docs/operations/deployment.md).
describe('a request from another origin (NFR-SE-17 (c))', () => {
  const FORBIDDEN =
    '{"error":{"code":"forbidden","message":"This request did not come from a page of Ekdotico and was not carried out. Open Ekdotico in the browser and try again."}}';
  const forbidden = () => db().securityLogEntry.count({ where: { kind: 'forbidden', userId: null } });

  it('is refused as the proxy refuses it, before the invitation is looked at, with one entry for the period', async () => {
    const { token } = await invite('person@example.com');
    const before = await forbidden();
    const from = { 'x-forwarded-for': '203.0.113.50' };
    for (const origin of ['https://evil.example', 'null', `${ORIGIN}.evil.example`, '']) {
      const response = await submit({ token, name: 'A Person', password: PASSWORD }, undefined, {
        origin,
        ...from,
      });
      expect(response.status, origin).toBe(403);
      expect(await response.text(), origin).toBe(FORBIDDEN);
      expect(response.headers.getSetCookie(), origin).toEqual([]);
    }
    // Without the header at all.
    const bare = await POST(
      new Request(`${ORIGIN}/api/sign-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...from },
        body: JSON.stringify({ token, name: 'A Person', password: PASSWORD }),
      }),
    );
    expect(bare.status).toBe(403);
    expect(await counts()).toEqual(NOTHING);
    expect(await findOpenInvitation(token)).not.toBeNull();
    // NFR-SE-19: a 403 has its entry, one for the period and the network
    // address, however many requests were refused in it.
    expect((await forbidden()) - before).toBe(1);
    // And the invitation is accepted from the application's own origin.
    expect((await submit({ token, name: 'A Person', password: PASSWORD })).status).toBe(201);
  });
});

// The independent review of 8 October 2026. The identity library hashes the
// compatibility form (NFKC) of a password; every rule has to judge that form,
// and sign-in has to count as sign-up counted.
describe('a password as it is stored (FR-AU-81, FR-AU-82)', () => {
  it('signs in with a password of characters outside the basic plane, at the longest a password can be', async () => {
    // 32 characters, 64 units of UTF-16.
    const password = '😀'.repeat(32);
    const { token } = await invite('emoji@example.com');
    expect((await submit({ token, name: 'A Person', password })).status).toBe(201);
    expect((await signIn(auth, 'emoji@example.com', password)).status).toBe(200);
    expect((await signIn(auth, 'emoji@example.com', '😀'.repeat(31))).status).toBe(401);
  });

  // What the rules rest on: were the library to hash what it is given as it is
  // given, a rule judged on the compatibility form would judge another password.
  it('is hashed by the identity library in its compatibility form', async () => {
    const context = await auth().$context;
    const hash = await context.password.hash('ｆｕｌｌ-ｗｉｄｔｈ ｐｈｒａｓｅ');
    expect(await context.password.verify({ hash, password: 'full-width phrase' })).toBe(true);
    expect(await context.password.verify({ hash, password: 'full-width phrasf' })).toBe(false);
  });

  it('signs up and signs in with 32 composed characters typed decomposed', async () => {
    // 64 code points as typed, a letter and its accent 32 times; 32 as stored.
    const decomposed = 'é'.repeat(32);
    const composed = 'é'.repeat(32);
    expect([...decomposed]).toHaveLength(64);
    expect(decomposed.normalize('NFKC')).toBe(composed);
    const { token } = await invite('accents@example.com');
    expect((await submit({ token, name: 'A Person', password: decomposed })).status).toBe(201);
    expect((await signIn(auth, 'accents@example.com', decomposed)).status).toBe(200);
    expect((await signIn(auth, 'accents@example.com', composed)).status).toBe(200);
    // And 33 of them are one too many, typed either way.
    const longer = await invite('accents-long@example.com');
    expect((await submit({ token: longer.token, name: 'A Person', password: `${decomposed}é` })).status).toBe(
      422,
    );
  });

  it('refuses a password one character longer, however it is counted', async () => {
    const { token } = await invite('emoji-long@example.com');
    const response = await submit({ token, name: 'A Person', password: '😀'.repeat(33) });
    expect(response.status).toBe(422);
  });

  it('refuses the full-width spelling of a password that holds the address', async () => {
    const { token } = await invite('probelocal@example.com');
    // Full-width letters, which the stored form turns into "probelocal-x1".
    const response = await submit({ token, name: 'A Person', password: 'ｐｒｏｂｅｌｏｃａｌ-x1' });
    expect(response.status).toBe(422);
    expect((await response.json()).error.fields.password).toMatch(/cannot contain your email address/);
  });
});

describe('a name (FR-AU-90)', () => {
  it.each([
    ['a null character', 'a\u0000b'],
    ['a line feed', 'a\nb'],
    ['an escape character', 'a\u001bb'],
    ['a delete character', 'a\u007fb'],
  ])('refuses %s, with the rule and not a fault', async (_, name) => {
    const { token } = await invite(`control-${++invitations}@example.com`);
    const response = await submit({ token, name, password: PASSWORD });
    expect(response.status).toBe(422);
    expect((await response.json()).error.fields.name).toMatch(/1 to 100 characters/);
    // The invitation is still open.
    expect(await findOpenInvitation(token)).not.toBeNull();
  });
});
