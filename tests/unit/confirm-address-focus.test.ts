import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The button that confirms the address goes with the form; the statement that
// replaces it takes the focus, as it does on the reset pages (WCAG 2.4.3).
describe('confirming a new address', () => {
  const source = readFileSync('src/app/(auth)/confirm-address/[token]/confirm-form.tsx', 'utf8');

  it('moves focus to the statement once the change is done', () => {
    expect(source).toMatch(/if \(done\) statement\.current\?\.focus\(\)/);
    expect(source).toMatch(/ref=\{statement\} tabIndex=\{-1\}/);
  });
});
