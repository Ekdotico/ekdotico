// FR-AU-87 (a), with the owner's decision of 8 October 2026: the link of the
// invitation email stands on a line of its own, and the number of days in the
// text is the setting that gives an invitation its expiry.
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGIN = 'https://app.example.test';
const TOKEN = 'A'.repeat(43);

async function email(admissionInvitationDays: number) {
  vi.resetModules();
  vi.doMock('../../src/lib/settings.ts', () => ({
    settings: () => ({ appOrigin: ORIGIN, admissionInvitationDays }),
  }));
  const { invitationEmail } = await import('../../src/lib/admission/invitations.ts');
  return invitationEmail('person@example.com', TOKEN);
}
afterEach(() => vi.doUnmock('../../src/lib/settings.ts'));

describe('the invitation email', () => {
  it('has the fixed text, with the link on a line of its own', async () => {
    const { subject, text } = await email(30);
    expect(subject).toBe('Your invitation to Ekdotico Closed α');
    expect(text.split('\n')).toEqual([
      'The Ekdotico team has invited you to test Ekdotico in Closed α. To create your account, open this link and choose a password:',
      `${ORIGIN}/sign-up/${TOKEN}`,
      'The link works once and is valid for 30 days. If you did not expect this invitation, you can ignore this email.',
    ]);
  });

  it('has nothing on the line of the link but the link, whatever the token ends with', async () => {
    const lines = (await email(30)).text.split('\n');
    expect(lines.filter((line) => line.includes('/sign-up/'))).toEqual([`${ORIGIN}/sign-up/${TOKEN}`]);
    expect(lines[1]).toMatch(/^https:\/\/app\.example\.test\/sign-up\/[A-Za-z0-9_-]{43}$/);
  });

  it('says the number of days of the setting, and "day" for one', async () => {
    expect((await email(7)).text).toContain('The link works once and is valid for 7 days. If');
    expect((await email(45)).text).toContain('is valid for 45 days.');
    expect((await email(1)).text).toContain('is valid for 1 day. If');
    expect((await email(7)).text).not.toContain('30');
  });
});
