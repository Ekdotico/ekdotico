// The parts of the editor that need no browser and no server: the addresses a
// link may hold, what the client does about each refusal, the words of the
// sync status indicator, and the development rewrite that serves `/collab`.
import { describe, expect, it } from 'vitest';
import { collabRewrites } from '../../next.config.ts';
import { CAPACITY_RETRY_MS, retryDelay, syncStatus } from '../../src/lib/collab/client.ts';
import { REFUSAL } from '../../src/lib/collab/protocol.ts';
import { linkAddress } from '../../src/lib/editor/link.ts';

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
