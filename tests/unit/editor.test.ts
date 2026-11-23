// The parts of the editor that need no browser and no server: the addresses a
// link may hold, what the client does about each refusal, the words of the
// sync status indicator, and the development rewrite that serves `/collab`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { collabRewrites } from '../../next.config.ts';
import { CAPACITY_RETRY_MS, retryDelay, syncStatus } from '../../src/lib/collab/client.ts';
import { LIMIT_REFUSAL, REFUSAL } from '../../src/lib/collab/protocol.ts';
import { TABLE_PAST_BOUNDS, heldTitle } from '../../src/app/(app)/documents/[id]/block-limits.ts';
import { MAX_ELEMENT_DEPTH, MAX_STATE_BYTES } from '../../src/lib/collab/state.ts';
import { linkAddress } from '../../src/lib/editor/link.ts';
import { returnPath } from '../../src/lib/http.ts';
import { RETURN_PARAMETER, SIGN_IN_PATH } from '../../src/proxy.ts';
import { signInAgainHref } from '../../src/app/(app)/documents/[id]/sign-in-return.ts';

// FR-AU-07, owner's decision "ux-sign-in-return": "Sign in again" returns to the document.
describe('"Sign in again" on the document page', () => {
  // What the sign-in page does with the address it is opened at.
  const landing = (href: string) => {
    const url = new URL(href, 'https://app.example.test');
    return { path: url.pathname, to: returnPath(url.searchParams.get(RETURN_PARAMETER)) };
  };

  it('writes the names the proxy reads', () => {
    expect(signInAgainHref('/documents/1').startsWith(`${SIGN_IN_PATH}?${RETURN_PARAMETER}=`)).toBe(true);
  });

  it('carries the path of this document, and signing in lands on it', () => {
    const page = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    expect(page).toContain('signInAgainHref(window.location.pathname + window.location.search)');
    for (const here of ['/documents/abc-1', '/documents/abc-1?tab=sharing&x=%2F']) {
      expect(landing(signInAgainHref(here))).toEqual({ path: SIGN_IN_PATH, to: here });
    }
  });

  it.each([
    'https://evil.example/documents/1',
    '//evil.example',
    '/\\evil.example',
    '\\\\evil.example',
    'javascript:alert(1)',
    '/%2F%2Fevil.example/../x\\y',
    '/documents/1\\..\\x',
    '/documents/1\n/x',
  ])('falls back to the list for %j', (value) => {
    // Refused when the link is written, and again when the sign-in page reads a crafted address.
    expect(landing(signInAgainHref(value)).to).toBe('/');
    expect(landing(`${SIGN_IN_PATH}?${new URLSearchParams({ [RETURN_PARAMETER]: value })}`).to).toBe('/');
  });
});

describe('the address of a hyperlink (FR-ED-02; NFR-SE-06, A03)', () => {
  it.each([
    'https://example.com/a?b=c#d',
    'http://example.com',
    'mailto:someone@example.com',
    'HTTPS://EXAMPLE.COM/',
    'hTtP://Example.com/Path',
    'MAILTO:someone@example.com',
    'https://example.com/a%20b?q=%E2%80%A8',
  ])('admits %s, and stores it as it was given', (address) => {
    expect(linkAddress(address)).toBe(address);
  });

  // What is admitted is what reaches the `href`, character for character. The
  // language's `trim` removes U+FEFF, U+00A0, U+2028 and more, and a browser's
  // parser does not: an address tested trimmed and rendered untrimmed would be
  // one relative to the page, to any path of this application.
  it.each([
    ['a space before', ' https://example.com/'],
    ['a space after', 'https://example.com/ '],
    ['a line end after', 'https://example.com/\n'],
    ['U+FEFF before', '﻿https://a/../../../../api/health?x'],
    ['U+00A0 before', ' https://example.com/'],
    ['U+2028 before', ' https://a/../../../../?x'],
    ['U+2029 after', 'https://example.com/ '],
    ['U+3000 before', '　https://example.com/'],
    ['U+000B before', '\u000bhttps://a/../../../../api/health'],
    ['U+0000 before', '\u0000https://example.com/'],
    ['U+007F before', '\u007fhttps://example.com/'],
    ['U+0085 before', '\u0085https://example.com/'],
    ['a tab inside the scheme', 'ht\ttps://example.com/'],
    ['a line end inside the scheme', 'http\ns://example.com/'],
    ['a tab after the colon', 'https:\t//example.com/'],
    ['a tab inside the host', 'https://exam\tple.com/'],
    ['a line end inside the path', 'https://example.com/a\nb'],
    ['a space inside the path', 'https://example.com/a b'],
    ['a space inside a mailto', 'mailto:someone@example.com?subject=a b'],
    ['backslashes for the slashes', 'https:\\\\example.com/'],
    ['one backslash', 'https:/\\example.com/'],
    ['a backslash before the host of another', 'https://example.com\\@example.org/'],
    ['a backslash in the path', 'https://example.com/a\\b'],
    ['mixed case of a scheme that is not allowed', 'JavaScript://example.com/%0aalert(1)'],
    ['no host', 'https:///example.com'],
    ['no host, with a port', 'http://:80/'],
  ])('refuses an address with %s', (_, address) => {
    expect(linkAddress(address)).toBeNull();
  });

  // Each is read by some browser as script, as a document of the writer's
  // making, as a file of the reader's, or as an address of this application.
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'java\nscript:alert(1)',
    '\u0001javascript:alert(1)',
    'javascript&colon;alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/3f2b8c1e',
    'ftp://example.com/',
    '//example.com/',
    '/api/documents',
    'example.com',
    '#fragment',
    'https:example.com',
    'http:/example.com',
    'ht\ttps://example.com',
    'https://',
    '',
    '   ',
  ])('refuses %j', (address) => {
    expect(linkAddress(address)).toBeNull();
  });

  // The owner's decision of 9 October 2026: a name before the host. A reader
  // takes the address for the host it begins with, and a browser goes to the
  // one after the `@`.
  it.each([
    'https://app.example@evil.example/x',
    'http://user:pw@host/',
    'https://user:@example.com/',
    'https://:pw@example.com/',
    'https://@evil.example/x',
    'HTTPS://App.Example@evil.example',
    'https://app.example%40x@evil.example/',
    'https://a@b@evil.example/',
  ])('refuses %s, which names someone before its host', (address) => {
    expect(linkAddress(address)).toBeNull();
  });

  it.each([
    'mailto:a@b.example',
    'https://example.com/@user',
    'https://example.com/a?to=a@b.example#c@d',
    'https://example.com:8443/path@x',
  ])('admits %s: an @ that is in no host', (address) => {
    expect(linkAddress(address)).toBe(address);
  });

  it.each([null, undefined, 1, {}, ['https://example.com'], new URL('https://example.com')])(
    'refuses what is not text (%j)',
    (given) => {
      expect(linkAddress(given)).toBeNull();
    },
  );
});

describe('what the client does about a refusal (FR-ED-18, FR-ED-41)', () => {
  // FR-ED-41: "the client shall not attempt to reconnect".
  it.each([REFUSAL.NO_ACCESS, REFUSAL.ACCESS_ENDED, REFUSAL.SESSION_ENDED])(
    'never tries again after %s',
    (reason) => {
      for (const attempt of [1, 2, 50]) expect(retryDelay(reason, attempt)).toBeNull();
    },
  );

  // The owner's decision of 12 October 2026: the same change would be sent and refused again.
  // And register D170, D171, D180: a rule of the shape, refused as a limit is.
  it.each([
    REFUSAL.TOO_LARGE,
    REFUSAL.TOO_DEEP,
    REFUSAL.TOO_DANGLING,
    REFUSAL.INCOMPLETE,
    REFUSAL.TABLE_BOUNDS,
    REFUSAL.IMAGE_ATTRIBUTES,
    REFUSAL.LEAF_CONTENT,
    // Register D184, D192, D193: a limit of the document.
    ...Object.values(LIMIT_REFUSAL),
  ])('never tries again after %s', (reason) => {
    for (const attempt of [1, 2, 50]) expect(retryDelay(reason, attempt)).toBeNull();
  });

  it('names, in what it says of such a refusal, the limits the server keeps', () => {
    // The page cannot import the server's module, so its words carry the numbers.
    const page = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    expect(page).toContain(`would make the document larger than ${MAX_STATE_BYTES / 1024 / 1024} MB'`);
    expect(page).toContain(`would nest the content more than ${MAX_ELEMENT_DEPTH} levels deep'`);
  });

  it('says of a change refused for an image, in the owner\'s plain words of 21 October 2026, and without "hold"', () => {
    const page = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    expect(page).toContain(
      "'This tab tried to change an image in a way that is not allowed, so the change was not saved.'",
    );
    expect(page).toContain(
      "'This tab tried to put content inside a block that cannot contain any, so the change was not saved.'",
    );
  });

  it('says of a change refused for the shape of the document which rule, in words that name no internal term', () => {
    const page = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    expect(page).toContain('[REFUSAL.TABLE_BOUNDS]: TABLE_PAST_BOUNDS');
    // The owner's words of 18 October 2026 (D171).
    expect(TABLE_PAST_BOUNDS).toBe(
      'We cannot apply this change. A table holds 100 rows, 100 cells in a row and 10,000 cells, two levels deep, and this change passes our current limits.',
    );
    const incomplete =
      'A change in this tab adds a block without the content it must hold, so it cannot be applied';
    expect(page).toContain(`[REFUSAL.INCOMPLETE]:\n    '${incomplete}'`);
    expect(incomplete).not.toMatch(/\d|schema|element|node|Yjs/i);
  });

  it('says of a change refused for a limit of the document which limit, in the voice of the owner’s words', () => {
    // Written out here, and not taken from the code under test. For the owner's approval.
    expect(heldTitle('tables')).toBe(
      'We cannot apply this change. Our current limit per document is 100 tables, and this change passes it.',
    );
    expect(heldTitle('tablesOfContents')).toBe(
      'We cannot apply this change. Our current limit per document is 5 tables of contents, and this change passes it.',
    );
    expect(heldTitle('listItems')).toBe(
      'We cannot apply this change. Our current limit per list is 1,000 items, and this change passes it.',
    );
    expect(heldTitle('listDepth')).toBe(
      'We cannot apply this change. Our current limit is 10 levels of nesting, and this change passes it.',
    );
    expect(heldTitle('codeBytes')).toBe(
      'We cannot apply this change. Our current limit per code block is 500 KB, and this change passes it.',
    );
    // The owner's words of 18 October 2026 (D192).
    expect(heldTitle('blocks')).toBe(
      'We cannot apply this change. Our current limit per document is 5,000 blocks, and this change passes it.',
    );
    const page = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    expect(page).toContain('[reason, heldTitle(limit as Limit)]');
  });

  it('says of a change that waits for content the document does not hold what is true of it, in words that name no number and no internal term', () => {
    const page = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    const said =
      'A change in this tab refers to content that this document does not hold, so it cannot be applied';
    expect(page).toContain(`[REFUSAL.TOO_DANGLING]:\n    '${said}'`);
    expect(said).not.toMatch(/\d|struct|part|wait|Yjs|2,000/i);
    // Not the words of either of the others.
    expect(said).not.toContain('5 MB');
    expect(said).not.toContain('levels');
  });

  it('tries again no more often than once in 30 seconds at the limit of connections', () => {
    expect(CAPACITY_RETRY_MS).toBe(30_000);
    for (const attempt of [1, 2, 50]) expect(retryDelay(REFUSAL.CAPACITY, attempt)).toBe(30_000);
  });

  it('pauses before every new try after a limit, longer each time, up to a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 50].map((attempt) => retryDelay(REFUSAL.LIMITED, attempt))).toEqual([
      5000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000,
    ]);
  });

  it('tries again after a second, then twice as long, at least every 30 seconds, where the server could not open the document', () => {
    for (const reason of [REFUSAL.UNAVAILABLE, 'a-reason-that-is-not-listed', '']) {
      expect([1, 2, 3, 4, 5, 6, 7, 50].map((attempt) => retryDelay(reason, attempt))).toEqual([
        1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
      ]);
    }
  });

  it('never tries again at once, whatever the reason', () => {
    for (const reason of [...Object.values(REFUSAL), 'unknown']) {
      const delay = retryDelay(reason, 1);
      if (delay !== null) expect(delay).toBeGreaterThanOrEqual(1000);
    }
  });
});

describe('the sync status indicator (FR-ED-22, FR-ED-23, FR-ED-18)', () => {
  const state = (phase: Parameters<typeof syncStatus>[0]['phase'], unsent = false) =>
    syncStatus({ phase, unsent, opened: true });

  it('is synced only while connected with nothing unacknowledged', () => {
    expect(state('connected')).toEqual({ state: 'synced', label: 'In sync' });
    for (const phase of ['opening', 'restoring', 'lost', 'capacity'] as const) {
      expect(state(phase).state).not.toBe('synced');
      expect(state(phase, true).state).not.toBe('synced');
    }
  });

  it('is syncing while a change is unacknowledged, and says that it is lost if the tab is closed', () => {
    expect(state('connected', true)).toEqual({
      state: 'syncing',
      label: 'Syncing. Changes that are not yet sent are lost if this tab is closed.',
    });
  });

  // The owner's decision E3 of 8 October 2026.
  it('shows a connection that is being restored as syncing, in words that say so', () => {
    expect(state('restoring')).toEqual({
      state: 'syncing',
      label:
        'Restoring the connection. Ekdotico keeps changes in this tab and sends them when the connection returns.',
    });
    expect(state('restoring', true).label).toMatch(
      /^Restoring the connection\..* lost if this tab is closed\.$/,
    );
  });

  it('is the error state once the connection is lost for the period, and says the document is read-only', () => {
    expect(state('lost')).toEqual({
      state: 'error',
      label:
        'Not connected. The document is read-only until the connection returns. Check the connection. Ekdotico tries again automatically.',
    });
    expect(state('lost', true).label).toMatch(/lost if this tab is closed\.$/);
    for (const phase of ['opening', 'connected', 'restoring', 'capacity'] as const) {
      expect(state(phase, true).state).not.toBe('error');
    }
  });
});

describe('the development rewrite that serves /collab (next.config.ts)', () => {
  it('is absent unless it is asked for', () => {
    expect(collabRewrites({})).toEqual([]);
    expect(collabRewrites({ APP_ORIGIN: 'https://ekdoti.co', COLLAB_PROXY_TARGET: '' })).toEqual([]);
  });

  it('passes the one path to the collaboration server, on a development machine', () => {
    expect(
      collabRewrites({ APP_ORIGIN: 'http://localhost:3000', COLLAB_PROXY_TARGET: 'http://127.0.0.1:1234' }),
    ).toEqual([{ source: '/collab', destination: 'http://127.0.0.1:1234/collab' }]);
  });

  // A deployment must not come to rest on it (docs/operations/deployment.md).
  it.each([
    { APP_ORIGIN: 'https://ekdoti.co', COLLAB_PROXY_TARGET: 'http://127.0.0.1:1234' },
    { APP_ORIGIN: 'http://localhost:3000', COLLAB_PROXY_TARGET: 'http://collab.internal:1234' },
    { APP_ORIGIN: 'http://localhost:3000', COLLAB_PROXY_TARGET: 'http://localhost.example.com:1234' },
    { COLLAB_PROXY_TARGET: 'http://127.0.0.1:1234' },
    { APP_ORIGIN: 'http://localhost:3000', COLLAB_PROXY_TARGET: 'not an address' },
  ])('refuses to build where either address is not on localhost (%j)', (env) => {
    expect(() => collabRewrites(env)).toThrow(/COLLAB_PROXY_TARGET is for a development machine/);
  });
});
