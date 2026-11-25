// The route's wiring to the post on Discord (FR-AU-94): `POST /api/feedback` with both switches on, the webhooks set and `fetch`
// stubbed, with `after` of Next.js running what it is given (it exists only inside a request of the framework). One webhook
// call after a 201, and none after anything else: a pair the intake already held (200), the intake's refusal, a body that is
// refused, either notice not acknowledged, or either switch off.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { praktico } from '../fixtures/praktico-double.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const scheduled = vi.hoisted(() => ({ pending: [] as Promise<unknown>[] }));
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: (work: (() => unknown) | Promise<unknown>) => {
    scheduled.pending.push(Promise.resolve().then(typeof work === 'function' ? work : () => work));
  },
}));

const SECRET = 'D'.repeat(43);
const HOOKS = {
  DISCORD_WEBHOOK_PROBLEM: 'https://discord.com/api/webhooks/111111111111111111/problemTOKEN',
  DISCORD_WEBHOOK_IDEA: 'https://discord.com/api/webhooks/222222222222222222/ideaTOKEN',
  DISCORD_WEBHOOK_OTHER: 'https://discord.com/api/webhooks/333333333333333333/otherTOKEN',
};
const database = prepare('feedbackdiscord', { FEEDBACK_SECRET: SECRET });
const { auth, db, valkey } = await load();
const route = await import('../../src/app/api/feedback/route.ts');
const { CLOSED_ALPHA_NOTICE_VERSION } = await import('../../src/lib/closed-alpha-notice.ts');

const BODY = {
  kind: 'idea',
  message: 'A message for the community',
  route: '/documents/[id]',
  viewport: { width: 1000, height: 700 },
};

let people = 0;
let address = 0;
async function person({ closedAlpha = true, notice = true } = {}) {
  const email = `discord${++people}-${Math.random().toString(16).slice(2, 8)}@example.com`;
  const id = await createAccount(auth, email);
  await db().user.update({
    where: { id },
    data: {
      ...(closedAlpha
        ? {
            closedAlphaNoticeVersion: CLOSED_ALPHA_NOTICE_VERSION,
            closedAlphaNoticeAcknowledgedAt: new Date(),
          }
        : {}),
      // Version 2 while posting to Discord is on, as the switches of these tests have it.
      ...(notice ? { feedbackNoticeVersion: 2, feedbackNoticeAcknowledgedAt: new Date() } : {}),
    },
  });
  return { id, cookie: cookiesOf(await signIn(auth, email)) };
}
const post = (cookie: string, body: unknown) =>
  route.POST(
    new Request(`${ORIGIN}/api/feedback`, {
      method: 'POST',
      headers: {
        origin: ORIGIN,
        'content-type': 'application/json',
        'x-forwarded-for': `10.62.0.${++address}`,
        cookie,
      },
      body: JSON.stringify(body),
    }),
  );

let double = praktico(SECRET);
let webhookCalls: { url: string; body: Record<string, unknown> }[] = [];
const settle = async () => {
  await Promise.all(scheduled.pending.splice(0));
};

beforeEach(() => {
  Object.assign(process.env, HOOKS, { FEEDBACK_INTAKE_ENABLED: 'true', FEEDBACK_DISCORD_ENABLED: 'true' });
  double = praktico(SECRET);
  webhookCalls = [];
  scheduled.pending.length = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://discord.com/')) {
      webhookCalls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response('{}', { status: 200 });
    }
    return double.fetch(input, init);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of [...Object.keys(HOOKS), 'FEEDBACK_INTAKE_ENABLED', 'FEEDBACK_DISCORD_ENABLED'])
    delete process.env[name];
});
afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the post to Discord, from the route (FR-AU-94)', () => {
  it('makes exactly one webhook call after a 201, with the kind (as the channel) and the message, and nothing else', async () => {
    const who = await person();
    const response = await post(who.cookie, BODY);
    expect(response.status).toBe(201);
    await settle();
    expect(webhookCalls).toHaveLength(1);
    expect(webhookCalls[0]!.url).toBe(`${HOOKS.DISCORD_WEBHOOK_IDEA}?wait=true`);
    expect(webhookCalls[0]!.body).toEqual({
      thread_name: BODY.message,
      embeds: [{ description: BODY.message }],
      allowed_mentions: { parse: [] },
    });
    const sent = JSON.stringify(webhookCalls[0]);
    for (const absent of [who.id, BODY.route, 'viewport', 'submissionId', 'appVersion']) {
      expect(sent).not.toContain(absent);
    }
  });

  it('posts nothing for a pair the intake already held (its 200), and the answer is the same', async () => {
    const who = await person();
    const once = { ...BODY, submissionId: 'held-1' };
    expect((await post(who.cookie, once)).status).toBe(201);
    await settle();
    expect(webhookCalls).toHaveLength(1);
    expect((await post(who.cookie, once)).status).toBe(201);
    await settle();
    expect(webhookCalls).toHaveLength(1);
  });

  it('posts nothing where the intake refuses', async () => {
    const who = await person();
    double.failWith = 500;
    expect((await post(who.cookie, BODY)).status).toBe(502);
    await settle();
    expect(webhookCalls).toHaveLength(0);
  });

  it('posts nothing for a body that is refused (422)', async () => {
    const who = await person();
    expect((await post(who.cookie, { ...BODY, kind: 'nope' })).status).toBe(422);
    await settle();
    expect(webhookCalls).toHaveLength(0);
  });

  it('posts nothing for an account that has not acknowledged either notice (403)', async () => {
    const closed = await person({ closedAlpha: false });
    expect((await post(closed.cookie, BODY)).status).toBe(403);
    const feedback = await person({ notice: false });
    expect((await post(feedback.cookie, BODY)).status).toBe(403);
    await settle();
    expect(webhookCalls).toHaveLength(0);
  });

  it('posts nothing while either switch is off, and the answer is the same where only the second is', async () => {
    const who = await person();
    process.env.FEEDBACK_DISCORD_ENABLED = 'false';
    // The account has acknowledged version 2, which covers version 1 of the text while posting is off.
    expect((await post(who.cookie, BODY)).status).toBe(201);
    process.env.FEEDBACK_DISCORD_ENABLED = 'true';
    process.env.FEEDBACK_INTAKE_ENABLED = 'false';
    expect((await post(who.cookie, BODY)).status).toBe(404);
    await settle();
    expect(webhookCalls).toHaveLength(0);
  });

  it('answers 201 and logs without the message where Discord fails', async () => {
    const who = await person();
    const lines: string[] = [];
    vi.spyOn(console, 'info').mockImplementation((line: unknown) => void lines.push(String(line)));
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith('https://discord.com/')
        ? new Response('{}', { status: 500 })
        : double.fetch(input, init),
    );
    expect((await post(who.cookie, BODY)).status).toBe(201);
    await settle();
    const all = lines.join('\n');
    expect(all).toContain('not posted to discord (status 500)');
    expect(all).not.toContain(BODY.message);
    expect(all).not.toContain('TOKEN');
  });
});
