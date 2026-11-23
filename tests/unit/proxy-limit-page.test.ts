// NFR-SE-07, the audit's row UX-8: a page read refused by the limit of a person without a session is
// answered with the static page of `faultPage` and the same 429 and Retry-After; every other request
// keeps the JSON answer, byte for byte. The texts are written out here, not taken from the code under test.
import { NextRequest } from 'next/server';
import { describe, expect, it, vi } from 'vitest';

const SENTENCE = 'Too many requests were made in a short time. Try again in 7 seconds.';
const COOKIES = ['renewed=1; Path=/; HttpOnly'];
const logged = vi.fn(async () => {});
const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';

async function refused(path: string, method = 'GET', headers: Record<string, string> = {}) {
  vi.resetModules();
  vi.doMock('../../src/lib/settings.ts', () => ({
    settings: () => ({ appOrigin: 'https://app.example.test', limits: {} }),
  }));
  vi.doMock('../../src/lib/rate-limit.ts', () => ({
    takeLimit: async () => ({ ok: false, retryAfterSeconds: 7 }),
    logLimitReached: logged,
  }));
  vi.doMock('../../src/lib/auth/session.ts', () => ({
    validateSession: async () => ({ session: null, stopped: null, setCookie: COOKIES }),
  }));
  vi.doMock('../../src/lib/auth/auth.ts', () => ({ IDENTITY_BASE_PATH: '/api/auth' }));
  vi.doMock('../../src/lib/security-log.ts', () => ({ securityLog: async () => {} }));
  const { proxy } = await import('../../src/proxy.ts');
  return proxy(
    new NextRequest(`https://app.example.test${path}`, {
      method,
      headers: { origin: 'https://app.example.test', ...headers },
    }),
  );
}

describe('a limit reached by a person without a session (UX-8)', () => {
  it('answers a page read that accepts HTML with a page, 429, Retry-After and the sentence', async () => {
    const response = await refused('/sign-in', 'GET', { accept: HTML });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    const page = await response.text();
    expect(page).toContain('<title>Page not shown – Ekdotico</title>');
    expect(page).toContain('<h1>Page not shown</h1>');
    expect(page).toContain(`<p role="alert">${SENTENCE}</p>`);
    // No script, style, link, image or form: it loads nothing, so it costs no further request.
    expect(page).not.toMatch(/<(script|style|link|img|form|iframe)|src=|href=/i);
  });

  it('keeps 429, Retry-After, no-store, the policy and the renewed cookie on the page of the visitor path "/"', async () => {
    const response = await refused('/', 'GET', { accept: HTML });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('7');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(response.headers.getSetCookie()).toEqual(COOKIES);
    expect(await response.text()).toContain(`<p role="alert">${SENTENCE}</p>`);
  });

  it('writes the log entry of the limit exactly once for a page answer', async () => {
    logged.mockClear();
    await refused('/sign-in', 'GET', { accept: HTML });
    expect(logged).toHaveBeenCalledTimes(1);
    logged.mockClear();
    await refused('/', 'GET', { accept: HTML });
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it('says "1 second" in the singular', async () => {
    vi.resetModules();
    const { limitPage } = await import('../../src/lib/http.ts');
    expect(await limitPage(1).text()).toContain('Try again in 1 second.');
  });

  it('keeps the JSON answer for a request that does not accept HTML, byte for byte', async () => {
    for (const [path, method, headers] of [
      ['/sign-in', 'GET', {}],
      ['/sign-in', 'GET', { accept: 'application/json' }],
      ['/sign-in', 'GET', { accept: '*/*' }],
      ['/sign-in', 'GET', { accept: 'text/htmlx' }],
      ['/api/sign-up', 'POST', { accept: HTML }],
      ['/api/auth/sign-in/email', 'POST', { accept: 'application/json' }],
    ] as const) {
      const response = await refused(path, method, headers);
      expect(response.status).toBe(429);
      expect(response.headers.get('retry-after')).toBe('7');
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.text()).toBe(
        JSON.stringify({ error: { code: 'rate_limited', message: SENTENCE } }),
      );
    }
  });
});
