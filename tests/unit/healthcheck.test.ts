// Check-ins with Healthchecks.io (D274, D275, D280). `fetch` is stubbed in every test: no service is
// contacted and no email is sent.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportToMonitor } from '../../scripts/backup.ts';
import { selfCheck } from '../../scripts/self-check.ts';
import { checkIn, checkInUrl } from '../../src/lib/healthcheck.ts';

// Obviously fake: the shape of a check's address, the value of none.
const PING = 'https://hc-ping.com/00000000-0000-4000-8000-000000000000';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFetch(impl: (url: string) => Promise<Response> | Response) {
  const fetchMock = vi.fn((url: string) => Promise.resolve(impl(url)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('checkInUrl', () => {
  it('is undefined where the setting is absent or empty', () => {
    expect(checkInUrl({}, 'X')).toBeUndefined();
    expect(checkInUrl({ X: '' }, 'X')).toBeUndefined();
  });

  it('accepts a check address and the key-and-slug form', () => {
    expect(checkInUrl({ X: PING }, 'X')).toBe(PING);
    expect(checkInUrl({ X: 'https://hc-ping.com/pingkey/backup' }, 'X')).toBe(
      'https://hc-ping.com/pingkey/backup',
    );
  });

  it.each([
    'http://hc-ping.com/abc',
    'https://evil.example/abc',
    'https://hc-ping.com.evil.example/abc',
    'https://user:pw@hc-ping.com/abc',
    'https://hc-ping.com:8443/abc',
    'https://hc-ping.com/abc?x=1',
    'https://hc-ping.com/',
    'https://hc-ping.com/a/b/c',
    'not a url',
  ])('refuses %s, naming the setting and never the value', (value) => {
    let message = '';
    try {
      checkInUrl({ HEALTHCHECK_X_URL: value }, 'HEALTHCHECK_X_URL');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('HEALTHCHECK_X_URL');
    expect(message).not.toContain(value);
  });
});

describe('checkIn', () => {
  it('makes no request without an address', async () => {
    const fetchMock = stubFetch(() => new Response('OK'));
    expect(await checkIn(undefined)).toBe(false);
    expect(await checkIn(undefined, 'fail')).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is one GET with no body and no header, and /fail for a failure', async () => {
    const fetchMock = stubFetch(() => new Response('OK'));
    expect(await checkIn(PING)).toBe(true);
    await checkIn(PING, 'fail');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PING, `${PING}/fail`]);
    const init = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(init.headers).toBeUndefined();
  });

  it('never throws, writes nothing, and never carries the address, whatever fails', async () => {
    const logs = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    stubFetch(() => {
      throw new Error(`connect ECONNREFUSED ${PING}`);
    });
    await expect(checkIn(PING)).resolves.toBe(false);
    stubFetch(() => new Response('no', { status: 500 }));
    await expect(checkIn(PING)).resolves.toBe(false);
    for (const log of logs) expect(log).not.toHaveBeenCalled();
  });

  it('gives up on a slow service within a few seconds', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn((_url: string, init: RequestInit) => {
          return new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }),
      );
      const done = checkIn(PING);
      await vi.advanceTimersByTimeAsync(5001);
      await expect(done).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the check of the backups', () => {
  it('calls nothing where the setting is absent', async () => {
    const fetchMock = stubFetch(() => new Response('OK'));
    await reportToMonitor({}, 'ok');
    await reportToMonitor({}, 'fail');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('checks in after a copy and signals a failure, and a wrong setting is said by name and calls nothing', async () => {
    const fetchMock = stubFetch(() => new Response('OK'));
    await reportToMonitor({ HEALTHCHECK_BACKUP_URL: PING }, 'ok');
    await reportToMonitor({ HEALTHCHECK_BACKUP_URL: PING }, 'fail');
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([PING, `${PING}/fail`]);

    fetchMock.mockClear();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await reportToMonitor({ HEALTHCHECK_BACKUP_URL: 'https://evil.example/x' }, 'ok');
    expect(fetchMock).not.toHaveBeenCalled();
    const said = errors.mock.calls.flat().join(' ');
    expect(said).toContain('HEALTHCHECK_BACKUP_URL');
    expect(said).not.toContain('evil.example');
  });
});

describe('the self-check of the server', () => {
  const env = {
    APP_ORIGIN: 'https://app.example.test',
    HEALTHCHECK_WEB_URL: 'https://hc-ping.com/web-check',
    HEALTHCHECK_COLLAB_URL: 'https://hc-ping.com/collab-check',
  };

  it('checks in for each address that answers 200, and for no other', async () => {
    const fetchMock = stubFetch((url) =>
      url === 'https://app.example.test/collab/health'
        ? new Response('down', { status: 503 })
        : new Response('OK'),
    );
    const lines: string[] = [];
    expect(await selfCheck(env, (line) => lines.push(line))).toBe(1);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://app.example.test/api/health',
      'https://hc-ping.com/web-check',
      'https://app.example.test/collab/health',
    ]);
    expect(lines.join(' ')).not.toContain('hc-ping');
  });

  it('survives an unreachable address and a failing monitor, and exits 0 when both answer', async () => {
    stubFetch((url) => {
      if (url.startsWith('https://hc-ping.com')) throw new Error('monitor down');
      return new Response('OK');
    });
    expect(await selfCheck(env, () => {})).toBe(0);
  });

  it('refuses a wrong setting before it calls anything, naming it and not its value', async () => {
    const fetchMock = stubFetch(() => new Response('OK'));
    const lines: string[] = [];
    const code = await selfCheck({ ...env, HEALTHCHECK_WEB_URL: 'https://evil.example/x' }, (line) =>
      lines.push(line),
    );
    expect(code).toBe(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(lines.join(' ')).toContain('HEALTHCHECK_WEB_URL');
    expect(lines.join(' ')).not.toContain('evil.example');
  });

  it('makes no check-in where its two settings are absent', async () => {
    const fetchMock = stubFetch(() => new Response('OK'));
    expect(await selfCheck({ APP_ORIGIN: env.APP_ORIGIN }, () => {})).toBe(0);
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://app.example.test/api/health',
      'https://app.example.test/collab/health',
    ]);
  });
});
