import { beforeAll, describe, expect, it } from 'vitest';

const OWN = 'https://app.example.test';
let isOwnOrigin: (typeof import('../../src/lib/origin.ts'))['isOwnOrigin'];

beforeAll(async () => {
  Object.assign(process.env, {
    FOUNDING_TEAM_EMAILS: '',
    APP_ORIGIN: OWN,
    EMAIL_TRANSPORT: 'sink',
    EMAIL_SINK_DIRECTORY: '/unused',
    TRUSTED_PROXY_COUNT: '1',
    AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
    DATABASE_URL: 'postgresql://unused',
    VALKEY_URL: 'redis://unused',
  });
  ({ isOwnOrigin } = await import('../../src/lib/origin.ts'));
});

// NFR-SE-17 (c): the allow-list holds the application's own origin and no other.
describe('the origin check', () => {
  it("accepts the application's own origin", () => {
    expect(isOwnOrigin(OWN)).toBe(true);
  });

  it('refuses a request that carries no Origin header', () => {
    expect(isOwnOrigin(null)).toBe(false);
    expect(isOwnOrigin(undefined)).toBe(false);
    expect(isOwnOrigin('')).toBe(false);
  });

  it.each([
    ['the origin of a sandboxed frame', 'null'],
    ['a host that ends with the own host', 'https://evilapp.example.test'],
    ['a host under the own host', 'https://evil.app.example.test'],
    ['a host that begins with the own host', 'https://app.example.test.evil.example'],
    ['the registrable domain', 'https://example.test'],
    ['a sibling host, which is same-site', 'https://internal.example.test'],
    ['another port', 'https://app.example.test:8443'],
    ['the default port written out', 'https://app.example.test:443'],
    ['another scheme', 'http://app.example.test'],
    ['an upper-case host', 'https://APP.EXAMPLE.TEST'],
    ['an upper-case scheme', 'HTTPS://app.example.test'],
    ['a trailing slash', 'https://app.example.test/'],
    ['a trailing dot', 'https://app.example.test.'],
    ['a path', 'https://app.example.test/sign-in'],
    ['userinfo before the own host', 'https://user@app.example.test'],
    ['the own host as userinfo', 'https://app.example.test@evil.example'],
    ['two origins', 'https://app.example.test, https://evil.example'],
    ['a leading space', ' https://app.example.test'],
    ['a trailing space', 'https://app.example.test '],
    ['a trailing null byte', 'https://app.example.test\u0000'],
    ['a wildcard', '*'],
  ])('refuses %s', (_, origin) => {
    expect(isOwnOrigin(origin)).toBe(false);
  });
});
