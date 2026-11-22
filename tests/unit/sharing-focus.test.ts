import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A button that is `disabled` while its request is in flight loses the focus to
// the page (WCAG 2.4.3). The sharing controls use `pending`, which keeps it.
describe('the sharing controls while a request is in flight', () => {
  const source = readFileSync('src/app/(app)/documents/[id]/sharing/sharing-settings.tsx', 'utf8');

  it('never disable a button on the in-flight flag', () => {
    expect(source).not.toMatch(/disabled=\{[^}]*sending/);
  });

  it('mark Invite, Revoke, Send again and Remove as pending instead', () => {
    expect(source.match(/pending=\{sending\}/g)?.length).toBe(4);
  });
});
