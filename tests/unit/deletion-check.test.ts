// The alarm of a confirmed deletion that is stuck at a call to the feedback intake (fw-detach-wait, fw-alarm-check):
// its own check, HEALTHCHECK_DELETION_URL, and the predicate of what is stuck. `fetch` is stubbed: the monitoring
// service is contacted by no test.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PING = 'https://hc-ping.com/00000000-0000-4000-8000-000000000001';
const TIMERS = 'https://hc-ping.com/00000000-0000-4000-8000-000000000002';
const held = vi.hoisted(() => ({ url: undefined as string | undefined }));

vi.mock('../../src/lib/settings.ts', () => ({
  settings: () => ({
    healthcheckDeletionUrl: held.url,
    healthcheckTimersUrl: TIMERS,
    healthcheckEmailUrl: undefined,
  }),
}));

const { checkInDeletion } = await import('../../src/lib/timers.ts');
const { stuckAtDetach, FEEDBACK_ALARM_MS } = await import('../../src/lib/account/deletion-steps.ts');

let calls: string[];
beforeEach(() => {
  calls = [];
  held.url = PING;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve(new Response('OK'));
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('the check of the deletions', () => {
  it('checks in while no deletion is stuck, at its own address and never at the timers’', async () => {
    await checkInDeletion(0);
    expect(calls).toEqual([PING]);
  });

  it('calls /fail while one is stuck, at its own address and never at the timers’', async () => {
    await checkInDeletion(2);
    expect(calls).toEqual([`${PING}/fail`]);
    expect(calls.join(' ')).not.toContain('0002');
  });

  it('calls nothing where the setting is absent', async () => {
    held.url = undefined;
    await checkInDeletion(0);
    await checkInDeletion(1);
    expect(calls).toEqual([]);
  });
});

describe('a deletion stuck at a call to the intake', () => {
  const NOW = new Date('2026-11-22T12:00:00Z');
  const ago = (ms: number) => new Date(NOW.getTime() - ms);
  const row = {
    istoricoDoneAt: ago(2 * FEEDBACK_ALARM_MS) as Date | null,
    feedbackDoneAt: null as Date | null,
    feedbackSkippedAt: null as Date | null,
    rowsDoneAt: null as Date | null,
    feedbackAgainDoneAt: null as Date | null,
  };

  it('is one at (c): the steps before it done, it neither done nor skipped', () => {
    expect(stuckAtDetach(row, NOW)).toBe(true);
    expect(stuckAtDetach({ ...row, feedbackSkippedAt: ago(1) }, NOW)).toBe(false);
    expect(stuckAtDetach({ ...row, istoricoDoneAt: null }, NOW)).toBe(false);
  });

  it('is one at (g): (c) done a day ago, the rows done, the second call not made', () => {
    const atSecond = { ...row, feedbackDoneAt: ago(FEEDBACK_ALARM_MS + 1), rowsDoneAt: ago(1) };
    expect(stuckAtDetach(atSecond, NOW)).toBe(true);
    // Not before a day from (c): it only waits its 360 seconds.
    expect(stuckAtDetach({ ...atSecond, feedbackDoneAt: ago(FEEDBACK_ALARM_MS - 1000) }, NOW)).toBe(false);
    // Not while the rows are not done (the stuck step is another).
    expect(stuckAtDetach({ ...atSecond, rowsDoneAt: null }, NOW)).toBe(false);
    // Not once the second call is made.
    expect(stuckAtDetach({ ...atSecond, feedbackAgainDoneAt: ago(1) }, NOW)).toBe(false);
  });
});
