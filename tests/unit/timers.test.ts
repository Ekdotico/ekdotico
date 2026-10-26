// NFR-RE-15: the deletion of the security log and the permanent deletion of
// deleted documents each run at start and each hour, and say what they did
// only where there is something to say. Against a database they are tested in
// tests/integration/security-log.test.ts and tests/integration/document-deletion.test.ts.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const deleteExpiredSecurityLog = vi.hoisted(() => vi.fn<() => Promise<number>>());
const deleteExpiredDocuments = vi.hoisted(() => vi.fn<() => Promise<{ deleted: number; kept: number }>>());
vi.mock('../../src/lib/security-log.ts', () => ({ deleteExpiredSecurityLog }));
vi.mock('../../src/lib/documents/deletion.ts', () => ({ deleteExpiredDocuments }));
// The two other timers, which run beside it and here find nothing to delete
// (tests/integration/session-list.test.ts runs them against a database).
vi.mock('../../src/lib/auth/password.ts', () => ({ deleteExpiredTokens: async () => 0 }));
vi.mock('../../src/lib/auth/session-list.ts', () => ({ deleteEndedSessions: async () => 0 }));
// The expiry of offers of ownership and the backstop of their email, which run beside them
// (tests/integration/ownership.test.ts runs them against a database).
vi.mock('../../src/lib/documents/ownership.ts', () => ({
  expireOffers: async () => 0,
  deliverUnsentOffers: async () => 0,
}));
// The reminder, the two clearings of addresses and the notifications of ended invitations
// (tests/integration/invitation-clearing.test.ts runs them against a database).
const clearInvitationAddresses = vi.hoisted(() => vi.fn<() => Promise<number>>(async () => 0));
vi.mock('../../src/lib/documents/invitation-timers.ts', () => ({
  remindInvitations: async () => 0,
  clearInvitationAddresses,
  deleteEndedInvitationNotifications: async () => 0,
}));
vi.mock('../../src/lib/admission/invitations.ts', () => ({ clearAdmissionAddresses: async () => 0 }));
vi.mock('../../src/lib/documents/access-notifications.ts', () => ({
  deleteExpiredRemovedNotifications: async () => 0,
}));

// NFR-RE-15, NFR-SE-18: the deletion of images out of their documents for 30 days
// (tests/integration/images.test.ts runs it against a database and a store).
const deleteExpiredImagesNow = vi.hoisted(() => vi.fn<() => Promise<number>>(async () => 0));
vi.mock('../../src/lib/images/deletion.ts', () => ({ deleteExpiredImagesNow }));

// NFR-RE-15, FR-AU-58: the steps of an account deletion, which run beside them
// (tests/integration/account-deletion.test.ts runs them against a database).
const carryOutDeletions = vi.hoisted(() =>
  vi.fn(async () => ({ steps: 0, completed: 0, failed: 0, overdue: 0 })),
);
vi.mock('../../src/lib/account/deletion-steps.ts', () => ({ carryOutDeletions }));

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

it('each runs at start and each hour; prints a count above 0, nothing for 0, and the fault of a failure', async () => {
  const { startTimers } = await import('../../src/lib/timers.ts');

  deleteExpiredSecurityLog.mockResolvedValueOnce(0);
  deleteExpiredDocuments.mockResolvedValueOnce({ deleted: 0, kept: 0 });
  startTimers();
  // A second start adds no second timer.
  startTimers();
  await vi.advanceTimersByTimeAsync(0);
  expect(deleteExpiredSecurityLog).toHaveBeenCalledTimes(1);
  expect(deleteExpiredDocuments).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();

  // One minute short of the hour nothing has run again: a failed run does not wait a day.
  deleteExpiredSecurityLog.mockResolvedValueOnce(7);
  deleteExpiredDocuments.mockResolvedValueOnce({ deleted: 2, kept: 1 });
  await vi.advanceTimersByTimeAsync(HOUR_MS - 60_000);
  expect(deleteExpiredSecurityLog).toHaveBeenCalledTimes(1);
  expect(deleteExpiredDocuments).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(deleteExpiredSecurityLog).toHaveBeenCalledTimes(2);
  expect(deleteExpiredDocuments).toHaveBeenCalledTimes(2);
  expect(stdout.mock.calls).toEqual([
    ['timer ran: security-log-deletion (7 deleted)'],
    ['timer ran: document-deletion (2 deleted, 1 kept)'],
  ]);

  // NFR-SE-19: the class and the code of the fault, never its message. One
  // timer that fails does not stop the other.
  const fault = Object.assign(new Error('connect ECONNREFUSED db.example.test:5432'), {
    code: 'ECONNREFUSED',
  });
  deleteExpiredSecurityLog.mockRejectedValueOnce(fault);
  deleteExpiredDocuments.mockRejectedValueOnce(fault);
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(stderr.mock.calls).toEqual([
    ['timer failed: security-log-deletion (Error ECONNREFUSED)'],
    ['timer failed: document-deletion (Error ECONNREFUSED)'],
  ]);
  expect(stdout).toHaveBeenCalledTimes(2);

  // A run that deleted nothing and kept one still says so.
  deleteExpiredSecurityLog.mockResolvedValueOnce(0);
  deleteExpiredDocuments.mockResolvedValueOnce({ deleted: 0, kept: 1 });
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(stdout.mock.calls.at(-1)).toEqual(['timer ran: document-deletion (0 deleted, 1 kept)']);
});

it('runs the deletion of images at start and each hour, as a timer of its own, and says how many it deleted', async () => {
  vi.resetModules();
  deleteExpiredSecurityLog.mockResolvedValue(0);
  deleteExpiredDocuments.mockResolvedValue({ deleted: 0, kept: 0 });
  deleteExpiredImagesNow.mockResolvedValueOnce(0);
  const { startTimers, TIMERS } = await import('../../src/lib/timers.ts');
  expect(Object.keys(TIMERS)).toContain('image-deletion');
  startTimers();
  await vi.advanceTimersByTimeAsync(0);
  expect(deleteExpiredImagesNow).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();
  deleteExpiredImagesNow.mockResolvedValueOnce(3);
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(deleteExpiredImagesNow).toHaveBeenCalledTimes(2);
  expect(stdout.mock.calls).toEqual([['timer ran: image-deletion (3 deleted)']]);
  // A fault is the class and the code of it, and the other timers go on.
  deleteExpiredImagesNow.mockRejectedValueOnce(
    Object.assign(new Error('secret key abc'), { code: 'AccessDenied' }),
  );
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(stderr.mock.calls).toEqual([['timer failed: image-deletion (Error AccessDenied)']]);
});

it('runs the steps of an account deletion at start and each hour, and says how many it carried out', async () => {
  vi.resetModules();
  deleteExpiredSecurityLog.mockResolvedValue(0);
  deleteExpiredDocuments.mockResolvedValue({ deleted: 0, kept: 0 });
  const { startTimers, TIMERS } = await import('../../src/lib/timers.ts');
  expect(Object.keys(TIMERS)).toContain('account-deletion-steps');
  startTimers();
  await vi.advanceTimersByTimeAsync(0);
  expect(carryOutDeletions).toHaveBeenCalledTimes(1);
  expect(stdout).not.toHaveBeenCalled();
  carryOutDeletions.mockResolvedValueOnce({ steps: 3, completed: 1, failed: 0, overdue: 0 });
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(carryOutDeletions).toHaveBeenCalledTimes(2);
  // It deletes nothing it counts: it carried out steps.
  expect(stdout.mock.calls).toEqual([['timer ran: account-deletion-steps (3 carried out)']]);
  // A fault is the class and the code of it, and the other timers go on.
  carryOutDeletions.mockRejectedValueOnce(Object.assign(new Error('a name'), { code: 'P1001' }));
  await vi.advanceTimersByTimeAsync(HOUR_MS);
  expect(stderr.mock.calls).toEqual([['timer failed: account-deletion-steps (Error P1001)']]);
});

it('says "cleared", and not "deleted", of an address a clearing emptied from a row that stays', async () => {
  vi.resetModules();
  deleteExpiredSecurityLog.mockResolvedValue(0);
  deleteExpiredDocuments.mockResolvedValue({ deleted: 0, kept: 0 });
  clearInvitationAddresses.mockResolvedValueOnce(4);
  const { startTimers } = await import('../../src/lib/timers.ts');
  startTimers();
  await vi.advanceTimersByTimeAsync(0);
  expect(stdout.mock.calls).toEqual([['timer ran: invitation-address-clearing (4 cleared)']]);
});
