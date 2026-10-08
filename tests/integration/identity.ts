// What the integration tests of the identity configuration, of session
// validation and of the proxy share: a provisioned database, the environment
// the application reads, and an account made the way an admission will make
// one. The modules under test are imported after `prepare` has set the
// environment, since they read their settings once.
import { randomBytes } from 'node:crypto';
import { createDatabase } from './database.ts';

export const ORIGIN = 'https://app.example.test';
export const PASSWORD = 'correct horse battery staple';
export const DAY = 24 * 60 * 60;

export function prepare(label: string, env: Record<string, string> = {}) {
  const database = createDatabase(label);
  Object.assign(process.env, {
    FOUNDING_TEAM_EMAILS: '',
    APP_ORIGIN: ORIGIN,
    EMAIL_TRANSPORT: 'sink',
    DATABASE_URL: database.appUrl,
    // The limiter keys its counters by this secret, so a secret of its own
    // gives each run counters of its own in the shared Valkey.
    AUTH_SECRET: `test-${randomBytes(24).toString('hex')}`,
    ...env,
  });
  return database;
}

export async function load() {
  const [{ auth, IDENTITY_ENDPOINTS, IDENTITY_BASE_PATH }, session, { db }, { valkey }, { settings }] =
    await Promise.all([
      import('../../src/lib/auth/auth.ts'),
      import('../../src/lib/auth/session.ts'),
      import('../../src/lib/db.ts'),
      import('../../src/lib/valkey.ts'),
      import('../../src/lib/settings.ts'),
    ]);
  return { auth, IDENTITY_ENDPOINTS, IDENTITY_BASE_PATH, ...session, db, valkey, settings };
}

type Auth = Awaited<ReturnType<typeof load>>['auth'];

/** Creates an account as the admission of FR-AU-90 will: there is no public sign-up. */
export async function createAccount(auth: Auth, email: string, emailVerified = true) {
  const context = await auth().$context;
  const user = await context.internalAdapter.createUser(
    { email, name: 'A Person', emailVerified },
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

/** A sign-in through the handler, as a browser on the application's own origin makes it. */
export function signIn(auth: Auth, email: string, password = PASSWORD, headers: Record<string, string> = {}) {
  return auth().handler(
    new Request(`${ORIGIN}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify({ email, password }),
    }),
  );
}

/**
 * A POST through the handler as the route makes it (src/app/api/auth/[...all]):
 * the response, and `after`, which runs what the endpoint left for after its
 * response. Until `after` is called none of that has started.
 */
export async function post(auth: Auth, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const { collecting } = await import('../../src/lib/after-response.ts');
  const { result, tasks } = await collecting(() =>
    auth().handler(
      new Request(`${ORIGIN}/api/auth${path}`, {
        method: 'POST',
        headers: {
          origin: ORIGIN,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      }),
    ),
  );
  return {
    response: result,
    left: tasks.length,
    after: async () => {
      for (const task of tasks.splice(0)) await task();
    },
  };
}

/** The messages the local sink holds, oldest first, each as its headers and its text. */
export async function sunk(directory: string) {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .sort()
    .map((name) => {
      const file = readFileSync(`${directory}/${name}`, 'utf8');
      const [head, ...text] = file.split('\n\n');
      const header = (label: string) => new RegExp(`^${label}: (.*)$`, 'm').exec(head!)?.[1];
      return { to: header('To'), subject: header('Subject'), text: text.join('\n\n') };
    });
}

/** The Cookie header a browser would send back after this response. */
export const cookiesOf = (response: { headers: Headers }) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(';')[0])
    .join('; ');
