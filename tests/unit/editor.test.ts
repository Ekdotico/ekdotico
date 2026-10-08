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
  ])('admits %s', (address) => {
    expect(linkAddress(address)).toBe(address);
    expect(linkAddress(`  ${address}\n`)).toBe(address);
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
        'Restoring the connection. Changes are kept in this tab and are sent when the connection returns.',
    });
    expect(state('restoring', true).label).toMatch(
      /^Restoring the connection\..* lost if this tab is closed\.$/,
    );
  });

  it('is the error state once the connection is lost for the period, and says the document is read-only', () => {
    expect(state('lost')).toEqual({
      state: 'error',
      label: 'Not connected. The document is read-only until the connection returns.',
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
