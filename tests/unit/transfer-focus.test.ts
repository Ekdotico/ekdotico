import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// After the offers are made the control that opened the dialog may be gone with
// the offers it was for, so the statement of what was done takes the focus, as it
// does for a clearing (WCAG 2.4.3).
describe('transferring the ownership of all documents', () => {
  const source = readFileSync('src/app/(app)/settings/delete-account/transfer-documents.tsx', 'utf8');

  it('moves focus to the statement once an offer has been made', () => {
    expect(source).toMatch(/if \(said > 0\) statement\.current\?\.focus\(\);/);
    expect(source).toContain('<p role="status" ref={statement} tabIndex={-1}');
    expect(source).toMatch(/setSaid\(\(count\) => count \+ 1\);/);
  });
});
