import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  loadSettings,
  refuseBuiltCollabRewrite,
  refuseSinkAwayFromDevelopment,
} from '../../src/lib/settings.ts';

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

// Register D270: the whole message, which an error with this message matches exactly.
const SINK_REFUSED = new Error(
  'EMAIL_TRANSPORT=sink is for a development machine: it writes each email to a file. Set EMAIL_TRANSPORT to brevo.',
);

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

  // The owner's decision of 9 October 2026: an entry that no account can have
  // as its address would match none, and exempt the account it was meant for.
  it.each([
    ['a full-width letter in its domain', 'listed@\u{ff45}xample.com'],
    ['a ligature in its domain', 'listed@of\u{fb01}ce.example'],
    ['a label that ends with a hyphen', 'listed@example-.com'],
    ['an empty label', 'listed@example..com'],
    ['no domain', 'listed'],
    ['a semicolon where a comma was meant', 'listed@example.com;other@example.com'],
  ])('refuses to start where an entry has %s, and says which without repeating it', (_what, entry) => {
    const start = () => loadSettings({ ...env, FOUNDING_TEAM_EMAILS: `One@Example.com, ${entry} ,` });
    expect(start).toThrow(
      new Error(
        'FOUNDING_TEAM_EMAILS: entry 2 is not an email address that an account can have. Write it in the form name@example.com, with its domain in plain letters, digits and hyphens.',
      ),
    );
    expect(start).not.toThrow('listed');
    expect(start).not.toThrow('One@');
  });

  it('starts with entries in Greek, each in its one spelling', () => {
    const greek = String.fromCodePoint(0x3c0, 0x3b1);
    const { foundingTeamEmails } = loadSettings({
      ...env,
      FOUNDING_TEAM_EMAILS: `A@${greek.toUpperCase()}.GR,b@Example.com`,
    });
    expect(foundingTeamEmails).toEqual([`a@${greek}.gr`, 'b@example.com']);
  });

  // The owner's decision of 12 October 2026 (its register row is pending).
  it('refuses to start where an entry has a label in punycode, in any case', () => {
    for (const entry of ['b@xn--bcher-kva.example', 'b@mail.XN--P1AI']) {
      expect(() => loadSettings({ ...env, FOUNDING_TEAM_EMAILS: `One@Example.com, ${entry}` })).toThrow(
        /FOUNDING_TEAM_EMAILS: entry 2 is not an email address/,
      );
    }
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

  // Register D262: Brevo or the local sink. A deployment must not lose its
  // email by leaving a setting out.
  it('refuses to start away from a development machine unless a sender is chosen', () => {
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
    // And what it is told first is the refusal of D270, not that a directory is missing.
    for (const EMAIL_SINK_DIRECTORY of [undefined, '']) {
      const start = () => loadSettings({ ...env, EMAIL_SINK_DIRECTORY });
      expect(start).toThrow(SINK_REFUSED);
      expect(start).not.toThrow(/EMAIL_SINK_DIRECTORY/);
    }
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

// Register D262: EMAIL_TRANSPORT is sink or brevo. NFR-SE-19: a settings error never repeats the key.
describe('loadSettings: the email transport', () => {
  const KEY = 'marker-key-d41f8cd98f00b204e980';
  const brevo = {
    ...env,
    EMAIL_TRANSPORT: 'brevo',
    EMAIL_SINK_DIRECTORY: undefined,
    EMAIL_FROM: 'Ekdotico <no-reply@ekdoti.co>',
    BREVO_API_KEY: KEY,
  };

  it('takes sink and brevo, and refuses anything else with a message that names both', () => {
    expect(loadSettings(env).emailTransport).toBe('sink');
    expect(loadSettings(brevo).emailTransport).toBe('brevo');
    // Away from a development machine only Brevo is admitted, and the message offers only that (D270).
    for (const value of ['scaleway', 'Brevo', 'SINK', ' sink', 'smtp']) {
      const away = () => loadSettings({ ...env, EMAIL_TRANSPORT: value });
      expect(away).toThrow(/^EMAIL_TRANSPORT must be set to brevo\.$/);
      const here = () =>
        loadSettings({ ...env, APP_ORIGIN: 'http://localhost:3000', EMAIL_TRANSPORT: value });
      expect(here).toThrow(/^EMAIL_TRANSPORT must be set to sink or brevo\.$/);
    }
  });

  it('means the sink where it is unset on localhost, and Brevo needs a choice away from it', () => {
    const local = { ...env, APP_ORIGIN: 'http://localhost:3000', EMAIL_TRANSPORT: undefined };
    expect(loadSettings(local).emailTransport).toBe('sink');
    for (const EMAIL_TRANSPORT of [undefined, '']) {
      expect(() => loadSettings({ ...env, EMAIL_TRANSPORT })).toThrow(
        /^EMAIL_TRANSPORT must be set to brevo\.$/,
      );
    }
  });

  it('loads the sink away from localhost, as the tests need, with its directory required', () => {
    expect(loadSettings(env)).toMatchObject({
      emailTransport: 'sink',
      emailSender: undefined,
      brevoApiKey: undefined,
    });
    expect(() => loadSettings({ ...env, EMAIL_SINK_DIRECTORY: undefined })).toThrow(SINK_REFUSED);
    // The sink needs neither the key nor a sender that parses.
    expect(loadSettings({ ...env, EMAIL_FROM: 'someone@localhost' }).emailFrom).toBe('someone@localhost');
  });

  it('starts with Brevo, away from localhost, with the key and a sender, and no directory', () => {
    const settings = loadSettings(brevo);
    expect(settings.emailTransport).toBe('brevo');
    expect(settings.brevoApiKey).toBe(KEY);
    expect(settings.emailSender).toEqual({ name: 'Ekdotico', email: 'no-reply@ekdoti.co' });
    expect(loadSettings({ ...brevo, EMAIL_SINK_DIRECTORY: '/var/lib/ekdotico/mail' }).emailTransport).toBe(
      'brevo',
    );
    expect(loadSettings({ ...brevo, APP_ORIGIN: 'http://localhost:3000' }).emailTransport).toBe('brevo');
  });

  it.each([
    ['not set', undefined],
    ['empty', ''],
    ['with a space in it', `${KEY} ${KEY}`],
    ['with a line break at its end', `${KEY}\n`],
    ['with a carriage return', `${KEY}\r`],
    ['with a tab', `${KEY}\t`],
    ['with a letter outside ASCII', `${KEY}é`],
  ])('refuses Brevo with a key that is %s, and never repeats it', (_name, key) => {
    const start = () => loadSettings({ ...brevo, BREVO_API_KEY: key });
    expect(start).toThrow(/BREVO_API_KEY/);
    expect(start).not.toThrow(new RegExp(KEY));
  });

  it.each([
    ['not set', undefined],
    ['empty', ''],
    ['an address alone', 'no-reply@ekdoti.co'],
    ['a name alone', 'Ekdotico'],
    ['a name and no address', 'Ekdotico <>'],
    ['an address that cannot be one', 'Ekdotico <no-reply>'],
    ['an address with two parts', 'Ekdotico <a@ekdoti.co b@ekdoti.co>'],
    ['text after the address', 'Ekdotico <no-reply@ekdoti.co> (no replies)'],
    ['a line break', 'Ekdotico\r\nBcc: x@ekdoti.co <no-reply@ekdoti.co>'],
    ['a quote in the name', 'Ek"dotico <no-reply@ekdoti.co>'],
  ])('refuses Brevo with a sender that is %s', (_name, from) => {
    const start = () => loadSettings({ ...brevo, EMAIL_FROM: from });
    expect(start).toThrow(/^EMAIL_FROM /);
    expect(start).not.toThrow(new RegExp(KEY));
  });

  it.each([
    'Ekdotico <no-reply@localhost>',
    'Ekdotico <no-reply@mail.localhost>',
    'Ekdotico <no-reply@LOCALHOST>',
  ])('refuses Brevo with the sender %s', (from) => {
    expect(() => loadSettings({ ...brevo, EMAIL_FROM: from })).toThrow(
      /^EMAIL_FROM must not use localhost with Brevo\.$/,
    );
  });

  // NFR-SE-17 (e): the secrets differ, so that one that leaks opens one door, and a paste that put another
  // secret here would send it to Brevo in a header.
  it.each([
    ['AUTH_SECRET', { AUTH_SECRET: KEY.repeat(2) }],
    ['ADMISSION_SECRET', { ADMISSION_SECRET: KEY.repeat(2) }],
    [
      'IMAGE_STORAGE_SECRET_ACCESS_KEY',
      {
        IMAGE_STORAGE_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
        IMAGE_STORAGE_BUCKET: 'ekdotico-images',
        IMAGE_STORAGE_ACCESS_KEY_ID: 'an-access-key-id',
        IMAGE_STORAGE_SECRET_ACCESS_KEY: KEY.repeat(2),
      },
    ],
  ])('refuses a key that is the value of %s, and never repeats it', (_name, other) => {
    const key = KEY.repeat(2);
    const start = () => loadSettings({ ...brevo, BREVO_API_KEY: key, ...other });
    expect(start).toThrow(/must differ from/);
    expect(start).not.toThrow(new RegExp(KEY));
  });

  it('refuses a sender name of more than 70 characters, and an IP address for a domain', () => {
    expect(
      loadSettings({ ...brevo, EMAIL_FROM: `${'n'.repeat(70)} <no-reply@ekdoti.co>` }).emailTransport,
    ).toBe('brevo');
    expect(() => loadSettings({ ...brevo, EMAIL_FROM: `${'n'.repeat(71)} <no-reply@ekdoti.co>` })).toThrow(
      /^EMAIL_FROM must have a name of no more than 70 characters\.$/,
    );
    for (const address of [
      'no-reply@127.0.0.1',
      'no-reply@192.0.2.7',
      'no-reply@[::1]',
      'no-reply@[192.0.2.7]',
    ]) {
      expect(() => loadSettings({ ...brevo, EMAIL_FROM: `Ekdotico <${address}>` })).toThrow(
        /^EMAIL_FROM must /,
      );
    }
  });

  // The collaboration server sends no email, so it neither holds nor checks the key.
  it('is loaded by the collaboration server with no key, no sender, and nothing to check of them', () => {
    const without = { ...brevo, BREVO_API_KEY: undefined, EMAIL_FROM: undefined };
    const collab = loadSettings(without, false);
    expect(collab).toMatchObject({ emailTransport: 'brevo', brevoApiKey: undefined, emailSender: undefined });
    // Even where the key is in its environment, it is not held, and its faults are not that process's.
    const held = loadSettings({ ...brevo, BREVO_API_KEY: 'with a space', EMAIL_FROM: 'nonsense' }, false);
    expect(held.brevoApiKey).toBeUndefined();
    expect(() => loadSettings(without)).toThrow(/BREVO_API_KEY is not set/);
    // It still refuses a transport that is none, as before.
    expect(() => loadSettings({ ...env, EMAIL_TRANSPORT: 'smtp' }, false)).toThrow(
      /^EMAIL_TRANSPORT must be set to brevo\.$/,
    );
  });

  it('is what the collaboration server starts with: collabSettings, and nowhere else', () => {
    const entry = readFileSync('src/collab/server.ts', 'utf8');
    expect(entry).toMatch(/const loaded = collabSettings\(\);/);
    expect(entry).toMatch(/createCollabServer\(loaded\)/);
    expect(entry).not.toMatch(/createCollabServer\(settings\(\)\)/);
    // Register D270: the same refusal of the sink as the web application's, before the server is made.
    expect(entry.indexOf('refuseSinkAwayFromDevelopment(loaded)')).toBeGreaterThan(
      entry.indexOf('collabSettings();'),
    );
    expect(entry.indexOf('refuseSinkAwayFromDevelopment(loaded)')).toBeLessThan(
      entry.indexOf('createCollabServer(loaded)'),
    );
  });

  it('does not require the key where the sink is chosen, and ignores one', () => {
    expect(loadSettings({ ...env, BREVO_API_KEY: undefined }).brevoApiKey).toBeUndefined();
    expect(loadSettings({ ...env, BREVO_API_KEY: KEY }).brevoApiKey).toBeUndefined();
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

  // FR-AU-83: "within 10 minutes of the password (an initial value)"; NFR-SE-07: 5 wrong codes.
  it('gives the second step of a sign-in 10 minutes and 5 wrong codes, and takes another of each', () => {
    expect(settings).toMatchObject({ secondStepSeconds: 600, secondStepWrongCodes: 5 });
    const changed = loadSettings({ ...env, TWO_FACTOR_STEP_SECONDS: '120', TWO_FACTOR_WRONG_CODES: '3' });
    expect(changed).toMatchObject({ secondStepSeconds: 120, secondStepWrongCodes: 3 });
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

  // NFR-SE-18: "100 MB (an initial value)" of images for a document, and "within 30 days (an initial value)".
  it('holds 100 MB of images for a document and deletes an image 30 days after it left, or as it is told', () => {
    expect(settings.imageDocumentBytes).toBe(100 * 1024 * 1024);
    expect(settings.imageUnreferencedDays).toBe(30);
    const set = loadSettings({ ...env, IMAGE_DOCUMENT_MEGABYTES: '5', IMAGE_UNREFERENCED_DAYS: '7' });
    expect(set.imageDocumentBytes).toBe(5 * 1024 * 1024);
    expect(set.imageUnreferencedDays).toBe(7);
  });

  it.each(['IMAGE_DOCUMENT_MEGABYTES', 'IMAGE_UNREFERENCED_DAYS'])('refuses 0, and text, as %s', (name) => {
    for (const value of ['0', '-1', '1.5', 'ten']) {
      expect(() => loadSettings({ ...env, [name]: value })).toThrow(
        `${name} must be a whole number, 1 or more.`,
      );
    }
  });

  describe('the object store of the images (NFR-SE-18; S19-1, S19-4)', () => {
    const SECRET = 'a-secret-access-key-that-is-distinct';
    const spaces = {
      IMAGE_STORAGE_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
      IMAGE_STORAGE_BUCKET: 'ekdotico-images',
      IMAGE_STORAGE_ACCESS_KEY_ID: 'DO00ACCESSKEY',
      IMAGE_STORAGE_SECRET_ACCESS_KEY: SECRET,
    };
    const local = {
      ...spaces,
      IMAGE_STORAGE_ENDPOINT: 'http://localhost:9000',
      APP_ORIGIN: 'http://localhost:3000',
      TRUSTED_PROXY_COUNT: undefined,
    };

    it('is none where none of its settings is given', () => {
      expect(loadSettings(env).imageStorage).toBeUndefined();
      expect(loadSettings({ ...env, IMAGE_STORAGE_BUCKET: '' }).imageStorage).toBeUndefined();
    });

    it('has the bucket in the host of an address for Spaces, and the origin of a link is the bucket’s', () => {
      expect(loadSettings({ ...env, ...spaces }).imageStorage).toEqual({
        endpoint: 'https://fra1.digitaloceanspaces.com',
        bucket: 'ekdotico-images',
        region: 'fra1',
        accessKeyId: 'DO00ACCESSKEY',
        secretAccessKey: SECRET,
        pathStyle: false,
        origin: 'https://ekdotico-images.fra1.digitaloceanspaces.com',
      });
    });

    it('has the bucket in the path on a store of this machine, and the origin of a link is the store’s', () => {
      expect(loadSettings({ ...env, ...local }).imageStorage).toMatchObject({
        pathStyle: true,
        origin: 'http://localhost:9000',
        region: 'fra1',
      });
      expect(loadSettings({ ...env, ...local, IMAGE_STORAGE_REGION: 'us-east-1' }).imageStorage?.region).toBe(
        'us-east-1',
      );
    });

    it('refuses to start where some are given and not all, by name and never by value', () => {
      for (const name of Object.keys(spaces)) {
        const rest = Object.fromEntries(Object.entries(spaces).filter(([each]) => each !== name));
        const start = () => loadSettings({ ...env, ...rest });
        expect(start).toThrow(`${name} is not set: the object store needs all four settings.`);
        expect(start).not.toThrow(new RegExp(`${SECRET}|DO00ACCESSKEY|digitaloceanspaces`));
      }
    });

    it.each([
      [
        'an endpoint that is not an origin',
        { IMAGE_STORAGE_ENDPOINT: 'https://fra1.digitaloceanspaces.com/bucket' },
        'IMAGE_STORAGE_ENDPOINT must be an origin',
      ],
      [
        'an endpoint with a trailing slash',
        { IMAGE_STORAGE_ENDPOINT: 'https://fra1.digitaloceanspaces.com/' },
        'IMAGE_STORAGE_ENDPOINT must be an origin',
      ],
      [
        'an endpoint that is not an address',
        { IMAGE_STORAGE_ENDPOINT: 'fra1.digitaloceanspaces.com' },
        'IMAGE_STORAGE_ENDPOINT must be an origin',
      ],
      [
        'an endpoint over http away from localhost',
        { IMAGE_STORAGE_ENDPOINT: 'http://store.example.test' },
        'IMAGE_STORAGE_ENDPOINT must use https, except on localhost.',
      ],
      [
        'a bucket with a capital',
        { IMAGE_STORAGE_BUCKET: 'Images' },
        'IMAGE_STORAGE_BUCKET must be a bucket name',
      ],
      [
        'a bucket with a dot',
        { IMAGE_STORAGE_BUCKET: 'a.b.c' },
        'IMAGE_STORAGE_BUCKET must be a bucket name',
      ],
      [
        'a bucket that is a path',
        { IMAGE_STORAGE_BUCKET: '../x' },
        'IMAGE_STORAGE_BUCKET must be a bucket name',
      ],
      ['a region that is not one', { IMAGE_STORAGE_REGION: 'FRA 1' }, 'IMAGE_STORAGE_REGION must be'],
      [
        'the secret of the application’s own',
        { IMAGE_STORAGE_SECRET_ACCESS_KEY: env.AUTH_SECRET },
        'IMAGE_STORAGE_SECRET_ACCESS_KEY must differ',
      ],
    ])('refuses %s', (_name, change, message) => {
      expect(() => loadSettings({ ...env, ...spaces, ...change })).toThrow(message);
    });

    it('refuses a secret that is the admission secret', () => {
      const admission = 'A'.repeat(43);
      expect(() =>
        loadSettings({
          ...env,
          ...spaces,
          ADMISSION_SECRET: admission,
          IMAGE_STORAGE_SECRET_ACCESS_KEY: admission,
        }),
      ).toThrow('IMAGE_STORAGE_SECRET_ACCESS_KEY must differ');
    });

    it('lets a link be valid for 5 minutes, or as long as it is told, and for no more than an hour', () => {
      expect(settings.imageLinkSeconds).toBe(300);
      expect(loadSettings({ ...env, IMAGE_LINK_SECONDS: '60' }).imageLinkSeconds).toBe(60);
      expect(loadSettings({ ...env, IMAGE_LINK_SECONDS: '3600' }).imageLinkSeconds).toBe(3600);
      expect(() => loadSettings({ ...env, IMAGE_LINK_SECONDS: '3601' })).toThrow(
        'IMAGE_LINK_SECONDS must be no more than 3600.',
      );
      expect(() => loadSettings({ ...env, IMAGE_LINK_SECONDS: '0' })).toThrow(
        'IMAGE_LINK_SECONDS must be a whole number, 1 or more.',
      );
    });
  });

  it('trusts no proxy unless told how many there are, which only localhost admits', () => {
    const local = { ...env, APP_ORIGIN: 'http://localhost:3000', TRUSTED_PROXY_COUNT: undefined };
    expect(loadSettings(local).trustedProxyCount).toBe(0);
  });

  it('holds the limits of NFR-SE-07', () => {
    expect(settings.limits).toEqual({
      API_PER_USER: { max: 120, windowSeconds: 60 },
      INVITATIONS_PER_USER: { max: 20, windowSeconds: 3600 },
      OFFERS_PER_USER: { max: 20, windowSeconds: 3600 },
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
      // The owner's decision of 12 October 2026: a row to be added to NFR-SE-07.
      FEEDBACK_SHORT_PER_USER: { max: 5, windowSeconds: 600 },
      FEEDBACK_DAY_PER_USER: { max: 30, windowSeconds: 86400 },
      COLLAB_MESSAGES_PER_USER: { max: 600, windowSeconds: 60 },
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

  // deployment.md, item 8: the collaboration server is reached through the proxy alone, so it listens on the loopback.
  it('has the collaboration server listen on 127.0.0.1 unless COLLAB_HOST is an IP address', () => {
    expect(settings.collabHost).toBe('127.0.0.1');
    expect(loadSettings({ ...env, COLLAB_HOST: '10.0.0.5' }).collabHost).toBe('10.0.0.5');
    expect(loadSettings({ ...env, COLLAB_HOST: '::1' }).collabHost).toBe('::1');
    expect(loadSettings({ ...env, COLLAB_HOST: '' }).collabHost).toBe('127.0.0.1');
    // 0.0.0.0 and :: are every interface: one line of configuration would bring the exposure back.
    for (const bad of [
      'localhost',
      'example.com',
      '10.0.0',
      '0.0.0.0/0',
      '0.0.0.0',
      '::',
      '0:0:0:0:0:0:0:0',
      '::0',
      '::%lo0',
      '::ffff:0.0.0.0',
      '::FFFF:0.0.0.0',
      '::ffff:0:0',
      '0:0:0:0:0:ffff:0:0',
      '0000:0000:0000:0000:0000:ffff:0000:0000',
    ])
      expect(() => loadSettings({ ...env, COLLAB_HOST: bad })).toThrow(/COLLAB_HOST/);
  });

  // FR-ED-23: "30 seconds (an initial value)".
  it('shows the error state of the editor after 30 seconds without a connection', () => {
    expect(settings.collabErrorAfterMs).toBe(30000);
    expect(loadSettings({ ...env, COLLAB_ERROR_AFTER_MS: '5000' }).collabErrorAfterMs).toBe(5000);
    expect(() => loadSettings({ ...env, COLLAB_ERROR_AFTER_MS: '0' })).toThrow(/COLLAB_ERROR_AFTER_MS/);
  });

  // FR-EX-36: "30 seconds" and "100 characters", both initial values and so settings.
  it('aborts a response that sent nothing for 30 seconds, and cuts a name to 100 characters', () => {
    expect(settings.exportIdleSeconds).toBe(30);
    expect(loadSettings({ ...env, EXPORT_IDLE_SECONDS: '5' }).exportIdleSeconds).toBe(5);
    for (const value of ['0', '-1', '1.5', '30s']) {
      expect(() => loadSettings({ ...env, EXPORT_IDLE_SECONDS: value }), value).toThrow(
        /EXPORT_IDLE_SECONDS/,
      );
    }
    expect(settings.exportNameMaxChars).toBe(100);
    expect(loadSettings({ ...env, EXPORT_NAME_MAX_CHARS: '200' }).exportNameMaxChars).toBe(200);
    for (const value of ['0', '201', '-1', '1.5', '100c']) {
      expect(() => loadSettings({ ...env, EXPORT_NAME_MAX_CHARS: value }), value).toThrow(
        /EXPORT_NAME_MAX_CHARS/,
      );
    }
  });

  // D275: the check of the application's timers is off unless its address is set, and the address is at
  // hc-ping.com alone. The refusal names the setting and never the value.
  it('checks the timers in only where HEALTHCHECK_TIMERS_URL is a ping address', () => {
    expect(settings.healthcheckTimersUrl).toBeUndefined();
    const ping = 'https://hc-ping.com/00000000-0000-4000-8000-000000000000';
    expect(loadSettings({ ...env, HEALTHCHECK_TIMERS_URL: ping }).healthcheckTimersUrl).toBe(ping);
    const wrong = 'https://evil.example/00000000-0000-4000-8000-000000000000';
    let message = '';
    try {
      loadSettings({ ...env, HEALTHCHECK_TIMERS_URL: wrong });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('HEALTHCHECK_TIMERS_URL');
    expect(message).not.toContain('evil.example');
    // D320: the check of email health is the same, under its own name.
    expect(settings.healthcheckEmailUrl).toBeUndefined();
    expect(loadSettings({ ...env, HEALTHCHECK_EMAIL_URL: ping }).healthcheckEmailUrl).toBe(ping);
    expect(() => loadSettings({ ...env, HEALTHCHECK_EMAIL_URL: wrong })).toThrow(/HEALTHCHECK_EMAIL_URL/);
  });

  // FR-ED-41: "at least once every 60 seconds": a setting may make it more often and never less.
  it('re-checks every open connection every 60 seconds, and never less often, nor more often than once a second', () => {
    expect(settings.collabRecheckMs).toBe(60_000);
    expect(loadSettings({ ...env, COLLAB_RECHECK_MS: '3000' }).collabRecheckMs).toBe(3000);
    expect(loadSettings({ ...env, COLLAB_RECHECK_MS: '60000' }).collabRecheckMs).toBe(60_000);
    expect(loadSettings({ ...env, COLLAB_RECHECK_MS: '1000' }).collabRecheckMs).toBe(1000);
    for (const value of ['60001', '120000', '999', '1', '0', '-1', '1s', '1.5']) {
      expect(() => loadSettings({ ...env, COLLAB_RECHECK_MS: value }), value).toThrow(/COLLAB_RECHECK_MS/);
    }
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
    'DOCUMENT_INVITATION_DAYS',
    'OWNERSHIP_OFFER_DAYS',
    'CLEARING_NOTICE_DAYS',
    'INVITATION_REMINDER_DAYS',
    'DOCUMENT_INVITATION_ADDRESS_DAYS',
    'TWO_FACTOR_STEP_SECONDS',
    'TWO_FACTOR_WRONG_CODES',
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
    expect(loadSettings(env).documentInvitationDays).toBe(14);
    // FR-ED-47: 14 days, "an initial value".
    expect(loadSettings(env).ownershipOfferDays).toBe(14);
    expect(loadSettings({ ...env, OWNERSHIP_OFFER_DAYS: '3' }).ownershipOfferDays).toBe(3);
    // FR-AU-91: 7 days of notice, "an initial value, and a setting".
    expect(loadSettings(env).clearingNoticeDays).toBe(7);
    expect(loadSettings({ ...env, CLEARING_NOTICE_DAYS: '2' }).clearingNoticeDays).toBe(2);
    // FR-ED-48: 3 days, and FR-ED-37: 30 days, each "an initial value".
    expect(loadSettings(env).invitationReminderDays).toBe(3);
    expect(loadSettings(env).documentInvitationAddressDays).toBe(30);
    expect(loadSettings({ ...env, INVITATION_REMINDER_DAYS: '1' }).invitationReminderDays).toBe(1);
    expect(
      loadSettings({ ...env, DOCUMENT_INVITATION_ADDRESS_DAYS: '7' }).documentInvitationAddressDays,
    ).toBe(7);
  });

  // FR-ED-48, S18-3: a reminder as long as the invitation, or longer, would come with the invitation's
  // own email or never, and says nothing.
  it('refuses a reminder period of the invitation period or more, and admits less', () => {
    const refusal = 'INVITATION_REMINDER_DAYS must be less than DOCUMENT_INVITATION_DAYS.';
    expect(() => loadSettings({ ...env, INVITATION_REMINDER_DAYS: '14' })).toThrow(refusal);
    expect(() => loadSettings({ ...env, INVITATION_REMINDER_DAYS: '15' })).toThrow(refusal);
    expect(() => loadSettings({ ...env, DOCUMENT_INVITATION_DAYS: '3' })).toThrow(refusal);
    expect(loadSettings({ ...env, INVITATION_REMINDER_DAYS: '13' }).invitationReminderDays).toBe(13);
    expect(
      loadSettings({ ...env, DOCUMENT_INVITATION_DAYS: '2', INVITATION_REMINDER_DAYS: '1' }),
    ).toMatchObject({ documentInvitationDays: 2, invitationReminderDays: 1 });
  });

  // FR-ED-37, §2.7: 30 days is the retention the schedule states for the invited address.
  it('refuses an address period longer than the 30 days of §2.7, and admits 30 and less', () => {
    expect(() => loadSettings({ ...env, DOCUMENT_INVITATION_ADDRESS_DAYS: '31' })).toThrow(
      'DOCUMENT_INVITATION_ADDRESS_DAYS must be no more than 30 (§2.7).',
    );
    expect(
      loadSettings({ ...env, DOCUMENT_INVITATION_ADDRESS_DAYS: '30' }).documentInvitationAddressDays,
    ).toBe(30);
    expect(
      loadSettings({ ...env, DOCUMENT_INVITATION_ADDRESS_DAYS: '1' }).documentInvitationAddressDays,
    ).toBe(1);
  });

  // FR-AU-81, NFR-SE-07: a lock that ended while its failures were still
  // counted would begin again, with its email, at each single failure.
  describe('SIGN_IN_LOCK_SECONDS and the period of RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL', () => {
    const refusal =
      'SIGN_IN_LOCK_SECONDS must be no less than the seconds of RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL.';

    it.each([
      [{ SIGN_IN_LOCK_SECONDS: '3599' }],
      [{ SIGN_IN_LOCK_SECONDS: '1' }],
      [{ RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: '20/3601' }],
      [{ SIGN_IN_LOCK_SECONDS: '600', RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: '20/601' }],
    ])('refuses a lock shorter than the period its failures are counted in: %o', (changed) => {
      expect(() => loadSettings({ ...env, ...changed })).toThrow(new Error(refusal));
    });

    it.each([
      [{}, 3600],
      [{ SIGN_IN_LOCK_SECONDS: '3600' }, 3600],
      [{ SIGN_IN_LOCK_SECONDS: '7200' }, 7200],
      [{ SIGN_IN_LOCK_SECONDS: '600', RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: '20/600' }, 600],
      [{ SIGN_IN_LOCK_SECONDS: '600', RATE_LIMIT_FAILED_SIGN_IN_PER_EMAIL: '5/60' }, 600],
    ])('admits one as long as the period, or longer: %o', (changed, seconds) => {
      expect(loadSettings({ ...env, ...changed }).signInLockSeconds).toBe(seconds);
    });

    it('still refuses 0', () => {
      expect(() => loadSettings({ ...env, SIGN_IN_LOCK_SECONDS: '0' })).toThrow(
        'SIGN_IN_LOCK_SECONDS must be a whole number, 1 or more.',
      );
    });
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

// docs/operations/deployment.md, item 9: the development rewrite of `/collab`
// is refused at the start of a process that is not on localhost, by the
// setting and by what the build holds, since `next start` reads the build.
describe('the development rewrite of /collab, at the start of a process', () => {
  const target = 'http://127.0.0.1:1234';
  const manifest = (afterFiles: unknown[]) =>
    JSON.stringify({ version: 3, rewrites: { beforeFiles: [], afterFiles, fallback: [] } });
  const rewrite = { source: '/collab', destination: `${target}/collab`, regex: '^/collab(?:/)?$' };

  it('is refused by its setting where the origin is not on localhost', () => {
    expect(() => loadSettings({ ...env, COLLAB_PROXY_TARGET: target })).toThrow(
      /COLLAB_PROXY_TARGET is for a development machine/,
    );
    expect(() => loadSettings({ ...env, COLLAB_PROXY_TARGET: target })).not.toThrow(/127\.0\.0\.1/);
    expect(loadSettings({ ...env, COLLAB_PROXY_TARGET: '' }).appOrigin).toBe(env.APP_ORIGIN);
  });

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000'])('is admitted on %s', (origin) => {
    expect(loadSettings({ ...env, APP_ORIGIN: origin, COLLAB_PROXY_TARGET: target }).appOrigin).toBe(origin);
    expect(() => refuseBuiltCollabRewrite(origin, manifest([rewrite]))).not.toThrow();
  });

  it('is refused where the build holds it and the origin is not on localhost', () => {
    const refused = /This build passes \/collab to the collaboration server itself/;
    expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, manifest([rewrite]))).toThrow(refused);
    expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, manifest([rewrite]))).not.toThrow(/127\.0\.0\.1/);
    expect(() =>
      refuseBuiltCollabRewrite(env.APP_ORIGIN, manifest([{ source: '/collab/:path*', destination: target }])),
    ).toThrow(refused);
    // The older form of the manifest, a list; and each of the three lists of this one.
    expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, JSON.stringify({ rewrites: [rewrite] }))).toThrow(
      refused,
    );
    for (const list of ['beforeFiles', 'fallback']) {
      expect(() =>
        refuseBuiltCollabRewrite(env.APP_ORIGIN, JSON.stringify({ rewrites: { [list]: [rewrite] } })),
      ).toThrow(refused);
    }
    // A rewrite that cannot be read is not taken for another path.
    expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, manifest([{}]))).toThrow(refused);
  });

  it('admits a build without it', () => {
    expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, manifest([]))).not.toThrow();
    expect(() =>
      refuseBuiltCollabRewrite(env.APP_ORIGIN, manifest([{ source: '/collaborators', destination: '/x' }])),
    ).not.toThrow();
  });

  // A build that is not where it is looked for cannot be checked, so it does
  // not pass: only a development machine starts without one.
  it('refuses the absence of a build where the origin is not on localhost, and admits it there', () => {
    expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, null)).toThrow(
      /routes manifest of the build was not found/,
    );
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000']) {
      expect(() => refuseBuiltCollabRewrite(origin, null)).not.toThrow();
    }
  });

  it.each(['', 'not JSON', '{}', '{"rewrites":null}', '{"rewrites":"none"}'])(
    'refuses a manifest that cannot be read (%j)',
    (text) => {
      expect(() => refuseBuiltCollabRewrite(env.APP_ORIGIN, text)).toThrow(
        /routes manifest of the build cannot be read/,
      );
    },
  );
});

// Register D270: the sink is refused anywhere but a development machine, by the rule the other settings use for
// one (an origin on localhost), at the start of a process (src/instrumentation.ts).
describe('refuseSinkAwayFromDevelopment', () => {
  const LOCAL = ['http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost'];
  const AWAY = ['https://app.example.test', 'https://app.ekdoti.co', 'https://localhost.example.test'];

  it.each(AWAY)('refuses the sink on %s, with a message that names the setting', (appOrigin) => {
    const start = () => refuseSinkAwayFromDevelopment({ appOrigin, emailTransport: 'sink' });
    expect(start).toThrow(/^EMAIL_TRANSPORT=sink is for a development machine/);
    expect(start).toThrow(/Set EMAIL_TRANSPORT to brevo/);
  });

  it.each(AWAY)('admits Brevo on %s', (appOrigin) => {
    expect(() => refuseSinkAwayFromDevelopment({ appOrigin, emailTransport: 'brevo' })).not.toThrow();
  });

  it.each(LOCAL)('admits the sink, and Brevo, on %s', (appOrigin) => {
    expect(() => refuseSinkAwayFromDevelopment({ appOrigin, emailTransport: 'sink' })).not.toThrow();
    expect(() => refuseSinkAwayFromDevelopment({ appOrigin, emailTransport: 'brevo' })).not.toThrow();
  });

  // The same rule, and not a copy of it: the origins that loadSettings admits without a proxy are the ones that admit the sink.
  it.each([...LOCAL, ...AWAY])('draws the line where loadSettings does, for %s', (appOrigin) => {
    const withoutProxy = () =>
      loadSettings({ ...env, APP_ORIGIN: appOrigin, TRUSTED_PROXY_COUNT: undefined });
    const sink = () => refuseSinkAwayFromDevelopment({ appOrigin, emailTransport: 'sink' });
    if (LOCAL.includes(appOrigin)) {
      expect(withoutProxy).not.toThrow();
      expect(sink).not.toThrow();
    } else {
      expect(withoutProxy).toThrow(/TRUSTED_PROXY_COUNT/);
      expect(sink).toThrow(/EMAIL_TRANSPORT=sink/);
    }
  });

  it('refuses the settings that a process loads with the sink on an origin that is not local', () => {
    const loaded = loadSettings(env);
    expect(loaded.emailTransport).toBe('sink');
    expect(() => refuseSinkAwayFromDevelopment(loaded)).toThrow(/EMAIL_TRANSPORT=sink/);
  });
});
