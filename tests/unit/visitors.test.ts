// The page for a visitor who is not signed in (FR-AU-93; register D327 to D330,
// docs commit 258a536). The texts are written out here a second time, from the
// owner's approval (answer "approve" to `visitor-text` and "list-only" to
// `visitor-line-no-address`, 17 November 2026), and not taken from the code
// under test: a word changed there fails here until the owner has approved it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadSettings } from '../../src/lib/settings.ts';
import {
  ADD_ADDRESS_LINK,
  ALREADY_INVITED,
  askLine,
  SIGN_IN_LINK,
  VISITORS_INTRO,
  VISITORS_PATH,
  VISITORS_TITLE,
  WAITING_LIST_URL,
} from '../../src/lib/visitors.ts';
import { classify, SESSIONLESS } from '../../src/proxy.ts';
import nextConfig from '../../next.config.ts';

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

const WITHOUT_ADDRESS = 'To ask for one, add your email address to the list.';
const WITH_ADDRESS = (address: string) =>
  `To ask for one, add your email address to the list, or write to ${address}.`;

/** The line as a reader gets it, with the address in place. */
const line = (address: string | undefined) => {
  const { before, after } = askLine(address);
  return `${before}${address ?? ''}${after}`;
};

describe('the tab title of the page', () => {
  it('is the approved text alone, with no suffix', () => {
    const page = readFileSync('src/app/(auth)/visitors-page/page.tsx', 'utf8');
    expect(VISITORS_TITLE).toBe('Ekdotico is in Closed α');
    expect(page).toContain('export const metadata: Metadata = { title: { absolute: VISITORS_TITLE } };');
  });
});

describe('the approved text of the page (D330)', () => {
  it('is, whole', () => {
    expect({
      title: VISITORS_TITLE,
      intro: VISITORS_INTRO,
      add: ADD_ADDRESS_LINK,
      invited: ALREADY_INVITED,
      signIn: SIGN_IN_LINK,
    }).toEqual({
      title: 'Ekdotico is in Closed α',
      intro:
        'Ekdotico is being tested by a small group, and accounts are by invitation. Each invitation is sent by a person on the team.',
      add: 'Add your email address',
      invited: 'Already invited?',
      signIn: 'Sign in',
    });
  });

  it('has the approved sentence with the address, and the list-only sentence without it (D329)', () => {
    expect(line('hi@ekdoti.co')).toBe(WITH_ADDRESS('hi@ekdoti.co'));
    expect(line(undefined)).toBe(WITHOUT_ADDRESS);
    expect(line(undefined)).not.toContain('write to');
  });

  it('sends the visitor to the list at alpha.ekdoti.co, and nowhere else (D328)', () => {
    expect(WAITING_LIST_URL).toBe('https://alpha.ekdoti.co');
  });
});

describe('the page as written', () => {
  const source = readFileSync('src/app/(auth)/visitors-page/page.tsx', 'utf8');

  it('links to the list with rel="noopener noreferrer", and to the sign-in page by its plain path', () => {
    expect(source).toMatch(/href=\{WAITING_LIST_URL\} rel="noopener noreferrer"/);
    expect(source).toMatch(/href="\/sign-in"/);
  });

  it('reads nothing of the request, sets no cookie, holds no form, and is rendered for each request', () => {
    expect(source).not.toMatch(/next\/headers|searchParams|cookies\(|headers\(|<form|onSubmit|'use client'/);
    expect(source).toContain("export const dynamic = 'force-dynamic'");
  });

  it('puts the address in the page only through the setting', () => {
    expect(source).not.toMatch(/hi@ekdoti\.co/);
    expect(source).toContain('contactAddress');
  });
});

describe('CONTACT_ADDRESS', () => {
  it.each([undefined, '', '   '])('is unset by default, and where it is %j', (value) => {
    expect(loadSettings({ ...env, CONTACT_ADDRESS: value }).contactAddress).toBeUndefined();
  });

  it('is the address where it is set', () => {
    expect(loadSettings({ ...env, CONTACT_ADDRESS: ' hi@ekdoti.co ' }).contactAddress).toBe('hi@ekdoti.co');
  });

  it('stops a process where it is not an address', () => {
    expect(() => loadSettings({ ...env, CONTACT_ADDRESS: 'not an address' })).toThrow(
      'CONTACT_ADDRESS must be an email address, or unset.',
    );
  });

  it('is set nowhere in the repository', () => {
    for (const file of ['.env.example']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/^\s*CONTACT_ADDRESS=\S/m);
    }
  });
});

describe('the rewrite that answers the root for a visitor (next.config.ts)', () => {
  it('is for `/` alone, before the files of the build, where the mark is present, and names a path and no origin', async () => {
    const rewrites = (await nextConfig.rewrites!()) as { beforeFiles: unknown[] };
    expect(rewrites.beforeFiles).toEqual([
      {
        source: '/',
        has: [{ type: 'header', key: 'x-ekdotico-visitor', value: '1' }],
        destination: '/visitors-page',
      },
    ]);
  });

  // A rewrite of the proxy's is taken for one to another origin by a process started with
  // `--hostname 127.0.0.1`, as a deployment is (src/lib/visitors.ts): `/` answered 500 there.
  it('is the only one: the proxy rewrites nothing', () => {
    expect(readFileSync('src/proxy.ts', 'utf8')).not.toMatch(/NextResponse\s*\.\s*rewrite/);
  });
});

describe('the root and the internal path in the list of paths (NFR-SE-05)', () => {
  it('put neither on the list: the root is checked for a session, and the internal path answers 404', () => {
    expect(SESSIONLESS.map(({ path }) => path)).not.toContain('/');
    expect(SESSIONLESS.map(({ path }) => path)).not.toContain(VISITORS_PATH);
    for (const method of ['GET', 'HEAD', 'POST']) {
      expect(classify(method, '/')).toBe('session');
      expect(classify(method, VISITORS_PATH)).toBe('session');
    }
  });
});
