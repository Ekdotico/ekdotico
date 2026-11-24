import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// A live region created in the same render as its words is not certain to be
// spoken (WCAG 4.1.3). The statements about the document (capacity, a role or its
// permissions changed, a clearing, an unrepaired change) are seen where they are
// and heard from one region that is in the page throughout.
describe('the statements about the open document', () => {
  const source = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
  const open = source.slice(source.indexOf('function OpenDocument'));

  it('are heard from one always-present region, written after it has stood empty', () => {
    expect(source).toContain('function Heard(');
    expect(source).toMatch(/element\.textContent = '';/);
    expect(open).toMatch(/<Heard words=\{spoken\.join\(' '\)\} again=\{again\.join\('\|'\)\} \/>/);
  });

  it('and the region of refusals are told apart by name, for a test that watches one of them', () => {
    // tests/e2e/editor.spec.ts watches the refusal region; two hidden status regions stand in the page.
    expect(source).toContain('data-heard="refusal"');
    // The standing region of the statements is the default kind of Heard (the others are named where they are used).
    expect(source).toMatch(/kind = 'statements'/);
    expect(source).toContain('data-heard={kind}');
  });

  it('are not announced a second time by their visible copy', () => {
    for (const mark of [
      'AT_CAPACITY',
      'UNREPAIRED',
      'CLEARING_ENDED(mayEdit)',
      'ROLE_NOW(',
      'PERMISSIONS_NOW(',
    ]) {
      const at = open.lastIndexOf(`{${mark}`);
      expect(at, mark).toBeGreaterThan(-1);
      const faultStart = open.lastIndexOf('<FormFault', at);
      expect(open.slice(faultStart, at), mark).not.toContain('announce="polite"');
    }
  });
});
