import { describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/lib/settings.ts';

const env = {
  FOUNDING_TEAM_EMAILS: '',
  APP_ORIGIN: 'https://app.example.test',
  EMAIL_TRANSPORT: 'sink',
  EMAIL_SINK_DIRECTORY: '/var/lib/ekdotico/mail',
  DATABASE_URL: 'postgresql://ekdotico_app:x@localhost:5432/ekdotico',
  VALKEY_URL: 'redis://localhost:6379',
  AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
  TRUSTED_PROXY_COUNT: '1',
};

// NFR-SE-07; the owner's decision of 8 October 2026: away from localhost a
// process does not start without a proxy that writes the address of a client,
// since every client would then share one count.
describe('loadSettings: TRUSTED_PROXY_COUNT and the origin', () => {
  const LOCAL = ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost'];

  it.each([undefined, '', '0'])('refuses to start away from localhost where it is %j', (value) => {
    const start = () => loadSettings({ ...env, TRUSTED_PROXY_COUNT: value });
    expect(start).toThrow(/^TRUSTED_PROXY_COUNT must be 1 or more, except on localhost: /);
    expect(start).toThrow(/count every client as one/);
  });

  it.each(['1', '2'])('starts away from localhost with %s', (value) => {
    expect(loadSettings({ ...env, TRUSTED_PROXY_COUNT: value }).trustedProxyCount).toBe(Number(value));
  });

  it.each(LOCAL)('starts on %s with 0, set or left out', (origin) => {
    expect(loadSettings({ ...env, APP_ORIGIN: origin, TRUSTED_PROXY_COUNT: '0' }).trustedProxyCount).toBe(0);
    expect(
      loadSettings({ ...env, APP_ORIGIN: origin, TRUSTED_PROXY_COUNT: undefined }).trustedProxyCount,
    ).toBe(0);
    expect(loadSettings({ ...env, APP_ORIGIN: origin, TRUSTED_PROXY_COUNT: '1' }).trustedProxyCount).toBe(1);
  });
});

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

  // Register D70 (the three checks stand), D92: the only sender writes to a
  // file. A deployment must not lose its email by leaving a setting out.
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

  // NFR-SE-19: the files of the sink hold addresses and links. A deployment
  // names their directory; only a development machine is given one.
  it('refuses to start away from a development machine without the directory of the sink', () => {
    expect(() => loadSettings({ ...env, EMAIL_SINK_DIRECTORY: undefined })).toThrow(/EMAIL_SINK_DIRECTORY/);
    expect(() => loadSettings({ ...env, EMAIL_SINK_DIRECTORY: '' })).toThrow(/EMAIL_SINK_DIRECTORY/);
    expect(loadSettings(env).emailSinkDirectory).toBe('/var/lib/ekdotico/mail');
    const local = { ...env, APP_ORIGIN: 'http://localhost:3000', EMAIL_SINK_DIRECTORY: undefined };
    expect(loadSettings(local).emailSinkDirectory).toBe('.local/mail');
  });

  it('holds the two limits of a password as settings (FR-AU-82)', () => {
    expect(loadSettings(env)).toMatchObject({ passwordMinLength: 8, passwordMaxLength: 32 });
    expect(loadSettings({ ...env, PASSWORD_MIN_LENGTH: '20' }).passwordMinLength).toBe(20);
  });

  // NFR-SE-17 (b), (c): the identity library reads these whatever the
  // application configures. The web application and the collaboration server
  // both start through here.
  it.each(['BETTER_AUTH_TELEMETRY', 'BETTER_AUTH_TRUSTED_ORIGINS', 'BETTER_AUTH_SECRET', 'BETTER_AUTH_'])(
    'refuses to start where %s is set, and names it without its value',
    (name) => {
      const load = () => loadSettings({ ...env, [name]: 'https://elsewhere.example' });
      expect(load).toThrow(name);
      expect(load).not.toThrow(/elsewhere/);
    },
  );

  // NFR-SE-07: a limit under a misspelt name would change nothing, in silence.
  it.each(['RATE_LIMIT_API_PER_USR', 'RATE_LIMIT_', 'RATE_LIMIT_api_per_user', 'RATE_LIMIT_toString'])(
    'refuses to start where %s is set, which names no limit, and does not repeat its value',
    (name) => {
      const load = () => loadSettings({ ...env, [name]: '1000000/1' });
      expect(load).toThrow(name);
      expect(load).not.toThrow(/1000000/);
    },
  );
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

  // FR-ED-36: "retained for 30 days (an initial value)".
  it('retains a deleted document for 30 days, or for the days it is told', () => {
    expect(settings.deletedDocumentRetentionDays).toBe(30);
    expect(loadSettings({ ...env, DELETED_DOCUMENT_RETENTION_DAYS: '7' }).deletedDocumentRetentionDays).toBe(
      7,
    );
  });

  // The days are subtracted from the present moment and added to the moment of
  // a deletion: about 100,000,001 of them give no date at all.
  it('retains a deleted document for at most 3,650 days, so that the end of a retention is always a date', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const { deletedDocumentRetentionDays: most } = loadSettings({
      ...env,
      DELETED_DOCUMENT_RETENTION_DAYS: '3650',
    });
    expect(most).toBe(3650);
    expect(Number.isNaN(new Date(Date.now() - most * DAY_MS).getTime())).toBe(false);
    for (const days of ['3651', '100000001', '9'.repeat(400)]) {
      expect(() => loadSettings({ ...env, DELETED_DOCUMENT_RETENTION_DAYS: days })).toThrow(
        'DELETED_DOCUMENT_RETENTION_DAYS must be no more than 3650.',
      );
    }
  });

  it('trusts no proxy unless told how many there are, which only localhost admits', () => {
    const local = { ...env, APP_ORIGIN: 'http://localhost:3000', TRUSTED_PROXY_COUNT: undefined };
    expect(loadSettings(local).trustedProxyCount).toBe(0);
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
    const changed = loadSettings({
      ...env,
      RATE_LIMIT_API_PER_USER: '10/5',
      SESSION_MAX_SECONDS: String(40 * 86400),
    });
    expect(changed.limits.API_PER_USER).toEqual({ max: 10, windowSeconds: 5 });
    expect(changed.sessionMaxSeconds).toBe(40 * 86400);
  });

  it.each(['10', '0/60', '10/0', '-1/60', '1e3/60', '10/60/1'])('refuses the limit %s', (value) => {
    expect(() => loadSettings({ ...env, RATE_LIMIT_API_PER_USER: value })).toThrow(/RATE_LIMIT_API_PER_USER/);
  });

  // NFR-RE-07 (register P14): both periods of the storing are settings.
  it('stores a document’s state 2 seconds after the last change, and every 10 seconds', () => {
    expect(settings).toMatchObject({ collabStoreDelayMs: 2000, collabStoreMaxMs: 10000 });
    const changed = loadSettings({ ...env, COLLAB_STORE_DELAY_MS: '1000', COLLAB_STORE_MAX_MS: '3000' });
    expect(changed).toMatchObject({ collabStoreDelayMs: 1000, collabStoreMaxMs: 3000 });
  });

  // FR-ED-23: "30 seconds (an initial value)".
  it('shows the error state of the editor after 30 seconds without a connection', () => {
    expect(settings.collabErrorAfterMs).toBe(30000);
    expect(loadSettings({ ...env, COLLAB_ERROR_AFTER_MS: '5000' }).collabErrorAfterMs).toBe(5000);
    expect(() => loadSettings({ ...env, COLLAB_ERROR_AFTER_MS: '0' })).toThrow(/COLLAB_ERROR_AFTER_MS/);
  });

  it('refuses a period of the storing too short for the write to fit in it', () => {
    expect(() => loadSettings({ ...env, COLLAB_STORE_DELAY_MS: '999' })).toThrow(/COLLAB_STORE_DELAY_MS/);
    expect(() => loadSettings({ ...env, COLLAB_STORE_DELAY_MS: '0' })).toThrow(/COLLAB_STORE_DELAY_MS/);
    expect(() => loadSettings({ ...env, COLLAB_STORE_DELAY_MS: '2s' })).toThrow(/COLLAB_STORE_DELAY_MS/);
    expect(() => loadSettings({ ...env, COLLAB_STORE_MAX_MS: '4999' })).toThrow(/COLLAB_STORE_MAX_MS/);
    expect(() => loadSettings({ ...env, COLLAB_STORE_MAX_MS: '5000' })).not.toThrow();
    // The second period is held to the first.
    expect(() => loadSettings({ ...env, COLLAB_STORE_DELAY_MS: '5000' })).toThrow(/COLLAB_STORE_MAX_MS/);
  });

  it.each(['-1', '1.5', 'seven', '1e3'])('refuses %s as a whole number', (value) => {
    expect(() => loadSettings({ ...env, TRUSTED_PROXY_COUNT: value })).toThrow(/TRUSTED_PROXY_COUNT/);
  });

  // A 0 here would switch a rule off without a word: a session that ends as it
  // begins, a log that keeps nothing, a password of no length, an invitation
  // that has expired before its email is read (FR-AU-89 (a)).
  it.each([
    'SESSION_IDLE_SECONDS',
    'SESSION_RENEW_SECONDS',
    'SESSION_MAX_SECONDS',
    'SECURITY_LOG_RETENTION_DAYS',
    'DELETED_DOCUMENT_RETENTION_DAYS',
    'PASSWORD_MIN_LENGTH',
    'PASSWORD_MAX_LENGTH',
    'ADMISSION_INVITATION_DAYS',
  ])('refuses 0 as %s', (name) => {
    expect(() => loadSettings({ ...env, [name]: '0' })).toThrow(`${name} must be a whole number, 1 or more.`);
  });

  it('admits 1 for each of them, and on localhost 0 proxies, and a signed copy that lives 0 seconds', () => {
    const least = loadSettings({
      ...env,
      APP_ORIGIN: 'http://localhost:3000',
      SESSION_IDLE_SECONDS: '1',
      SESSION_RENEW_SECONDS: '1',
      SESSION_MAX_SECONDS: '1',
      SECURITY_LOG_RETENTION_DAYS: '1',
      DELETED_DOCUMENT_RETENTION_DAYS: '1',
      PASSWORD_MIN_LENGTH: '1',
      PASSWORD_MAX_LENGTH: '1',
      ADMISSION_INVITATION_DAYS: '1',
      TRUSTED_PROXY_COUNT: '0',
      COOKIE_CACHE_SECONDS: '0',
    });
    expect(least).toMatchObject({ sessionMaxSeconds: 1, trustedProxyCount: 0, cookieCacheSeconds: 0 });
    expect(least.admissionInvitationDays).toBe(1);
    expect(loadSettings(env).admissionInvitationDays).toBe(30);
  });

  // docs/contracts/admission-signature.md, "The setting"; NFR-SE-17 (e).
  describe('ADMISSION_SECRET (FR-AU-89)', () => {
    const SECRET = 'A-secret_of-43-characters-for-the-tests-012';
    const failure = (value: string) => {
      try {
        loadSettings({ ...env, ADMISSION_SECRET: value });
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    };

    it('is the value exactly as set, where it is 43 characters or more of the URL-safe alphabet', () => {
      expect(SECRET).toHaveLength(43);
      expect(loadSettings({ ...env, ADMISSION_SECRET: SECRET }).admissionSecret).toBe(SECRET);
      expect(loadSettings({ ...env, ADMISSION_SECRET: `${SECRET}x` }).admissionSecret).toBe(`${SECRET}x`);
    });

    it('is none where it is unset or empty, so that every admission request is refused', () => {
      expect(loadSettings(env).admissionSecret).toBeUndefined();
      expect(loadSettings({ ...env, ADMISSION_SECRET: '' }).admissionSecret).toBeUndefined();
    });

    it.each([
      ['of 42 characters', SECRET.slice(1)],
      ['with a character outside the alphabet', `${SECRET.slice(1)}+`],
      ['with a space', `${SECRET.slice(1)} `],
    ])('stops the process for one %s, and never repeats it', (_, value) => {
      const message = failure(value);
      expect(message).toMatch(/^ADMISSION_SECRET must be at least 43 characters/);
      expect(message).not.toContain(value);
      expect(message).not.toContain(value.slice(0, 12));
    });

    it('stops the process where it is the identity secret, and repeats neither', () => {
      const message = (() => {
        try {
          loadSettings({ ...env, AUTH_SECRET: SECRET, ADMISSION_SECRET: SECRET });
        } catch (error) {
          return (error as Error).message;
        }
        return undefined;
      })();
      expect(message).toBe('ADMISSION_SECRET must differ from AUTH_SECRET.');
      // Two secrets that differ start it.
      expect(
        loadSettings({ ...env, AUTH_SECRET: `${SECRET}x`, ADMISSION_SECRET: SECRET }).admissionSecret,
      ).toBe(SECRET);
    });
  });

  it('refuses a least length of a password above the greatest (FR-AU-82)', () => {
    const load = (min: string, max: string) =>
      loadSettings({ ...env, PASSWORD_MIN_LENGTH: min, PASSWORD_MAX_LENGTH: max });
    expect(() => load('33', '32')).toThrow(/PASSWORD_MIN_LENGTH must be no more than PASSWORD_MAX_LENGTH/);
    expect(load('32', '32')).toMatchObject({ passwordMinLength: 32, passwordMaxLength: 32 });
  });

  it('refuses periods of a session that are out of order (FR-AU-84)', () => {
    const load = (renew: number, idle: number, max: number) =>
      loadSettings({
        ...env,
        SESSION_RENEW_SECONDS: String(renew),
        SESSION_IDLE_SECONDS: String(idle),
        SESSION_MAX_SECONDS: String(max),
      });
    expect(() => load(601, 600, 3600)).toThrow(/SESSION_RENEW_SECONDS must be no more than/);
    expect(() => load(60, 3601, 3600)).toThrow(/SESSION_IDLE_SECONDS no more than SESSION_MAX_SECONDS/);
    // The initial period of 7 days, with a life cut to an hour.
    expect(() => loadSettings({ ...env, SESSION_MAX_SECONDS: '3600' })).toThrow(/SESSION_MAX_SECONDS/);
    expect(load(600, 600, 600)).toMatchObject({ sessionRenewSeconds: 600, sessionMaxSeconds: 600 });
  });
});
