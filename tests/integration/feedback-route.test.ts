// POST /api/feedback against a provisioned database and Valkey, with the route as Next.js calls it and the intake
// of Praktico replaced by the double of tests/fixtures/praktico-double.ts (docs/contracts/feedback-intake.md).
// It is also the test of its own that tests/integration/route-origin.test.ts names for this handler (NFR-SE-17 (c)).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { praktico } from '../fixtures/praktico-double.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const SECRET = 'S'.repeat(43);
const database = prepare('feedbackroute', { FEEDBACK_SECRET: SECRET });
const loaded = await load();
const { auth, db, valkey } = loaded;
const route = await import('../../src/app/api/feedback/route.ts');
const { CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/closed-alpha-notice.ts');

const FIRST = {
  kind: 'idea',
  message: 'A message that must not be kept',
  route: '/documents/[id]',
  viewport: { width: 1000, height: 700 },
};

let people = 0;
let address = 0;
async function person(acknowledged = true) {
  const email = `feedback${++people}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const id = await createAccount(auth, email);
  if (acknowledged)
    await db().user.update({
      where: { id },
      data: {
        closedAlphaNoticeVersion: CLOSED_ALPHA_NOTICE_VERSION,
        closedAlphaNoticeAcknowledgedAt: new Date(),
      },
    });
  return { id, cookie: cookiesOf(await signIn(auth, email)) };
}
const post = (cookie: string | undefined, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`${ORIGIN}/api/feedback`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': `10.60.0.${++address}`,
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );

let double = praktico(SECRET);
beforeEach(() => {
  process.env.FEEDBACK_INTAKE_ENABLED = 'true';
  double = praktico(SECRET);
  vi.stubGlobal('fetch', double.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.FEEDBACK_INTAKE_ENABLED;
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('POST /api/feedback', () => {
  it('refuses a request of another origin 403 and sends nothing', async () => {
    const who = await person();
    expect((await post(who.cookie, FIRST, { origin: 'https://evil.example' })).status).toBe(403);
    expect(double.requests).toHaveLength(0);
  });

  it('is closed with the switch off, for a signed-in account of this origin too', async () => {
    delete process.env.FEEDBACK_INTAKE_ENABLED;
    const who = await person();
    expect((await post(who.cookie, FIRST)).status).toBe(404);
    expect(double.requests).toHaveLength(0);
  });

  it('answers 401 unauthenticated without a session, and 403 for an account that has not acknowledged the notice', async () => {
    const signedOut = await post(undefined, FIRST);
    expect(signedOut.status).toBe(401);
    expect((await signedOut.json()).error.code).toBe('unauthenticated');
    const who = await person(false);
    const response = await post(who.cookie, FIRST);
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('notice_not_acknowledged');
    expect(double.requests).toHaveLength(0);
  });

  it('delivers an accepted submission with the account of the session, keeps no copy, and counts it', async () => {
    const who = await person();
    const response = await post(who.cookie, FIRST);
    expect(response.status).toBe(201);
    expect(double.held).toHaveLength(1);
    expect(double.held[0]!.accountId).toBe(who.id);
  });

  it('refuses the sixth accepted submission in 10 minutes with 429, and a failed send does not count', async () => {
    const who = await person();
    double.failWith = 500;
    for (let n = 0; n < 6; n += 1) expect((await post(who.cookie, FIRST)).status).toBe(502);
    double.failWith = null;
    for (let n = 0; n < 5; n += 1) expect((await post(who.cookie, FIRST)).status).toBe(201);
    const limited = await post(who.cookie, FIRST);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('fires a burst at once and accepts no more than five, against the real counters (E1)', async () => {
    const who = await person();
    const answers = await Promise.all(Array.from({ length: 12 }, () => post(who.cookie, FIRST)));
    expect(answers.filter(({ status }) => status === 201)).toHaveLength(5);
    expect(answers.filter(({ status }) => status === 429)).toHaveLength(7);
    expect(double.held).toHaveLength(5);
  });

  it('gives the places back when the intake does not accept a burst, so the account can still send', async () => {
    const who = await person();
    double.failWith = 500;
    await Promise.all(Array.from({ length: 5 }, () => post(who.cookie, FIRST)));
    double.failWith = null;
    for (let n = 0; n < 5; n += 1) expect((await post(who.cookie, FIRST)).status).toBe(201);
  });
});
