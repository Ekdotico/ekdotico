import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Every row repeats "Open the document" and "Mark as read"; each control is
// described by the row's own sentence (WCAG 2.4.4, 2.4.6), and Mark as read keeps
// the focus while it is sent (WCAG 2.4.3).
describe('the controls of a notification', () => {
  const source = readFileSync('src/app/(app)/notifications/notification-list.tsx', 'utf8');

  it('name their row: every link and the button are described by the sentence', () => {
    const links = source.match(/<Link\b/g)?.length ?? 0;
    const described = source.match(/aria-describedby=\{`words-\$\{notification\.id\}`\}/g)?.length ?? 0;
    expect(links).toBeGreaterThan(0);
    expect(described).toBe(links + 1);
  });

  it('keep the focus on Mark as read while it is sent', () => {
    expect(source).not.toMatch(/disabled=\{marking !== null\}/);
    expect(source).toMatch(/pending=\{marking === notification\.id\}/);
    expect(source).toMatch(/if \(marking !== null\) return;/);
  });
});
