// NFR-RE-15: the deletion of the security log runs at start and each hour, and
// says what it did only where there is something to say. Against a database it
// is tested in tests/integration/security-log.test.ts.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const deleteExpiredSecurityLog = vi.hoisted(() => vi.fn<() => Promise<number>>());
vi.mock('../../src/lib/security-log.ts', () => ({ deleteExpiredSecurityLog }));

const HOUR_MS = 60 * 60 * 1000;
let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  stdout = vi.spyOn(console, 'log').mockImplementation(() => {});
  stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('runs at start and each hour; prints a count above 0, nothing for 0, and the fault of a failure', async () => {
  const { startTimers } = await import('../../src/lib/timers.ts');

  deleteExpiredSecurityLog.mockResolvedValueOnce(0);
  startTimers();
  await vi.advanceTimersByTimeAsync(0);
  expect(deleteExpiredSecurityLog).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();

  // One minute short of the hour nothing has run again: a failed run does not wait a day.
  deleteExpiredSecurityLog.mockResolvedValueOnce(7);
  await vi.advanceTimersByTimeAsync(HOUR_MS - 60_000);
  expect(deleteExpiredSecurityLog).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(deleteExpiredSecurityLog).toHaveBeenCalledTimes(2);
  expect(stdout.mock.calls).toEqual([['timer ran: security-log-deletion (7 deleted)']]);

  // NFR-SE-19: the class and the code of the fault, never its message.
  const fault = Object.assign(new Error('connect ECONNREFUSED db.example.test:5432'), {
    code: 'ECONNREFUSED',
  });
  deleteExpiredSecurityLog.mockRejectedValueOnce(fault);
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(stderr.mock.calls).toEqual([['timer failed: security-log-deletion (Error ECONNREFUSED)']]);
  expect(stdout).toHaveBeenCalledTimes(1);
});
