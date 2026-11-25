// The feedback notice on the server (FR-AU-95; register D505, D506): whether it is due, the record of an acknowledgement,
// its version following the Discord switch, and the refusal of `POST /api/feedback` for an account that has not
// acknowledged the current version. The routes are called as Next.js calls them, against a provisioned database.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { praktico } from '../fixtures/praktico-double.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const SECRET = 'N'.repeat(43);
const database = prepare('feedbacknotice', { FEEDBACK_SECRET: SECRET });
const { auth, db, valkey } = await load();
const read = await import('../../src/app/api/account/feedback-notice/route.ts');
const write = await import('../../src/app/api/account/feedback-notice/acknowledgement/route.ts');
const feedback = await import('../../src/app/api/feedback/route.ts');
const { feedbackNoticeDue } = await import('../../src/lib/feedback/notice.ts');

let people = 0;
async function person() {
  const email = `notice${++people}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const id = await createAccount(auth, email);
  // The Closed α notice is acknowledged, so that only the feedback notice is in question.
  const { CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/closed-alpha-notice.ts');
  await db().user.update({
    where: { id },
    data: {
      closedAlphaNoticeVersion: CLOSED_ALPHA_NOTICE_VERSION,
      closedAlphaNoticeAcknowledgedAt: new Date(),
    },
  });
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
const GET = (cookie?: string) =>
  read.GET(new Request(`${ORIGIN}/api/account/feedback-notice`, { headers: cookie ? { cookie } : {} }));
const POST = (cookie: string | undefined, body: unknown, origin = ORIGIN) =>
  write.POST(
    new Request(`${ORIGIN}/api/account/feedback-notice/acknowledgement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    }),
  );
const recorded = (id: string) =>
  db().user.findUniqueOrThrow({
    where: { id },
    select: { feedbackNoticeVersion: true, feedbackNoticeAcknowledgedAt: true },
  });

beforeEach(() => {
  process.env.FEEDBACK_INTAKE_ENABLED = 'true';
  delete process.env.FEEDBACK_DISCORD_ENABLED;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.FEEDBACK_INTAKE_ENABLED;
  delete process.env.FEEDBACK_DISCORD_ENABLED;
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the feedback notice', () => {
  it('is due for an account that has acknowledged nothing, at version 1 while posting to Discord is off', async () => {
    const { id, cookie } = await person();
    expect(await feedbackNoticeDue(id)).toBe(true);
    const response = await GET(cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      currentVersion: 1,
      acknowledgedVersion: null,
      acknowledgedAt: null,
      discordPosting: false,
    });
  });

  it('records the acknowledgement with the server time, once, and is then not due, on any session', async () => {
    const { id, email, cookie } = await person();
    expect((await POST(cookie, { version: 1 })).status).toBe(200);
    const first = await recorded(id);
    expect(first.feedbackNoticeVersion).toBe(1);
    expect(first.feedbackNoticeAcknowledgedAt).toBeInstanceOf(Date);
    expect((await POST(cookie, { version: 1 })).status).toBe(200);
    expect((await recorded(id)).feedbackNoticeAcknowledgedAt).toEqual(first.feedbackNoticeAcknowledgedAt);
    expect(await feedbackNoticeDue(id)).toBe(false);
    const other = cookiesOf(await signIn(auth, email));
    expect((await (await GET(other)).json()).acknowledgedVersion).toBe(1);
  });

  it('is due again at version 2 once posting to Discord is on, and a version other than the current is refused 409', async () => {
    const { id, cookie } = await person();
    await POST(cookie, { version: 1 });
    process.env.FEEDBACK_DISCORD_ENABLED = 'true';
    expect(await feedbackNoticeDue(id)).toBe(true);
    expect((await (await GET(cookie)).json()).discordPosting).toBe(true);
    const stale = await POST(cookie, { version: 1 });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.code).toBe('notice_version_not_current');
    expect((await recorded(id)).feedbackNoticeVersion).toBe(1);
    expect((await POST(cookie, { version: 2 })).status).toBe(200);
    expect(await feedbackNoticeDue(id)).toBe(false);
  });

  it('shows the notice three times as posting goes off, on and off again, and again for a number raised by hand (D508)', async () => {
    const { id, cookie } = await person();
    expect(await feedbackNoticeDue(id)).toBe(true);
    expect((await POST(cookie, { version: 1 })).status).toBe(200);
    expect(await feedbackNoticeDue(id)).toBe(false);
    process.env.FEEDBACK_DISCORD_ENABLED = 'true';
    expect(await feedbackNoticeDue(id)).toBe(true);
    expect((await POST(cookie, { version: 2 })).status).toBe(200);
    expect(await feedbackNoticeDue(id)).toBe(false);
    // Off again: the recorded 2 differs from the current 1, so the off-text is shown once more.
    process.env.FEEDBACK_DISCORD_ENABLED = 'false';
    expect(await feedbackNoticeDue(id)).toBe(true);
    expect((await POST(cookie, { version: 2 })).status).toBe(409);
    expect((await POST(cookie, { version: 1 })).status).toBe(200);
    expect((await recorded(id)).feedbackNoticeVersion).toBe(1);
    expect(await feedbackNoticeDue(id)).toBe(false);
    // A recorded number that is not the current one, as after the wording of a text is changed by hand and its number raised.
    await db().user.update({ where: { id }, data: { feedbackNoticeVersion: 3 } });
    expect(await feedbackNoticeDue(id)).toBe(true);
  });

  it('refuses a request of another origin 403 and records nothing', async () => {
    const { id, cookie } = await person();
    expect((await POST(cookie, { version: 1 }, 'https://evil.example')).status).toBe(403);
    expect((await recorded(id)).feedbackNoticeVersion).toBeNull();
  });

  it('answers 401 without a session, 422 for a body that is not exactly the version, and 404 with the switch off', async () => {
    const { id, cookie } = await person();
    expect((await GET()).status).toBe(401);
    expect((await POST(undefined, { version: 1 })).status).toBe(401);
    expect((await POST(cookie, { version: 1, accountId: 'someone-else' })).status).toBe(422);
    expect((await POST(cookie, { version: '1' })).status).toBe(422);
    delete process.env.FEEDBACK_INTAKE_ENABLED;
    expect((await GET(cookie)).status).toBe(404);
    expect((await POST(cookie, { version: 1 })).status).toBe(404);
    expect((await recorded(id)).feedbackNoticeVersion).toBeNull();
  });

  it('is required before a submission is sent: 403 with its own code, nothing delivered', async () => {
    const double = praktico(SECRET);
    vi.stubGlobal('fetch', double.fetch);
    const { cookie } = await person();
    const send = () =>
      feedback.POST(
        new Request(`${ORIGIN}/api/feedback`, {
          method: 'POST',
          headers: {
            origin: ORIGIN,
            'content-type': 'application/json',
            'x-forwarded-for': `10.61.0.${++people}`,
            cookie,
          },
          body: JSON.stringify({
            kind: 'idea',
            message: 'A message',
            route: '/documents/[id]',
            viewport: { width: 1000, height: 700 },
          }),
        }),
      );
    const refused = await send();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe('feedback_notice_not_acknowledged');
    expect(double.requests).toHaveLength(0);
    await POST(cookie, { version: 1 });
    expect((await send()).status).toBe(201);
  });
});
