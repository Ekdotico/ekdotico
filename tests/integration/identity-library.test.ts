// What the identity library, Better Auth at its pinned version, can and cannot
// do. The specification marks six behaviours as "not confirmed" or "verified
// when built"; each is shown here against a provisioned database, connected as
// the runtime role. An update of the library that changes one of them fails here
// (NFR-IC-20).
//
// This file tests the library, with the options that matter to each point. The
// application's own configuration is tested where it is built.
import { PrismaPg } from '@prisma/adapter-pg';
import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { twoFactor } from 'better-auth/plugins';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../../src/generated/prisma/client.ts';
import { createDatabase } from './database.ts';

const DAY = 24 * 60 * 60;
const SECRET = 'a-test-secret-of-at-least-thirty-two-characters';
const PASSWORD = 'correct horse battery staple';

const database = createDatabase('identity');
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: database.appUrl }, { schema: 'ekdotico' }),
});

// Point 1 needs an endpoint of the application's own that signs a user in
// without a password, as the link of a lock email will (FR-AU-81; register A104).
const ownSignIn = {
  id: 'own-sign-in',
  endpoints: {
    ownSignIn: createAuthEndpoint('/own-sign-in', { method: 'POST' }, async (ctx) => {
      const user = await ctx.context.internalAdapter.findUserById(ctx.headers?.get('x-test-user') ?? '');
      if (!user) return ctx.json({ ok: false }, { status: 401 });
      const session = await ctx.context.internalAdapter.createSession(user.id);
      await setSessionCookie(ctx, { session, user });
      return ctx.json({ ok: true });
    }),
  },
};

const auth = betterAuth({
  baseURL: 'https://app.example.test',
  secret: SECRET,
  telemetry: { enabled: false },
  database: prismaAdapter(prisma, { provider: 'postgresql' }),
  emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 15, maxPasswordLength: 128 },
  session: { expiresIn: 7 * DAY, updateAge: DAY, cookieCache: { enabled: true, maxAge: 60 } },
  plugins: [twoFactor(), ownSignIn],
});

const origin = { origin: 'https://app.example.test' };
/** The Cookie header a browser would send back after this response. */
const cookiesOf = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');

let userId = '';

/** Creates an account as the admission of FR-AU-90 will: no public sign-up. */
async function createAccount(email: string) {
  const context = await auth.$context;
  const user = await context.internalAdapter.createUser(
    { email, name: 'A Person', emailVerified: true },
    { method: 'email-password' },
  );
  await context.internalAdapter.linkAccount({
    userId: user.id,
    providerId: 'credential',
    accountId: user.id,
    password: await context.password.hash(PASSWORD),
  });
  return user.id;
}
const signIn = (email: string) =>
  auth.api.signInEmail({ body: { email, password: PASSWORD }, headers: origin, asResponse: true });

beforeAll(async () => {
  userId = await createAccount('person@example.com');
});
afterAll(async () => {
  await prisma.$disconnect();
  database.drop();
});

describe('5. accounts without public sign-up (FR-AU-05, FR-AU-57, FR-AU-90, FR-AU-58)', () => {
  it('refuses the public sign-up endpoint', async () => {
    await expect(
      auth.api.signUpEmail({ body: { email: 'new@example.com', password: PASSWORD, name: 'New' } }),
    ).rejects.toThrow();
    expect(await prisma.user.count({ where: { email: 'new@example.com' } })).toBe(0);
  });

  it('lets the application create an account, which can then sign in', async () => {
    const response = await signIn('person@example.com');
    expect(response.status).toBe(200);
  });

  it('stores the password only as a salted scrypt hash (NFR-SE-17 (a))', async () => {
    const account = await prisma.account.findFirstOrThrow({ where: { userId } });
    expect(account.providerId).toBe('credential');
    expect(account.password).toMatch(/^[0-9a-f]{32}:[0-9a-f]{128}$/);
    expect(account.password).not.toContain(PASSWORD);
  });

  it('holds a user row with no name and no address, the tombstone of a deleted account', async () => {
    const gone = await createAccount('gone@example.com');
    await prisma.account.deleteMany({ where: { userId: gone } });
    await prisma.user.update({ where: { id: gone }, data: { email: null, name: null } });
    expect((await prisma.user.findUniqueOrThrow({ where: { id: gone } })).email).toBeNull();
    // The address is free again, and the tombstone cannot sign in.
    const response = await signIn('gone@example.com');
    expect(response.status).toBe(401);
  });
});

describe('6. the session cookie (NFR-SE-17 (c), FR-AU-08)', () => {
  it('is HttpOnly, Secure, SameSite=Lax, and host-only', async () => {
    const response = await signIn('person@example.com');
    const cookie = response.headers.getSetCookie().find((value) => value.includes('session_token'));
    expect(cookie).toBeDefined();
    const attributes = cookie!.toLowerCase();
    expect(attributes).toContain('httponly');
    expect(attributes).toContain('secure');
    expect(attributes).toContain('samesite=lax');
    expect(attributes).toContain('path=/');
    expect(attributes).not.toContain('domain=');
  });

  it('is enough for another process to find the session row', async () => {
    // The collaboration server is given the Cookie header on the same origin and
    // asks the library for the session, reading the row.
    const cookie = cookiesOf(await signIn('person@example.com'));
    const session = await auth.api.getSession({
      headers: new Headers({ cookie }),
      query: { disableCookieCache: true },
    });
    expect(session?.user.id).toBe(userId);
    expect(await prisma.session.count({ where: { id: session!.session.id } })).toBe(1);
  });
});

describe('3. a validation that passes over the cookie cache (NFR-SE-02; register D116)', () => {
  it('honours an ended session from the cache, and refuses it when the row is read', async () => {
    const cookie = cookiesOf(await signIn('person@example.com'));
    const headers = new Headers({ cookie });
    const before = await auth.api.getSession({ headers });
    expect(before?.user.id).toBe(userId);

    await prisma.session.delete({ where: { id: before!.session.id } });

    // A request that only reads may still be answered from the signed copy.
    expect((await auth.api.getSession({ headers }))?.user.id).toBe(userId);
    // A request that changes state reads the row, and the session is gone.
    expect(await auth.api.getSession({ headers, query: { disableCookieCache: true } })).toBeNull();
  });
});

describe('1. a session created outside the sign-in endpoints (FR-AU-81; register A104)', () => {
  it('has no magic-link endpoint', () => {
    expect(Object.keys(auth.api)).not.toContain('signInMagicLink');
  });

  it('lets an endpoint of the application create a session and set its cookie', async () => {
    const response = await auth.handler(
      new Request('https://app.example.test/api/auth/own-sign-in', {
        method: 'POST',
        headers: { ...origin, 'x-test-user': userId },
      }),
    );
    expect(response.status).toBe(200);
    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookiesOf(response) }),
      query: { disableCookieCache: true },
    });
    expect(session?.user.id).toBe(userId);
  });
});

describe('4. the two periods of a session (FR-AU-84)', () => {
  it('renews the expiry and keeps the time the session began, for a check of 30 days', async () => {
    const cookie = cookiesOf(await signIn('person@example.com'));
    const headers = new Headers({ cookie });
    const first = (await auth.api.getSession({ headers, query: { disableCookieCache: true } }))!.session;

    // Two days on: more than the 24 hours after which the library renews.
    const began = new Date(Date.now() - 2 * DAY * 1000);
    await prisma.session.update({
      where: { id: first.id },
      data: { createdAt: began, updatedAt: began, expiresAt: new Date(began.getTime() + 7 * DAY * 1000) },
    });
    await auth.api.getSession({ headers, query: { disableCookieCache: true } });

    const renewed = await prisma.session.findUniqueOrThrow({ where: { id: first.id } });
    expect(renewed.expiresAt.getTime()).toBeGreaterThan(Date.now() + 6 * DAY * 1000);
    // The library has no absolute lifetime; it keeps `createdAt`, from which the
    // application makes that check itself.
    expect(renewed.createdAt.getTime()).toBe(began.getTime());
  });
});

describe('2. the second factor at rest (NFR-SE-17 (a))', () => {
  it('stores neither the secret nor a recovery code in the clear', async () => {
    const cookie = cookiesOf(await signIn('person@example.com'));
    const enabled = await auth.api.enableTwoFactor({
      body: { password: PASSWORD },
      headers: new Headers({ cookie, ...origin }),
    });
    // The plugin can also answer with a code sent by email. That method is not
    // configured, and NFR-SE-17 (d) keeps it off.
    if (enabled.method !== 'totp') throw new Error('expected the authenticator method');
    const secret = new URL(enabled.totpURI).searchParams.get('secret')!;
    expect(secret.length).toBeGreaterThan(15);
    expect(enabled.backupCodes.length).toBe(10);

    const row = await prisma.twoFactor.findFirstOrThrow({ where: { userId } });
    expect(row.secret).not.toContain(secret);
    for (const code of enabled.backupCodes) expect(row.backupCodes).not.toContain(code);
    // Read as the administrator too, in case the client hid something.
    const stored = database.sql(`SELECT secret || ' ' || "backupCodes" FROM "TwoFactor"`);
    expect(stored).not.toContain(secret);
    expect(stored).not.toContain(enabled.backupCodes[0]);
  });
});
