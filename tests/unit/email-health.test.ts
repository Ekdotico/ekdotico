// "Email is healthy" and its check-in (D274, D320). `fetch` is stubbed in every test: Brevo and the
// monitoring service are contacted by none, and no email is sent.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PING = 'https://hc-ping.com/00000000-0000-4000-8000-000000000000';
const held = vi.hoisted(() => ({ url: undefined as string | undefined, queued: 0 }));

vi.mock('../../src/lib/settings.ts', () => ({
  settings: () => ({
    emailTransport: 'brevo',
    brevoApiKey: 'xkeysib-fake-key-for-tests',
    emailSender: { name: 'Ekdotico', email: 'no-reply@example.test' },
    healthcheckEmailUrl: held.url,
    healthcheckTimersUrl: undefined,
  }),
}));
vi.mock('../../src/lib/db.ts', () => ({
  db: () => ({ emailRetry: { count: () => Promise.resolve(held.queued) } }),
}));

const { checkInEmail } = await import('../../src/lib/timers.ts');
const { forgetEmailHealth, isAccountFault } = await import('../../src/lib/email/health.ts');
const { sendEmail } = await import('../../src/lib/email/index.ts');

const message = { to: 'someone@example.test', subject: 'Subject', text: 'Text' };
const answer = (status: number, code?: string) =>
  new Response(code ? JSON.stringify({ code }) : '{}', { status });

let calls: string[];
function stubFetch(brevo: () => Response | Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(url.startsWith('https://hc-ping.com') ? new Response('OK') : brevo());
    }),
  );
}
const pings = () => calls.filter((url) => url.startsWith('https://hc-ping.com'));

beforeEach(() => {
  calls = [];
  held.url = PING;
  held.queued = 0;
  forgetEmailHealth();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('what is an account fault', () => {
  it.each(['401', '402', '403', '400', '400_CREDITS', '400_KEY', '400_DOMAIN', '400_PERMISSION'])(
    '%s is one',
    (code) => expect(isAccountFault(code)).toBe(true),
  );
  it.each(['429', '500', '503', 'Timeout', 'ECONNREFUSED', undefined, '4000'])('%s is not', (code) =>
    expect(isAccountFault(code)).toBe(false),
  );
});

describe('the check-in of email health', () => {
  it('checks in while healthy', async () => {
    stubFetch(() => answer(201));
    await sendEmail(message);
    await checkInEmail();
    expect(pings()).toEqual([PING]);
  });

  it('checks in before any hand-over has been made, which the row states', async () => {
    stubFetch(() => answer(201));
    await checkInEmail();
    expect(pings()).toEqual([PING]);
  });

  it.each([
    [401, undefined],
    [403, undefined],
    [400, 'not_enough_credits'],
    [400, 'api-key not found'],
    [400, 'DNS records not properly configured'],
    [400, 'something unlisted'],
  ])('makes no check-in while the last hand-over was an account fault (%i %s)', async (status, code) => {
    stubFetch(() => answer(status, code));
    await expect(sendEmail(message)).rejects.toThrow();
    await checkInEmail();
    expect(pings()).toEqual([]);
  });

  it('resumes when a hand-over succeeds again', async () => {
    stubFetch(() => answer(402));
    await expect(sendEmail(message)).rejects.toThrow();
    await checkInEmail();
    expect(pings()).toEqual([]);
    stubFetch(() => answer(201));
    await sendEmail(message);
    await checkInEmail();
    expect(pings()).toEqual([PING]);
  });

  it('is not an account fault where the message, an outage or a limit is the trouble', async () => {
    for (const status of [answer(400, 'invalid_parameter'), answer(429), answer(503)]) {
      stubFetch(() => status.clone());
      await expect(sendEmail(message)).rejects.toThrow();
      await checkInEmail();
    }
    expect(pings()).toHaveLength(3);
  });

  it('makes no check-in while the queue grows, and resumes when it stops growing', async () => {
    stubFetch(() => answer(201));
    held.queued = 2;
    await checkInEmail(); // the first count has nothing to grow from
    held.queued = 3;
    await checkInEmail(); // grew
    held.queued = 3;
    await checkInEmail(); // same
    held.queued = 1;
    await checkInEmail(); // fell
    expect(pings()).toHaveLength(3);
    held.queued = 5;
    await checkInEmail();
    expect(pings()).toHaveLength(3);
  });

  it('calls nothing without the setting, and never logs the address', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    held.url = undefined;
    stubFetch(() => answer(201));
    await checkInEmail();
    expect(calls).toEqual([]);
    held.url = PING;
    vi.stubGlobal('fetch', () => Promise.reject(new Error(`connect ECONNREFUSED ${PING}`)));
    await expect(checkInEmail()).resolves.toBeUndefined();
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain('hc-ping');
  });
});
