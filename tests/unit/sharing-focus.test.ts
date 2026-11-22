import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A button that is `disabled` while its own request is in flight loses the focus
// to the page (WCAG 2.4.3). The sharing buttons that send a request use `pending`,
// and only the one that was pressed shows busy; the others merely wait.
describe('the sharing controls while a request is in flight', () => {
  const source = readFileSync('src/app/(app)/documents/[id]/sharing/sharing-settings.tsx', 'utf8');

  it('mark Invite, Revoke and Send again as pending when they are the one pressed', () => {
    expect(source).toContain("pending={pressed === 'invite'}");
    expect(source).toContain('pending={pressed === `revoke-${invitation.id}`}');
    expect(source).toContain('pending={pressed === `resend-${invitation.id}`}');
    expect(source).not.toContain('pending={sending}');
  });

  it('disable another button only while some other one is pressed', () => {
    expect(source).toContain("disabled={!ready || (sending && pressed !== 'invite')}");
    expect(source).not.toMatch(/disabled=\{!ready \|\| sending\}[\s\S]{0,120}onClick=\{\(\) => void act/);
  });

  it('refuse a second request while one is in flight', () => {
    expect(source).toMatch(/if \(sending\) return false;/);
  });
});
