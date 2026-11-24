import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A button that is `disabled` while its own request is in flight loses the focus
// to the page (WCAG 2.4.3). Accept and Decline use `pending` for the one that was
// pressed, and only the other one is disabled, as the offer page does.
describe('Accept and Decline on an invitation while the answer is sent', () => {
  const source = readFileSync('src/app/(app)/invitations/invitation-view.tsx', 'utf8');

  it('mark the pressed button pending, and not both', () => {
    expect(source).toContain("pending={sending === 'accept'}");
    expect(source).toContain("pending={sending === 'decline'}");
    expect(source).not.toMatch(/pending=\{sending\}/);
  });

  it('disable only the other button, never the one pressed', () => {
    expect(source).toContain("disabled={sending === 'decline'}");
    expect(source).toContain("disabled={sending === 'accept'}");
    expect(source).not.toMatch(/disabled=\{sending\}/);
  });

  it('stay busy after an accept until the page has moved, and are freed on a refusal', () => {
    expect(source).toMatch(/if \('fault' in sent\) \{\s*setSending\(null\);/);
    expect(source).toMatch(/return router\.push\(`\/documents\/\$\{documentId\}`\);\s*setSending\(null\);/);
  });

  it('refuse a second answer while one is in flight', () => {
    expect(source).toMatch(/if \(sending\) return;/);
  });
});
