// FR-ED-48: the email of the reminder of a document invitation has the subject
// and the fixed text of the requirement, verbatim, states who sent the
// invitation, the role and the day it expires, links to the notification list
// (the link of the invitation is stored only as a hash), and carries neither
// the title nor any content of the document. The function is handed none, so
// none can be written; the integration test reads the file the sink wrote for
// a document whose title is distinctive.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.example.test';

async function email(inviterName: string, role: string, expiresAt: Date) {
  vi.resetModules();
  vi.doMock('../../src/lib/settings.ts', () => ({ settings: () => ({ appOrigin: ORIGIN }) }));
  const { reminderEmail } = await import('../../src/lib/documents/invitation-timers.ts');
  return reminderEmail('invitee@example.com', inviterName, role, expiresAt);
}
afterEach(() => vi.doUnmock('../../src/lib/settings.ts'));

describe('the email of the reminder of an invitation', () => {
  it('has the subject and the fixed text of FR-ED-48, with the notification list as its link', async () => {
    const { to, subject, text } = await email(
      'Ada Owner',
      'Editor',
      new Date(Date.UTC(2026, 9, 2, 14, 5, 59)),
    );
    expect(to).toBe('invitee@example.com');
    expect(subject).toBe('Your invitation to a document in Ekdotico expires soon');
    expect(text).toBe(
      `Ada Owner invited you to a document in Ekdotico as Editor. The invitation expires on 2 Oct 2026, 14:05 UTC. To accept or decline it, open your notifications in Ekdotico: ${ORIGIN}/notifications.`,
    );
  });

  it('holds no link to a document or an invitation, and no line break in the subject', async () => {
    const { subject, text } = await email('Ada Owner', 'Viewer', new Date(Date.UTC(2026, 9, 2)));
    expect(text).not.toMatch(/\/documents\//);
    expect(text).not.toMatch(/\/invitations\//);
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
