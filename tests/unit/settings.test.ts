import { describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/lib/settings.ts';

const env = {
  FOUNDING_TEAM_EMAILS: '',
  APP_ORIGIN: 'https://app.example.test',
  EMAIL_TRANSPORT: 'sink',
  DATABASE_URL: 'postgresql://ekdotico_app:x@localhost:5432/ekdotico',
  VALKEY_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
};

describe('loadSettings (FR-AU-83; register A102)', () => {
  it('refuses to start where FOUNDING_TEAM_EMAILS is absent', () => {
    expect(() => loadSettings({ ...env, FOUNDING_TEAM_EMAILS: undefined })).toThrow(/FOUNDING_TEAM_EMAILS/);
  });

  it('accepts a list with no address, written as an empty value', () => {
    expect(loadSettings(env).foundingTeamEmails).toEqual([]);
  });

  it('reads addresses separated by commas, without regard to case', () => {
    const { foundingTeamEmails } = loadSettings({
      ...env,
      FOUNDING_TEAM_EMAILS: ' One@Example.com,two@example.com ,',
    });
    expect(foundingTeamEmails).toEqual(['one@example.com', 'two@example.com']);
  });
});

describe('loadSettings: what a process cannot start without', () => {
  it.each(['APP_ORIGIN', 'DATABASE_URL', 'VALKEY_URL', 'AUTH_SECRET'])(
    'refuses to start without %s',
    (name) => {
      expect(() => loadSettings({ ...env, [name]: undefined })).toThrow(new RegExp(name));
      expect(() => loadSettings({ ...env, [name]: '' })).toThrow(new RegExp(name));
    },
  );

  it('refuses a secret shorter than 32 characters, and never repeats it', () => {
    expect(() => loadSettings({ ...env, AUTH_SECRET: 'too-short-secret' })).toThrow(/at least 32/);
    expect(() => loadSettings({ ...env, AUTH_SECRET: 'too-short-secret' })).not.toThrow(/too-short-secret/);
  });

  // NFR-SE-17 (c): the allow-list of origins holds one exact origin, and the
  // session cookie is Secure.
  it.each([
    'https://app.example.test/',
    'https://app.example.test/path',
    'app.example.test',
    'http://app.example.test',
    'HTTPS://APP.EXAMPLE.TEST',
  ])('refuses %s as the origin', (origin) => {
    expect(() => loadSettings({ ...env, APP_ORIGIN: origin })).toThrow(/APP_ORIGIN/);
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000'])('admits %s, for development', (origin) => {
    expect(loadSettings({ ...env, APP_ORIGIN: origin }).appOrigin).toBe(origin);
  });

  // Register A52, A72: the only sender writes to a file. A deployment must not
  // lose its email by leaving a setting out.
  it('refuses to start away from a development machine unless the local sink is chosen', () => {
    expect(() => loadSettings({ ...env, EMAIL_TRANSPORT: undefined })).toThrow(/EMAIL_TRANSPORT/);
    expect(() => loadSettings({ ...env, EMAIL_TRANSPORT: 'scaleway' })).toThrow(/EMAIL_TRANSPORT/);
    expect(() =>
      loadSettings({ ...env, APP_ORIGIN: 'http://localhost:3000', EMAIL_TRANSPORT: 'scaleway' }),
    ).toThrow(/EMAIL_TRANSPORT/);
    expect(() =>
      loadSettings({ ...env, APP_ORIGIN: 'http://localhost:3000', EMAIL_TRANSPORT: undefined }),
    ).not.toThrow();
  });

  it('holds the two limits of a password as settings (FR-AU-82)', () => {
    expect(loadSettings(env)).toMatchObject({ passwordMinLength: 15, passwordMaxLength: 128 });
    expect(loadSettings({ ...env, PASSWORD_MIN_LENGTH: '20' }).passwordMinLength).toBe(20);
  });
});

describe('loadSettings: the initial values (FR-AU-84, NFR-SE-07, NFR-SE-17, NFR-SE-19)', () => {
  const settings = loadSettings(env);

  it('gives a session 7 days, renewed at most once in 24 hours, and 30 days in all', () => {
    expect(settings.sessionIdleSeconds).toBe(7 * 86400);
    expect(settings.sessionRenewSeconds).toBe(86400);
    expect(settings.sessionMaxSeconds).toBe(30 * 86400);
  });

  it('keeps the signed copy of a session for 1 minute and the security log for 30 days', () => {
    expect(settings.cookieCacheSeconds).toBe(60);
    expect(settings.securityLogRetentionDays).toBe(30);
  });

  it('trusts no proxy unless told how many there are', () => {
    expect(settings.trustedProxyCount).toBe(0);
  });

  it('holds the limits of NFR-SE-07', () => {
    expect(settings.limits).toEqual({
      API_PER_USER: { max: 120, windowSeconds: 60 },
      INVITATIONS_PER_USER: { max: 20, windowSeconds: 3600 },
      IMAGE_UPLOADS_PER_USER: { max: 30, windowSeconds: 600 },
      EXPORTS_PER_USER: { max: 10, windowSeconds: 3600 },
      HANDSHAKES_PER_USER: { max: 30, windowSeconds: 60 },
      SESSIONLESS_PER_ADDRESS: { max: 20, windowSeconds: 60 },
      FAILED_SIGN_IN_PER_EMAIL_AND_ADDRESS: { max: 5, windowSeconds: 900 },
      FAILED_SIGN_IN_PER_EMAIL: { max: 20, windowSeconds: 3600 },
      RESET_PER_EMAIL: { max: 3, windowSeconds: 3600 },
      RESET_PER_ADDRESS: { max: 10, windowSeconds: 3600 },
      CONFIRMATION_EMAIL_PER_USER: { max: 3, windowSeconds: 3600 },
      ADMISSION: { max: 60, windowSeconds: 60 },
    });
  });

  it('changes a limit and a period without a code change', () => {
    const changed = loadSettings({ ...env, RATE_LIMIT_API_PER_USER: '10/5', SESSION_MAX_SECONDS: '3600' });
    expect(changed.limits.API_PER_USER).toEqual({ max: 10, windowSeconds: 5 });
    expect(changed.sessionMaxSeconds).toBe(3600);
  });

  it.each(['10', '0/60', '10/0', '-1/60', '1e3/60', '10/60/1'])('refuses the limit %s', (value) => {
    expect(() => loadSettings({ ...env, RATE_LIMIT_API_PER_USER: value })).toThrow(/RATE_LIMIT_API_PER_USER/);
  });

  it.each(['-1', '1.5', 'seven', '1e3'])('refuses %s as a whole number', (value) => {
    expect(() => loadSettings({ ...env, TRUSTED_PROXY_COUNT: value })).toThrow(/TRUSTED_PROXY_COUNT/);
  });
});
