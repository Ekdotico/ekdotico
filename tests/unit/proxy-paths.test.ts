// The list of paths without a session (NFR-SE-05), as the proxy reads it. The
// proxy's behaviour on each kind of path is tested against a database and
// Valkey in tests/integration/proxy.test.ts.
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { getCloneableBody } from 'next/dist/server/body-streams.js';
import { unstable_doesMiddlewareMatch } from 'next/experimental/testing/server';
import { describe, expect, it, vi } from 'vitest';
import nextConfig from '../../next.config.ts';
import { IDENTITY_BASE_PATH, IDENTITY_ENDPOINTS } from '../../src/lib/auth/auth.ts';
import { returnPath } from '../../src/lib/http.ts';
import * as proxyModule from '../../src/proxy.ts';

const { classify, SESSIONLESS, STATIC_PREFIX } = proxyModule;

describe('the list of paths without a session', () => {
  // Written out a second time on purpose: a path added to the proxy's list
  // fails here until a person has added it here too.
  it('is these paths and no other', () => {
    expect(SESSIONLESS.map(({ group, methods, path }) => `${group} ${methods.join(',')} ${path}`)).toEqual([
      'a GET /sign-in',
      'a GET /sign-in/two-factor',
      'a GET /sign-in/link/[token]',
      'a GET /sign-up',
      'a GET /sign-up/[token]',
      'a GET /reset-password',
      'a GET /reset-password/[token]',
      'a GET /confirm-address/[token]',
      'a GET /privacy',
      'a POST /api/auth/sign-in/email',
      'a POST /api/auth/sign-in/link',
      'a POST /api/auth/two-factor/verify-totp',
      'a POST /api/auth/two-factor/verify-backup-code',
      'a POST /api/auth/request-password-reset',
      'a POST /api/auth/reset-password',
      'a POST /api/sign-up',
      'b POST,GET /api/admission/invitations',
      'b DELETE /api/admission/invitations/[id]',
      'c GET /api/health',
    ]);
    expect(STATIC_PREFIX).toBe('/_next/static/');
  });

  // FR-AU-83: "other than those of the enrolment itself", and "the means to
  // sign out". Written out a second time, as the list above is.
  it('lets these requests past the founding-team gate, and no other', () => {
    expect([...proxyModule.PAST_THE_GATE]).toEqual([
      'POST /api/auth/two-factor/enable',
      'POST /api/auth/sign-out',
    ]);
    for (const request of proxyModule.PAST_THE_GATE) {
      expect(IDENTITY_ENDPOINTS.has(request.replace(IDENTITY_BASE_PATH, ''))).toBe(true);
    }
  });

  it('names, under /api/auth, only endpoints that the identity handler serves', () => {
    const named = SESSIONLESS.filter(({ path }) => path.startsWith(IDENTITY_BASE_PATH));
    expect(named.length).toBeGreaterThan(0);
    for (const { methods, path } of named) {
      for (const method of methods) {
        expect(IDENTITY_ENDPOINTS.has(`${method} ${path.slice(IDENTITY_BASE_PATH.length)}`)).toBe(true);
      }
    }
  });

  // S-01 of the audit of November 2026: Next.js holds every body the proxy sees, up to one limit for every path
  // (next.config.ts), until it has ended. The upload of an image is the one path whose body is large, so it is the one
  // path the proxy does not see; its route makes every check the proxy would before it reads a byte
  // (src/lib/documents/route.ts, src/lib/images/upload.ts).
  it('is handed at most 320 KB of any body, and holds no more than that while the body is held', async () => {
    expect(nextConfig.experimental?.proxyClientMaxBodySize).toBe('320kb');
    const limit = 320 * 1024;
    // What Next.js 16.4 keeps of a body for the proxy and the route (next/dist/server/body-streams.js): 2 MB is sent
    // in chunks of 64 KB, the most a socket hands over at once, and the copy it holds stops at the limit, still past
    // 256 KB, the largest body a route other than the upload reads (src/app/api/account/documents/{transfer,clear}),
    // so that the route sees a body past its bound and refuses it.
    // It warns of the cut through the console Next.js patches, which needs a request to run in.
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sent = new PassThrough();
    const cloneable = getCloneableBody(sent as unknown as IncomingMessage, limit);
    cloneable.cloneBodyStream().resume();
    for (let each = 0; each < 32; each += 1) sent.write(Buffer.alloc(64 * 1024));
    sent.end();
    await cloneable.finalize();
    let kept = 0;
    for await (const chunk of sent as AsyncIterable<Buffer>) kept += chunk.length;
    expect(kept).toBeLessThanOrEqual(limit);
    expect(kept).toBeGreaterThan(256 * 1024);
    expect(warned).toHaveBeenCalledTimes(1);
    warned.mockRestore();
  });

  it('runs on every request but the upload of an image', () => {
    const { config } = proxyModule;
    const upload = '/api/documents/3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b/images';
    expect(unstable_doesMiddlewareMatch({ config, url: upload })).toBe(false);
    for (const url of [
      '/',
      '/api/documents',
      '/_next/image',
      '/favicon.ico',
      '/_next/data/x/y.json',
      '/sign-in',
      '/api/auth/sign-in/email',
      '/api/documents/x/invitations',
      `${upload}/c${'a'.repeat(24)}`,
      `${upload}/`,
      `${upload}x`,
      `/x${upload}`,
      '/api/documents/x/y/images',
      '/api/documents//images',
      '/API/documents/x/images',
    ]) {
      expect(unstable_doesMiddlewareMatch({ config, url }), url).toBe(true);
    }
  });
});

describe('classify', () => {
  it.each([
    ['GET', '/sign-in', 'a'],
    ['HEAD', '/sign-in', 'a'],
    ['GET', '/sign-in/link/AbC_123-x', 'a'],
    ['POST', '/api/auth/sign-in/link', 'a'],
    ['GET', '/sign-up', 'a'],
    ['HEAD', '/sign-up', 'a'],
    ['GET', '/sign-up/0123456789abcdef', 'a'],
    ['GET', '/reset-password', 'a'],
    ['GET', '/reset-password/tok', 'a'],
    ['GET', '/confirm-address/tok', 'a'],
    ['GET', '/privacy', 'a'],
    ['HEAD', '/privacy', 'a'],
    ['POST', '/api/auth/sign-in/email', 'a'],
    ['GET', '/sign-in/two-factor', 'a'],
    ['POST', '/api/auth/two-factor/verify-totp', 'a'],
    ['POST', '/api/auth/two-factor/verify-backup-code', 'a'],
    ['POST', '/api/auth/request-password-reset', 'a'],
    ['POST', '/api/auth/reset-password', 'a'],
    ['POST', '/api/sign-up', 'a'],
    ['POST', '/api/admission/invitations', 'b'],
    ['GET', '/api/admission/invitations', 'b'],
    ['DELETE', '/api/admission/invitations/cmg1x2y3z', 'b'],
    ['GET', '/api/health', 'c'],
    ['HEAD', '/api/health', 'c'],
    ['GET', '/_next/static/chunks/main.js', 'static'],
    ['HEAD', '/_next/static/media/font.woff2', 'static'],
  ])('%s %s is on the list (%s)', (method, path, group) => {
    expect(classify(method, path)).toBe(group);
  });

  it.each([
    // Not on the list at all.
    ['GET', '/'],
    ['GET', '/api/documents'],
    ['GET', '/favicon.ico'],
    ['GET', '/_next/image'],
    ['GET', '/_next'],
    ['GET', '/_next/static'],
    // Every other endpoint of the identity library, and its prefix.
    ['GET', '/api/auth'],
    ['POST', '/api/auth'],
    ['GET', '/api/auth/get-session'],
    ['POST', '/api/auth/sign-out'],
    ['POST', '/api/auth/two-factor/enable'],
    ['POST', '/api/auth/two-factor/disable'],
    ['POST', '/api/auth/two-factor/generate-backup-codes'],
    ['POST', '/api/auth/two-factor/send-otp'],
    ['POST', '/api/auth/two-factor/verify-otp'],
    ['GET', '/api/auth/two-factor/verify-totp'],
    ['POST', '/sign-in/two-factor'],
    ['GET', '/sign-in/two-factor/x'],
    ['POST', '/api/auth/change-password'],
    // FR-AU-03, FR-AU-90: the name and the request for a change of the address
    // need a session, and so does the confirmation (the owner's decision of
    // 9 October 2026); the page of a confirmation link is read and never
    // posted to, and its endpoint answers no GET.
    ['POST', '/api/auth/update-user'],
    ['POST', '/api/auth/change-email'],
    ['POST', '/api/auth/verify-email'],
    ['GET', '/api/auth/verify-email'],
    ['POST', '/privacy'],
    ['GET', '/privacy/'],
    ['GET', '/Privacy'],
    ['GET', '/privacy/more'],
    ['POST', '/confirm-address/tok'],
    ['GET', '/confirm-address'],
    ['GET', '/confirm-address/tok/more'],
    ['POST', '/api/auth/revoke-session'],
    ['POST', '/api/auth/revoke-other-sessions'],
    ['GET', '/api/auth/list-sessions'],
    ['GET', '/api/auth/reset-password'],
    ['GET', '/api/auth/reset-password/tok'],
    ['POST', '/api/auth/reset-password/tok'],
    ['GET', '/api/auth/request-password-reset'],
    ['POST', '/reset-password'],
    ['POST', '/reset-password/tok'],
    ['GET', '/settings'],
    ['POST', '/api/auth/sign-up/email'],
    // A listed path under another method.
    ['POST', '/sign-in'],
    ['POST', '/sign-up/tok'],
    ['GET', '/api/sign-up'],
    ['GET', '/api/auth/sign-in/email'],
    ['POST', '/api/health'],
    ['DELETE', '/api/health'],
    ['DELETE', '/api/admission/invitations'],
    ['POST', '/api/admission/invitations/abc'],
    ['PUT', '/api/admission/invitations'],
    ['POST', '/_next/static/chunks/main.js'],
    ['OPTIONS', '/api/sign-up'],
    // A trailing slash, another case, a doubled slash.
    ['GET', '/sign-in/'],
    ['GET', '/Sign-In'],
    ['GET', '/SIGN-IN'],
    ['GET', '/API/health'],
    ['GET', '/api/health/'],
    ['GET', '//sign-in'],
    ['GET', '/sign-in//'],
    ['GET', '/api//health'],
    ['POST', '/api/auth//sign-in/email'],
    ['POST', '/api/auth/sign-in/email/'],
    ['POST', '/api/auth/Sign-In/Email'],
    // A listed path as the prefix of another, and as its suffix.
    ['GET', '/sign-in/anything'],
    ['GET', '/sign-in/link'],
    ['GET', '/sign-in/link/tok/more'],
    // The page of a lock's link is read and never posted to: its control is an endpoint.
    ['POST', '/sign-in/link/AbC_123-x'],
    ['GET', '/api/auth/sign-in/link'],
    ['POST', '/sign-up'],
    ['GET', '/sign-up/'],
    ['GET', '/Sign-Up'],
    ['GET', '/sign-up/tok/settings'],
    ['GET', '/api/health/details'],
    ['GET', '/api/healthz'],
    ['POST', '/api/sign-up/admin'],
    ['POST', '/api/auth/sign-in/email/x'],
    ['GET', '/api/admission/invitations/abc'],
    ['GET', '/api/admission'],
    ['GET', '/x/sign-in'],
    ['GET', '/x/api/health'],
    ['GET', '/x/_next/static/a.js'],
    // Dots, and encodings of a slash, a dot and a null byte, left as they were sent.
    ['GET', '/sign-in/../api/documents'],
    ['GET', '/_next/static/../../api/documents'],
    ['GET', '/sign-up/..'],
    ['GET', '/sign-up/.'],
    ['GET', '/sign-up/a%2Fb'],
    ['GET', '/sign-up/a%2fb'],
    ['GET', '/sign-up/%2e%2e'],
    ['GET', '/sign-up/a%00'],
    ['GET', '/sign-up/a%5Cb'],
    ['GET', '/sign-up/a\\b'],
    ['GET', '/sign-up/a b'],
    ['GET', '/sign-up/a?b'],
    ['GET', '/sign-up/a;b'],
    ['GET', '/api%2Fhealth'],
    ['GET', '/api/health%2F'],
    ['GET', '/api/health%00'],
    ['GET', '/api/health;x'],
    ['GET', '/api/health\n'],
    ['GET', '/sign-in\n/x'],
    ['DELETE', '/api/admission/invitations/a%2F..%2Fb'],
    ['GET', '/_next%2Fstatic/a.js'],
    ['GET', '/_next/static/%2e%2e/%2e%2e/api/documents'],
    ['GET', '/_next/static/..%2F..%2Fapi/documents'],
    ['GET', '/_next/static/..\\..\\api\\documents'],
    ['GET', '/_next/static//api/documents'],
  ])('%s %s requires a session', (method, path) => {
    expect(classify(method, path)).toBe('session');
  });

  // The URL parser of the platform resolves dots before the proxy sees a path,
  // so what is classified is what Next.js routes.
  it('sees a path with dots as the parser resolves it', () => {
    expect(new URL('https://app.example.test/_next/static/../../api/documents').pathname).toBe(
      '/api/documents',
    );
    expect(new URL('https://app.example.test/_next/static/%2e%2e/%2E%2E/api/documents').pathname).toBe(
      '/api/documents',
    );
    expect(new URL('https://app.example.test/sign-in\\..\\api\\documents').pathname).toBe('/api/documents');
  });
});

// FR-AU-07: "is sent to sign in and is returned to it afterwards", to a path of this origin alone.
describe('returnPath', () => {
  it.each(['/', '/documents/1', '/documents/1?tab=sharing&x=%2F', '/a/b#c'])('keeps the path %s', (path) => {
    expect(returnPath(path)).toBe(path);
  });

  it.each([
    null,
    undefined,
    '',
    'documents',
    '//evil.example',
    '//evil.example/path',
    '/\\evil.example',
    '\\\\evil.example',
    '/\\/evil.example',
    'https://evil.example',
    'https:evil.example',
    'javascript:alert(1)',
    ' /documents',
    '/\tevil.example',
    '/\n/evil.example',
    '/documents\\..\\x',
    '/documents\u0000',
  ])('answers / for %j', (value) => {
    expect(returnPath(value)).toBe('/');
  });
});
