// The founding-team gate (FR-AU-83, FR-AU-90; NFR-SE-17 (d); register D114;
// A102, assumed; the owner's answer to Q8): an account whose verified address
// is on the list of the process and that has not turned two-factor
// authentication on "cannot use the application". Shown where a request can
// arrive: at the proxy as Next.js calls it; at each route and at each endpoint
// of the identity library with no proxy in front, since the proxy can be
// skipped (docs/operations/deployment.md); and at the pages, as the layout and
// each page ask. The gate's one function is tested in
// tests/unit/founding-gate.test.ts.
import { globSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, post, prepare, signIn, sunk } from './identity.ts';
import { enrol, nextCode, passwordStep, secondStep, unbase32, withCookies } from './second-factor.ts';

// `headers` of Next.js exists only inside a request of the framework. Here it
// answers with what the test says the browser sent.
const browser = vi.hoisted(() => ({ headers: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => browser.headers }));

const sink = mkdtempSync(join(tmpdir(), 'ekdotico-gate-mail-'));
const database = prepare('gate', {
  // Written as a person would write them: capitals, and spaces round the commas.
  FOUNDING_TEAM_EMAILS: Array.from({ length: 40 }, (_, n) => `Founder${n}@Example.COM`).join(' , '),
  TRUSTED_PROXY_COUNT: '1',
  EMAIL_SINK_DIRECTORY: sink,
});
const { auth, db, valkey, validateSession, validateSessionRow } = await load();
const { proxy } = await import('../../src/proxy.ts');
const { currentAccount, titled } = await import('../../src/app/(app)/account.ts');
const { default: AppLayout } = await import('../../src/app/(app)/layout.tsx');
const { EnrolmentGate } = await import('../../src/app/(app)/enrolment-gate.tsx');
const { ClosedAlphaNotice } = await import('../../src/app/(app)/closed-alpha-notice.tsx');

// Written out here and not imported.
const STOPPED = {
  error: {
    code: 'two_factor_required',
    message:
      'This account belongs to the Ekdotico team. It cannot be used until two-factor authentication is turned on. Open Ekdotico in the browser and turn it on.',
  },
};
const CANNOT_TURN_OFF = {
  error: {
    code: 'forbidden',
    message:
      'This account belongs to the Ekdotico team, so two-factor authentication cannot be turned off for it.',
  },
};

let addresses = 0;
const fresh = () => ({ 'x-forwarded-for': `10.8.${Math.floor(++addresses / 250)}.${addresses % 250}` });
let founders = 0;
let people = 0;
/** A signed-in account of the founding team, without two-factor authentication. Stored in lower case (FR-AU-02). */
async function founder() {
  const email = `founder${founders++}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email, PASSWORD, fresh())) };
}
/** A signed-in account whose address is not on the list. */
async function person() {
  const email = `person${++people}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email, PASSWORD, fresh())) };
}
const call = (method: string, path: string, headers: Record<string, string> = {}) =>
  proxy(new NextRequest(`${ORIGIN}${path}`, { method, headers: { origin: ORIGIN, ...headers } }));
/** Next.js continues to the route or the page only on this header of the proxy's response. */
const passed = (response: Response) => response.headers.get('x-middleware-next') === '1';
const forbidden = async () =>
  (await db().securityLogEntry.findMany({ where: { kind: 'forbidden' } })).map((entry) => entry.userId);
const isOn = async (id: string) => (await db().user.findUniqueOrThrow({ where: { id } })).twoFactorEnabled;

afterEach(async () => {
  vi.restoreAllMocks();
  browser.headers = new Headers();
  await db().securityLogEntry.deleteMany();
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('whom the gate stops (FR-AU-83)', () => {
  it('stops an account whose address is on the list, compared without regard to case, by the row and by the signed copy', async () => {
    const { id, cookie } = await founder();
    const headers = new Headers({ cookie });
    for (const validation of [
      await validateSessionRow(headers),
      await validateSession('POST', headers),
      // A request that only reads: the signed copy of the session carries the account.
      await validateSession('GET', headers),
    ]) {
      // No session for a caller that reads `session` alone, which is every caller but three.
      expect(validation.session).toBeNull();
      expect(validation.stopped?.userId).toBe(id);
    }
    // The copy was what answered the read: with the row gone it still does.
    await db().session.deleteMany({ where: { userId: id } });
    expect((await validateSession('GET', headers)).stopped?.userId).toBe(id);
    expect(await validateSessionRow(headers)).toMatchObject({ session: null, stopped: null });
  });

  it('leaves an account that is not on the list as it was', async () => {
    const { id, cookie } = await person();
    for (const validation of [
      await validateSessionRow(new Headers({ cookie })),
      await validateSession('GET', new Headers({ cookie })),
    ]) {
      expect(validation.session?.userId).toBe(id);
      expect(validation.stopped).toBeNull();
    }
    expect(passed(await call('GET', '/api/account/onboarding', { cookie }))).toBe(true);
    browser.headers = new Headers({ cookie });
    expect(await currentAccount()).toMatchObject({ userId: id, enrolmentDue: false, noticeDue: true });
  });

  it('takes the list from the process and the account from its row: nothing a request says moves either', async () => {
    const { id, cookie } = await founder();
    const claims = {
      cookie: `${cookie}; twoFactorEnabled=true; __Secure-better-auth.two_factor=x; FOUNDING_TEAM_EMAILS=`,
      'x-two-factor-enabled': 'true',
      'x-founding-team-emails': '',
      'x-user-email': 'person@example.com',
    };
    const response = await call(
      'GET',
      '/api/account/onboarding?twoFactorEnabled=true&foundingTeam=false',
      claims,
    );
    expect(response.status).toBe(403);
    expect((await validateSessionRow(new Headers(claims))).stopped?.userId).toBe(id);
  });

  it('still stops an account that began the enrolment and has not confirmed it', async () => {
    const { id, cookie } = await founder();
    expect((await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie })).response.status).toBe(
      200,
    );
    expect(await db().twoFactor.count({ where: { userId: id } })).toBe(1);
    expect((await validateSessionRow(new Headers({ cookie }))).stopped?.userId).toBe(id);
    expect((await call('GET', '/api/account/onboarding', { cookie })).status).toBe(403);
  });
});

describe('the gate at the proxy (FR-AU-83; the owner’s answer to Q8)', () => {
  it('answers 403 to every API route and to everything that changes state, with its entry in the security log', async () => {
    const { id, cookie } = await founder();
    const refusals = [
      ['GET', '/api/account/onboarding'],
      ['HEAD', '/api/account/onboarding'],
      ['POST', '/api/account/onboarding/acknowledgement'],
      ['GET', '/api/documents'],
      ['POST', '/api/documents'],
      ['DELETE', '/api/account'],
      ['GET', '/api'],
      ['GET', '/api/auth/list-sessions'],
      ['POST', '/api/auth/change-password'],
      ['POST', '/api/auth/update-user'],
      ['POST', '/api/auth/change-email'],
      ['POST', '/api/auth/revoke-session'],
      ['POST', '/api/auth/revoke-other-sessions'],
      ['POST', '/api/auth/two-factor/disable'],
      ['POST', '/api/auth/two-factor/generate-backup-codes'],
      ['POST', '/api/auth/two-factor/get-totp-uri'],
      // The two that pass, under another method or another spelling.
      ['GET', '/api/auth/two-factor/enable'],
      ['PUT', '/api/auth/two-factor/enable'],
      ['POST', '/api/auth/two-factor/enable/'],
      ['POST', '/api/auth/two-factor/Enable'],
      ['GET', '/api/auth/sign-out'],
      // Not an API route, and it changes state.
      ['POST', '/'],
      ['POST', '/settings'],
      ['DELETE', '/documents/1'],
    ] as const;
    for (const [method, path] of refusals) {
      const response = await call(method, path, { cookie });
      expect(response.status, `${method} ${path}`).toBe(403);
      expect(passed(response)).toBe(false);
      expect(response.headers.get('cache-control')).toBe('no-store');
      if (method !== 'HEAD') expect(await response.json()).toEqual(STOPPED);
    }
    // NFR-SE-19: a 403 has its entry, with the user.
    expect(await forbidden()).toEqual(Array(refusals.length).fill(id));
  });

  it('lets the enrolment itself and the sign-out through, and a page that is read', async () => {
    const { cookie } = await founder();
    for (const [method, path] of [
      ['POST', '/api/auth/two-factor/enable'],
      ['POST', '/api/auth/two-factor/verify-totp'],
      ['POST', '/api/auth/sign-out'],
      // A page: the signed-in layout shows the enrolment in place of it.
      ['GET', '/'],
      ['GET', '/settings'],
      ['GET', '/documents/1'],
      ['HEAD', '/'],
    ] as const) {
      const response = await call(method, path, { cookie, ...fresh() });
      expect(passed(response), `${method} ${path}`).toBe(true);
    }
    expect(await forbidden()).toEqual([]);
  });

  it('checks the origin first, and refuses a request from another origin in the words of that check', async () => {
    const { cookie } = await founder();
    const response = await call('POST', '/api/auth/two-factor/enable', {
      cookie,
      origin: 'https://evil.example',
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden');
  });
});

describe('the gate with the proxy skipped: the endpoints of the identity library (NFR-SE-02, FR-AU-83)', () => {
  it('refuses every endpoint under a session but the enrolment, and changes nothing', async () => {
    const { id, cookie } = await founder();
    const other = cookiesOf(await signIn(auth, `founder${founders - 1}@example.com`, PASSWORD, fresh()));
    const hash = (await db().account.findFirstOrThrow({ where: { userId: id } })).password;

    const sessions = await db().session.findMany({ where: { userId: id } });
    for (const [path, body] of [
      ['/change-password', { currentPassword: PASSWORD, newPassword: 'another password, long' }],
      ['/revoke-session', { id: sessions[1]!.id }],
      ['/revoke-other-sessions', undefined],
      ['/two-factor/disable', { password: PASSWORD, code: '123456' }],
      ['/two-factor/generate-backup-codes', { password: PASSWORD }],
      // FR-AU-90, FR-AU-03: the name and the address.
      ['/update-user', { name: 'Another Name' }],
      ['/change-email', { newEmail: 'elsewhere@example.com', password: PASSWORD }],
    ] as const) {
      const refused = await post(auth, path, body, { cookie, ...fresh() });
      expect(refused.response.status, path).toBe(403);
      expect(await refused.response.json()).toEqual(STOPPED);
      expect(refused.left).toBe(0);
    }
    expect((await db().account.findFirstOrThrow({ where: { userId: id } })).password).toBe(hash);
    expect(await db().user.findUniqueOrThrow({ where: { id } })).toMatchObject({ name: 'A Person' });
    expect(await db().verification.count({ where: { identifier: { startsWith: 'confirm-address:' } } })).toBe(
      0,
    );
    expect(await db().session.count({ where: { userId: id } })).toBe(2);
    expect((await validateSessionRow(new Headers({ cookie: other }))).stopped?.userId).toBe(id);
    expect(await forbidden()).toEqual(Array(7).fill(id));
  });

  it('lets the account sign out', async () => {
    const { id, cookie } = await founder();
    expect((await post(auth, '/sign-out', undefined, { cookie })).response.status).toBe(200);
    expect(await db().session.count({ where: { userId: id } })).toBe(0);
  });

  it('lets the account enrol, and then everything opens, at once for the browser that enrolled', async () => {
    const { id, email, cookie } = await founder();
    const stale = cookie;
    const enrolled = await enrol(auth, cookie, fresh());
    expect(await isOn(id)).toBe(true);
    // FR-AU-87 (f): the notice of the enrolment.
    expect((await sunk(sink)).filter((message) => message.to === email)).toHaveLength(1);

    // By the row, and by the fresh signed copy the enrolment answered with.
    for (const validation of [
      await validateSessionRow(new Headers({ cookie: enrolled.cookie })),
      await validateSession('GET', new Headers({ cookie: enrolled.cookie })),
    ]) {
      expect(validation.session?.userId).toBe(id);
      expect(validation.stopped).toBeNull();
    }
    for (const [method, path] of [
      ['GET', '/api/account/onboarding'],
      ['POST', '/api/account/onboarding/acknowledgement'],
      ['POST', '/api/auth/change-password'],
    ] as const) {
      expect(passed(await call(method, path, { cookie: enrolled.cookie })), path).toBe(true);
    }
    // FR-AU-90: "with the notice after it".
    browser.headers = new Headers({ cookie: enrolled.cookie });
    expect(await currentAccount()).toMatchObject({ userId: id, enrolmentDue: false, noticeDue: true });

    // What it costs (NFR-SE-17 (c)): another browser of the account still
    // holds the copy from before, and its reads are stopped for as long as
    // that copy lives, a minute at most. A request that reads the row is not.
    expect((await validateSession('GET', new Headers({ cookie: stale }))).stopped?.userId).toBe(id);
    expect((await validateSessionRow(new Headers({ cookie: stale }))).session?.userId).toBe(id);
  });

  it('never lets the account turn two-factor authentication off, with the password and a right code', async () => {
    const { id, email, cookie } = await founder();
    const enrolled = await enrol(auth, cookie, fresh());
    const row = await db().twoFactor.findUniqueOrThrow({ where: { userId: id } });

    for (const code of [nextCode(enrolled.secret), enrolled.recoveryCodes[0]!]) {
      const refused = await post(
        auth,
        '/two-factor/disable',
        { password: PASSWORD, code },
        { cookie: enrolled.cookie, ...fresh() },
      );
      expect(refused.response.status).toBe(403);
      expect(await refused.response.json()).toEqual(CANNOT_TURN_OFF);
      expect(refused.left).toBe(0);
    }
    // Refused before anything of the request is read: a body of any shape, and a wrong password uncounted.
    const net = fresh();
    for (let n = 0; n < 6; n++) {
      const refused = await post(
        auth,
        '/two-factor/disable',
        { password: 'wrong', anything: 1 },
        {
          cookie: enrolled.cookie,
          ...net,
        },
      );
      expect(await refused.response.json()).toEqual(CANNOT_TURN_OFF);
    }
    expect((await signIn(auth, email, PASSWORD, net)).status).toBe(200);

    expect(await isOn(id)).toBe(true);
    expect(await db().twoFactor.findUniqueOrThrow({ where: { userId: id } })).toEqual(row);
    expect(
      (await sunk(sink)).filter((message) => message.to === email && /turned off/.test(message.subject!)),
    ).toEqual([]);
    // NFR-SE-19: each 403 is logged, with the user.
    expect(await forbidden()).toEqual(Array(8).fill(id));
    // The recovery codes can be replaced: that is no way out of the requirement.
    const replaced = await post(
      auth,
      '/two-factor/generate-backup-codes',
      { password: PASSWORD },
      {
        cookie: enrolled.cookie,
        ...fresh(),
      },
    );
    expect(replaced.response.status).toBe(200);
  });

  it('asks an account of the team for its code at each sign-in, and the session that follows is not stopped', async () => {
    const { id, email, cookie } = await founder();
    const { secret } = await enrol(auth, cookie, fresh());
    const step = await passwordStep(auth, email, fresh());
    // Between the password and the code there is no session, stopped or not.
    expect(await validateSessionRow(new Headers({ cookie: step }))).toMatchObject({
      session: null,
      stopped: null,
    });
    const done = await secondStep(auth, step, nextCode(secret));
    expect(done.status).toBe(200);
    const signedIn = withCookies(step, done);
    for (const validation of [
      await validateSessionRow(new Headers({ cookie: signedIn })),
      await validateSession('GET', new Headers({ cookie: signedIn })),
    ]) {
      expect(validation.session?.userId).toBe(id);
    }
  });

  it('refuses the first code of an enrolment that another request replaced, and stays shut', async () => {
    const { id, cookie } = await founder();
    const first = unbase32(
      (
        (await (
          await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie })
        ).response.json()) as {
          secret: string;
        }
      ).secret,
    );
    await post(auth, '/two-factor/enable', { password: PASSWORD }, { cookie });
    const refused = await post(auth, '/two-factor/verify-totp', { code: nextCode(first) }, { cookie });
    expect(refused.response.status).toBe(422);
    expect(await isOn(id)).toBe(false);
    expect((await validateSessionRow(new Headers({ cookie }))).stopped?.userId).toBe(id);
  });
});

describe('the gate at the pages, with the proxy skipped (FR-AU-83, FR-AU-90)', () => {
  const pages = globSync('src/app/(app)/**/page.tsx');

  it('shows the screen that turns two-factor authentication on in place of every page, before the notice', async () => {
    const { id, email, cookie } = await founder();
    browser.headers = new Headers({ cookie });
    // The notice is due too, and is not what is shown.
    expect((await db().user.findUniqueOrThrow({ where: { id } })).closedAlphaNoticeVersion).toBeNull();
    expect(await currentAccount()).toMatchObject({ userId: id, enrolmentDue: true, noticeDue: true });

    const shown = await AppLayout({ children: 'THE CONTENT OF A PAGE' });
    expect(shown.type).toBe(EnrolmentGate);
    expect(shown.props).toEqual({ title: 'Two-factor authentication', email });
    expect(JSON.stringify(shown.props)).not.toContain('THE CONTENT OF A PAGE');
    expect(await titled('Account settings')).toEqual({ title: 'Two-factor authentication' });

    // Each page renders nothing itself: Next.js sends a page beside its layout.
    expect(pages.length).toBeGreaterThan(2);
    for (const page of pages) {
      const { default: Page } = (await import(/* @vite-ignore */ `../../${page}`)) as {
        default: (props: { params: Promise<Record<string, string[]>> }) => Promise<unknown>;
      };
      expect(await Page({ params: Promise.resolve({ rest: ['anything'] }) }), page).toBeNull();
    }
  });

  it('writes nothing for an account that it stops: the workspace is made once the gate has opened', async () => {
    const { id, cookie } = await founder();
    await db().workspace.deleteMany({ where: { ownerId: id } });
    browser.headers = new Headers({ cookie });
    expect(await currentAccount()).toMatchObject({ enrolmentDue: true });
    await AppLayout({ children: null });
    expect(await db().workspace.count({ where: { ownerId: id } })).toBe(0);
    // FR-AU-09: the backstop, at the first request of the account that is let through.
    browser.headers = new Headers({ cookie: (await enrol(auth, cookie, fresh())).cookie });
    expect(await currentAccount()).toMatchObject({ enrolmentDue: false });
    expect(await db().workspace.count({ where: { ownerId: id } })).toBe(1);
  });

  it('shows the notice once it is on, and the page once the notice is acknowledged', async () => {
    const { id, cookie } = await founder();
    const enrolled = await enrol(auth, cookie, fresh());
    browser.headers = new Headers({ cookie: enrolled.cookie });
    expect((await AppLayout({ children: 'THE CONTENT OF A PAGE' })).type).toBe(ClosedAlphaNotice);
    await db().user.update({
      where: { id },
      data: { closedAlphaNoticeVersion: 1, closedAlphaNoticeAcknowledgedAt: new Date() },
    });
    // `cache` of React holds an answer only inside a request of the framework.
    const page = await AppLayout({ children: 'THE CONTENT OF A PAGE' });
    expect(page.type).not.toBe(EnrolmentGate);
    expect(page.type).not.toBe(ClosedAlphaNotice);
  });

  it('shows an account that is not on the list the notice, and never the enrolment', async () => {
    const { cookie } = await person();
    browser.headers = new Headers({ cookie });
    expect((await AppLayout({ children: null })).type).toBe(ClosedAlphaNotice);
  });

  it('sends a browser of the team that opens the sign-in page on to the application, where the enrolment is', async () => {
    const { default: SignIn } = await import('../../src/app/(auth)/sign-in/page.tsx');
    const { cookie } = await founder();
    browser.headers = new Headers({ cookie });
    const thrown = await SignIn({ searchParams: Promise.resolve({}) }).then(
      () => undefined,
      (error: unknown) => error as Error & { digest?: string },
    );
    expect(thrown?.digest).toMatch(/^NEXT_REDIRECT;[^;]*;\/;/);
  });
});
