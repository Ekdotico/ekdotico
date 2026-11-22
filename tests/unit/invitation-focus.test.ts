import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A button that is `disabled` while its request is in flight loses the focus to
// the page (WCAG 2.4.3). Accept and Decline use `pending`, as the offer page does.
describe('Accept and Decline on an invitation while the answer is sent', () => {
  const source = readFileSync('src/app/(app)/invitations/invitation-view.tsx', 'utf8');

  it('do not disable the button on the in-flight flag', () => {
    expect(source).not.toMatch(/disabled=\{sending\}/);
  });

  it('mark both buttons as pending instead', () => {
    expect(source.match(/pending=\{sending\}/g)?.length).toBe(2);
  });
});
