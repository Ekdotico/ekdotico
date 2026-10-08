// The application's configuration of the identity library (NFR-SE-17), against
// a provisioned database, connected as the runtime role. What the library can
// do is shown in identity-library.test.ts; this file shows what the
// application has made of it.
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, DAY, load, ORIGIN, PASSWORD, prepare, signIn } from './identity.ts';

const database = prepare('authconfig', {
  TRUSTED_PROXY_COUNT: '1',
  // Not the initial values, to show that each comes from the settings.
  SESSION_IDLE_SECONDS: String(6 * DAY),
  SESSION_RENEW_SECONDS: String(DAY / 2),
  COOKIE_CACHE_SECONDS: '45',
});
const { auth, IDENTITY_ENDPOINTS, db, valkey } = await load();

let userId = '';
const request = (method: string, path: string, headers: Record<string, string> = {}) =>
  auth().handler(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(method === 'GET' ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
    }),
  );
const sessionHeaders = async (email: string) =>
  new Headers({ cookie: cookiesOf(await signIn(auth, email)), origin: ORIGIN });

beforeAll(async () => {
  userId = await createAccount(auth, 'person@example.com');
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('what is configured (NFR-SE-17)', () => {
  it('takes the origin, the periods of a session and the copy from the settings', async () => {
    const context = await auth().$context;
    expect(context.baseURL).toBe(`${ORIGIN}/api/auth`);
    // (c): the allow-list holds the application's own origin and no other.
    expect([...new Set(context.trustedOrigins)]).toEqual([ORIGIN]);
    expect(context.sessionConfig.expiresIn).toBe(6 * DAY);
    expect(context.sessionConfig.updateAge).toBe(DAY / 2);
    expect(auth().options.session.cookieCache).toEqual({ enabled: true, maxAge: 45 });
  });

  it('has only two-factor authentication of the plugins, and no social provider (d)', () => {
    // The other four are the application's own: the gate, tested below; its
    // sign-in and sign-out (sign-in.test.ts, sign-out.test.ts); its reset and
    // change of a password and its ending of sessions (password-reset.test.ts,
    // change-password.test.ts, session-list.test.ts); and the acceptance of an
    // admission invitation, which has no path.
    expect(auth().options.plugins.map((plugin) => plugin.id)).toEqual([
      'two-factor',
      'ekdotico-surface',
      'ekdotico-sign-in',
      'ekdotico-credentials',
      'ekdotico-admission-sign-up',
    ]);
    // FR-AU-83: the plugin is given no option. With one it could send a code
    // by email (`otpOptions.sendOTP`), which NFR-SE-17 (d) switches off. Its
    // endpoints are the application's five and no other (two-factor.test.ts),
    // and its step after a sign-in, which can remember a device, is left out.
    const plugin = auth().options.plugins[0]! as {
      options?: unknown;
      hooks?: unknown;
      endpoints: Record<string, unknown>;
    };
    expect(plugin.options).toBeUndefined();
    expect(plugin.hooks).toBeUndefined();
    expect(Object.keys(plugin.endpoints).sort()).toEqual([
      'disableTwoFactor',
      'enableTwoFactor',
      'generateBackupCodes',
      'verifyBackupCode',
      'verifyTOTP',
    ]);
    expect(auth().options).not.toHaveProperty('socialProviders');
    expect(auth().options.account.accountLinking.enabled).toBe(false);
    expect(auth().options.user).toEqual({ changeEmail: { enabled: false }, deleteUser: { enabled: false } });
  });

  it('has public sign-up off and the two limits of a password (FR-AU-57, FR-AU-82)', () => {
    expect(auth().options.emailAndPassword).toEqual({
      enabled: true,
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 8,
      maxPasswordLength: 32,
    });
  });

  it("has the library's own limiter off, which counts in the memory of one instance (NFR-SE-07)", async () => {
    expect(auth().options.rateLimit).toEqual({ enabled: false });
    expect((await auth().$context).rateLimit.enabled).toBe(false);
  });

  it('refuses to be created where a variable of the library is set (b), (c)', async () => {
    // The library reads these whatever the options say: the first two switch
    // its telemetry on, the third adds trusted origins.
    for (const name of [
      'BETTER_AUTH_TELEMETRY',
      'BETTER_AUTH_TELEMETRY_ENDPOINT',
      'BETTER_AUTH_TRUSTED_ORIGINS',
    ]) {
      vi.resetModules();
      process.env[name] = 'https://elsewhere.example';
      try {
        const fresh = await import('../../src/lib/auth/auth.ts');
        expect(() => fresh.auth()).toThrow(name);
      } finally {
        delete process.env[name];
      }
    }
  });

  // The web application awaits this when it starts (src/instrumentation.ts):
  // the library builds its configuration in the background and would refuse it
  // here. A database that cannot be reached does not keep the process from starting.
  it('is built without a connection to the database', async () => {
    vi.resetModules();
    const url = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'postgresql://ekdotico_app:x@127.0.0.1:1/nowhere';
    try {
      const fresh = await import('../../src/lib/auth/auth.ts');
      expect((await fresh.auth().$context).options.basePath).toBe('/api/auth');
    } finally {
      process.env.DATABASE_URL = url;
    }
  });
});

describe('nothing leaves the process (NFR-SE-17 (b), NFR-DP-05)', () => {
  it('makes no request and opens no connection to another host, at a sign-in and at a session read', async () => {
    expect(auth().options.telemetry).toEqual({ enabled: false });
    const fetched = vi.spyOn(globalThis, 'fetch');
    const connected = vi.spyOn(net.Socket.prototype, 'connect');

    const response = await signIn(auth, 'person@example.com');
    expect(response.status).toBe(200);
    const headers = new Headers({ cookie: cookiesOf(response) });
    expect((await auth().api.getSession({ headers, query: { disableCookieCache: true } }))?.user.id).toBe(
      userId,
    );
    expect((await auth().api.getSession({ headers }))?.user.id).toBe(userId);
    // The telemetry of the library is sent in the background, where it is sent.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(fetched).not.toHaveBeenCalled();
    // A sign-in asks Valkey for its limits (sign-in.ts), whose client connects
    // through `net.createConnection`, which hands its arguments on as one list.
    const hosts = connected.mock.calls.map(([first, second]) => {
      const options: unknown = Array.isArray(first) ? first[0] : first;
      return typeof options === 'object' && options !== null
        ? (options as net.TcpSocketConnectOpts).host
        : second;
    });
    expect(hosts.length).toBeGreaterThan(0);
    for (const host of hosts) expect(['localhost', '127.0.0.1', '::1']).toContain(host);
  });
});

describe('the endpoints (NFR-SE-17 (d), NFR-IC-20)', () => {
  // The functions the library has at its pinned version, with this
  // configuration. An update that adds one fails here, and a person then
  // decides whether it is served. A name in this list is not an endpoint that
  // answers: only those of IDENTITY_ENDPOINTS do.
  it('are the ones the pinned version is known to have', () => {
    expect(Object.keys(auth().api).sort()).toEqual(
      [
        // The application's own, without a path: the session of FR-AU-90.
        'acceptAdmissionInvitation',
        'accountInfo',
        'callbackOAuth',
        'changeEmail',
        'changePassword',
        'deleteUser',
        'deleteUserCallback',
        'disableTwoFactor',
        'enableTwoFactor',
        'error',
        'generateBackupCodes',
        'getAccessToken',
        'getSession',
        'linkSocialAccount',
        'listSessions',
        'listUserAccounts',
        'ok',
        'refreshToken',
        'requestPasswordReset',
        'requestPasswordResetCallback',
        'resetPassword',
        'revokeOtherSessions',
        'revokeSession',
        'revokeSessions',
        'sendVerificationEmail',
        'setPassword',
        'signInEmail',
        'signInSocial',
        'signOut',
        'signUpEmail',
        'unlinkAccount',
        'updateSession',
        'updateUser',
        'verifyBackupCode',
        'verifyEmail',
        'verifyPassword',
        'verifyTOTP',
      ].sort(),
    );
  });

  it('serves these twelve and no other', () => {
    expect([...IDENTITY_ENDPOINTS]).toEqual([
      'POST /sign-in/email', // FR-AU-81
      'POST /sign-out', // FR-AU-84
      'POST /request-password-reset', // FR-AU-86
      'POST /reset-password', // FR-AU-86
      'POST /change-password', // FR-AU-85
      'POST /revoke-session', // FR-AU-85
      'POST /revoke-other-sessions', // FR-AU-85
      'POST /two-factor/enable', // FR-AU-83
      'POST /two-factor/verify-totp', // FR-AU-83, FR-AU-81
      'POST /two-factor/verify-backup-code', // FR-AU-83
      'POST /two-factor/disable', // FR-AU-83
      'POST /two-factor/generate-backup-codes', // FR-AU-83
    ]);
  });

  // FR-AU-83: each of the five is the application's own, and the plugin's
  // endpoint of the same name is not in the handler nor in `auth().api`.
  it('has the application’s own endpoints of two-factor authentication in place of the plugin’s', async () => {
    const own = await import('../../src/lib/auth/two-factor.ts');
    const api = auth().api as unknown as Record<string, unknown>;
    for (const name of [
      'enableTwoFactor',
      'verifyTOTP',
      'verifyBackupCode',
      'disableTwoFactor',
      'generateBackupCodes',
    ] as const) {
      expect((api[name] as { path: string }).path).toBe(own[name].path);
      // The plugin's takes a schema for its body; the application's reads the body by hand.
      expect((own[name] as { options: { body?: unknown } }).options.body).toBeUndefined();
      expect((api[name] as { options: { body?: unknown } }).options.body).toBeUndefined();
    }
    // And of the plugin's other endpoints none is left, on the server either:
    // its code by email, the secret shown again, a code computed for any
    // secret, and the recovery codes of any account read back.
    for (const name of [
      'sendTwoFactorOTP',
      'verifyTwoFactorOTP',
      'getTOTPURI',
      'generateTOTP',
      'viewBackupCodes',
    ]) {
      expect(api[name], name).toBeUndefined();
    }
    // The schema of the plugin is what is kept: the account the library
    // answers with a session says whether two-factor authentication is on,
    // which the founding-team gate reads (session.ts).
    const { response } = await auth().api.getSession({
      headers: await sessionHeaders('person@example.com'),
      returnHeaders: true,
    });
    expect(response?.user).toMatchObject({ twoFactorEnabled: false, emailVerified: true });
  });

  it('answers 404 on every other endpoint the library has, signed in or not', async () => {
    const signedIn = { cookie: cookiesOf(await signIn(auth, 'person@example.com')) };
    const endpoints = Object.values(auth().api as unknown as Record<string, { path?: string }>)
      .map((endpoint) => endpoint.path)
      .filter((path): path is string => typeof path === 'string');
    // Social sign-in and its callback, magic link (none), email OTP, the
    // delete-user endpoint, public sign-up, account linking, the change of an
    // address, and the rest.
    expect(endpoints.length).toBeGreaterThan(30);

    const answered: string[] = [];
    for (const pattern of endpoints) {
      const path = `/api/auth${pattern.replace(/:[a-z]+/gi, 'x')}`;
      for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
        for (const headers of [{}, signedIn]) {
          const response = await request(method, path, headers);
          if (response.status !== 404) answered.push(`${method} ${pattern}`);
        }
      }
    }
    // Each endpoint that is served answers, signed in or not, with a refusal
    // of this empty request where it is no sign-out.
    expect([...new Set(answered)].sort()).toEqual([...IDENTITY_ENDPOINTS].sort());
  });

  it('answers 404 on the features that are switched off, by name', async () => {
    for (const [method, path] of [
      ['POST', '/sign-in/social'], // social and every other OAuth sign-in
      ['GET', '/callback/github'],
      ['POST', '/callback/github'],
      ['POST', '/sign-in/magic-link'], // magic links
      ['GET', '/magic-link/verify'],
      ['POST', '/passkey/verify-authentication'], // passkeys
      ['POST', '/email-otp/send-verification-otp'], // a code by email
      ['POST', '/sign-in/email-otp'],
      ['POST', '/two-factor/send-otp'], // the two-factor plugin's code by email
      ['POST', '/two-factor/verify-otp'],
      ['POST', '/phone-number/send-otp'], // a code by telephone
      ['POST', '/sign-in/sso'], // enterprise single sign-on
      ['GET', '/scim/v2/Users'], // SCIM
      ['POST', '/organization/create'], // the organisation feature
      ['GET', '/oauth-proxy-callback'], // the OAuth proxy
      ['POST', '/delete-user'], // FR-AU-58
      ['GET', '/delete-user/callback'],
      ['POST', '/sign-up/email'], // FR-AU-57
      ['POST', '/link-social'], // account linking
      ['POST', '/unlink-account'],
      ['POST', '/change-email'], // FR-AU-03 is the application's own, later
      ['GET', '/verify-email'],
      ['POST', '/send-verification-email'],
      ['GET', '/reset-password/x'], // the library's page of a reset link; FR-AU-86 is the application's own
      ['GET', '/list-sessions'], // returns every session's token; the settings page reads the rows (FR-AU-85)
      ['POST', '/revoke-sessions'], // every session, the one in use included; FR-AU-85 has no such action
      ['POST', '/set-password'],
      ['POST', '/verify-password'],
      ['POST', '/update-user'], // FR-AU-03, the name: later
      ['GET', '/get-session'],
      ['GET', '/ok'],
      ['GET', '/error'],
    ] as const) {
      expect((await request(method, `/api/auth${path}`)).status, `${method} ${path}`).toBe(404);
    }
  });

  it('serves an endpoint under its one spelling', async () => {
    for (const path of [
      '/api/auth/sign-in/email/',
      '/api/auth//sign-in/email',
      '/api/auth/Sign-In/Email',
      '/api/auth/sign-in/email%2F',
      '/api/auth/sign-in/x/../email/y',
      '/api/auth/sign-in',
      '/api/auth',
      '/api/auth/',
    ]) {
      expect((await request('POST', path)).status, path).toBe(404);
    }
    expect((await request('GET', '/api/auth/sign-in/email')).status).toBe(404);
    expect((await request('HEAD', '/api/auth/sign-in/email')).status).toBe(404);
    // Dots are resolved by the URL parser before anything reads the path.
    expect((await request('POST', '/api/auth/x/../sign-in/email')).status).not.toBe(404);
  });

  it('refuses, on the server too, what is switched off', async () => {
    const headers = await sessionHeaders('person@example.com');
    // FR-AU-57: public sign-up.
    await expect(
      auth().api.signUpEmail({ body: { email: 'new@example.com', password: PASSWORD, name: 'New' } }),
    ).rejects.toThrow();
    expect(await db().user.count({ where: { email: 'new@example.com' } })).toBe(0);
    // FR-AU-58: the library's own deletion of a user.
    await expect(auth().api.deleteUser({ body: { password: PASSWORD }, headers })).rejects.toThrow();
    expect(await db().user.count({ where: { id: userId } })).toBe(1);
    // The change of an address through the library.
    await expect(
      auth().api.changeEmail({ body: { newEmail: 'other@example.com' }, headers }),
    ).rejects.toThrow();
    expect((await db().user.findUniqueOrThrow({ where: { id: userId } })).email).toBe('person@example.com');
    // Social sign-in and the linking of an account: there is no provider.
    await expect(auth().api.signInSocial({ body: { provider: 'github' } })).rejects.toThrow();
    await expect(auth().api.linkSocialAccount({ body: { provider: 'github' }, headers })).rejects.toThrow();
    // The two-factor plugin's code by email: the endpoint is not there to call.
    expect(auth().api).not.toHaveProperty('sendTwoFactorOTP');
    // The library's own reset of a password is replaced (password.ts): it is
    // given no function to send an email with, and no setting to end sessions by.
    expect(auth().options.emailAndPassword).not.toHaveProperty('sendResetPassword');
    expect(auth().options.emailAndPassword).not.toHaveProperty('revokeSessionsOnPasswordReset');
    expect(await db().verification.count()).toBe(0);
  });
});

describe('the cookies (NFR-SE-17 (c))', () => {
  it('are HttpOnly, Secure, SameSite=Lax, and host-only, every one of them', async () => {
    const cookies = (await signIn(auth, 'person@example.com')).headers.getSetCookie();
    // The session's token, and the signed copy of the session.
    expect(cookies.map((cookie) => cookie.split('=')[0]).sort()).toEqual([
      '__Secure-better-auth.session_data',
      '__Secure-better-auth.session_token',
    ]);
    for (const cookie of cookies) {
      const attributes = cookie.toLowerCase().split('; ').slice(1);
      expect(attributes).toContain('httponly');
      expect(attributes).toContain('secure');
      expect(attributes).toContain('samesite=lax');
      expect(attributes).toContain('path=/');
      expect(attributes.some((attribute) => attribute.startsWith('domain'))).toBe(false);
    }
    // The copy lives as long as the setting says.
    expect(cookies.find((cookie) => cookie.includes('session_data'))).toContain('Max-Age=45');
  });
});

describe('the address of an account (FR-AU-02, FR-AU-81)', () => {
  it('is stored in lower case, and the same address in another case is no second account', async () => {
    const id = await createAccount(auth, 'Mixed.Case@Example.COM');
    expect((await db().user.findUniqueOrThrow({ where: { id } })).email).toBe('mixed.case@example.com');
    await expect(createAccount(auth, 'MIXED.case@example.com')).rejects.toThrow();
    await expect(createAccount(auth, 'mixed.case@example.com')).rejects.toThrow();
    expect(await db().user.count({ where: { email: { contains: 'ixed', mode: 'insensitive' } } })).toBe(1);
    // And it signs in however it is typed.
    expect((await signIn(auth, 'MIXED.CASE@EXAMPLE.COM')).status).toBe(200);
  });

  it('cannot sign in until it is verified', async () => {
    const id = await createAccount(auth, 'unverified@example.com', false);
    const response = await signIn(auth, 'unverified@example.com');
    // Answered as any failed sign-in is (FR-AU-81; sign-in.test.ts).
    expect(response.status).toBe(401);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });
});

describe('what a session row records (FR-AU-84)', () => {
  it("holds the address the application derives, never the client's own claim, and the browser", async () => {
    // One trusted proxy: the last entry is the proxy's, the first is whatever the client sent.
    const response = await signIn(auth, 'person@example.com', PASSWORD, {
      'x-forwarded-for': '203.0.113.99, 198.51.100.7',
      'user-agent': 'A Browser/1.0',
    });
    const session = await auth().api.getSession({ headers: new Headers({ cookie: cookiesOf(response) }) });
    const row = await db().session.findUniqueOrThrow({ where: { id: session!.session.id } });
    expect(row.ipAddress).toBe('198.51.100.7');
    expect(row.userAgent).toBe('A Browser/1.0');
    expect(row.createdAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY * 1000 - 60_000);
    expect(row.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 6 * DAY * 1000);
  });

  it('holds no address where none can be established', async () => {
    const response = await signIn(auth, 'person@example.com', PASSWORD, {
      'x-forwarded-for': 'not-an-address',
    });
    const session = await auth().api.getSession({ headers: new Headers({ cookie: cookiesOf(response) }) });
    expect(
      (await db().session.findUniqueOrThrow({ where: { id: session!.session.id } })).ipAddress,
    ).toBeNull();
  });
});

describe('signing out (FR-AU-84)', () => {
  it('ends the session at once and clears the cookies of the browser', async () => {
    const signedIn = cookiesOf(await signIn(auth, 'person@example.com'));
    const { session } = (await auth().api.getSession({ headers: new Headers({ cookie: signedIn }) }))!;
    const response = await request('POST', '/api/auth/sign-out', { cookie: signedIn });
    expect(response.status).toBe(200);
    expect(await db().session.count({ where: { id: session.id } })).toBe(0);
    const cleared = response.headers.getSetCookie();
    for (const name of ['session_token', 'session_data']) {
      expect(cleared.find((cookie) => cookie.includes(`${name}=;`))).toContain('Max-Age=0');
    }
  });

  // NFR-SE-17 (c): the handler checks the origin itself, since the proxy can
  // be skipped (docs/operations/deployment.md). The library would leave the
  // check off under NODE_ENV=test, which is how this file runs.
  it('is refused from any origin but the own, and the session stands', async () => {
    const signedIn = cookiesOf(await signIn(auth, 'person@example.com'));
    const { session } = (await auth().api.getSession({ headers: new Headers({ cookie: signedIn }) }))!;
    for (const origin of ['https://evil.example', 'null', `${ORIGIN}.evil.example`]) {
      const response = await request('POST', '/api/auth/sign-out', { cookie: signedIn, origin });
      expect(response.status, origin).toBe(403);
      expect(response.headers.getSetCookie(), origin).toEqual([]);
    }
    expect(await db().session.count({ where: { id: session.id } })).toBe(1);
  });
});

describe('what is logged (NFR-SE-19)', () => {
  it('writes nothing to the console at a failed sign-in, for a known address or an unknown one', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const out = vi.spyOn(process.stdout, 'write');
    const err = vi.spyOn(process.stderr, 'write');

    expect((await signIn(auth, 'person@example.com', 'a wrong password, long enough')).status).toBe(401);
    expect((await signIn(auth, 'nobody@example.com', 'a wrong password, long enough')).status).toBe(401);
    expect((await signIn(auth, 'not an address', 'a wrong password, long enough')).status).toBe(401);
    expect((await signIn(auth, 'person@example.com', 'x'.repeat(200))).status).toBe(401);
    expect((await request('POST', '/api/auth/sign-up/email')).status).toBe(404);

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(out).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
  });

  // The library logs an error and continues past it. That it did is printed,
  // and nothing it said: its message and what came with it can hold an address.
  it('prints that the library reported an error, and neither its message nor what came with it', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    const { logger } = await auth().$context;
    const carried = [{ email: 'person@example.com' }, new Error('a query with person@example.com')];
    logger.error('Failed to read the session of person@example.com', ...carried);
    for (const level of ['warn', 'info', 'success', 'debug'] as const) {
      logger[level]('User not found: person@example.com', ...carried);
    }
    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([['identity: library reported (error)']]);
  });

  it('reports a fault of the handler by its class and code, and answers nothing of it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    database.sql('ALTER TABLE "User" RENAME TO "UserAway"');
    let response: Response;
    try {
      response = await signIn(auth, 'person@example.com');
    } finally {
      database.sql('ALTER TABLE "UserAway" RENAME TO "User"');
    }
    expect(response.status).toBe(500);
    expect(await response.text()).not.toMatch(/User|person|prisma/i);
    // Not the only line: the router under the library prints the error itself
    // as well (`# SERVER_ERROR`, better-call 1.4.0), which the configuration
    // does not yet keep it from. That is reported, and not settled here.
    expect(errors.mock.calls[0]).toEqual(['identity: request failed (PrismaClientKnownRequestError P2021)']);
  });

  it('answers a failed sign-in in one way, whether or not the address has an account (FR-AU-81)', async () => {
    const known = await signIn(auth, 'person@example.com', 'a wrong password, long enough');
    const unknown = await signIn(auth, 'nobody@example.com', 'a wrong password, long enough');
    expect(await known.text()).toBe(await unknown.text());
    expect(known.headers.getSetCookie()).toEqual(unknown.headers.getSetCookie());
  });
});
