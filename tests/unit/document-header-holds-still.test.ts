import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The owner's answer "hold-still" to ui-load-jump (24 November 2026): the text of a document stands still while
// the page finishes opening. The places of the people and the status are filled after the connection is made, and
// the long label of an unsent change comes and goes with every change, so the header keeps their size from the
// first paint. If either rule below goes, the text moves by a line (11 px at 1280, 17 px at 375) at every opening.
const css = readFileSync('src/app/pages.module.css', 'utf8');
const rule = (selector: string) => {
  const found = new RegExp(`(?:^|\\n)${selector.replace(/[.:]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
  return found ? found[1]! : '';
};

describe('the header of a document holds still while the page opens', () => {
  it('never hides the empty place of the people or the status', () => {
    expect(css).not.toMatch(/\.peopleSlot:empty/);
    expect(css).not.toMatch(/\.statusSlot:empty/);
  });

  it('keeps the size of one avatar for the people from the first paint', () => {
    const body = rule('.peopleSlot');
    expect(body).toMatch(/min-inline-size:\s*var\(--sp-7\)/);
    expect(body).toMatch(/min-block-size:\s*var\(--sp-7\)/);
  });

  it('keeps two lines of the status control from the first paint', () => {
    expect(rule('.statusSlot')).toMatch(
      /min-block-size:\s*calc\(2 \* var\(--fs-sm\) \* var\(--lh-normal\) \+ 2 \* \(var\(--sp-1\) \+ 1px\)\)/,
    );
  });
});
