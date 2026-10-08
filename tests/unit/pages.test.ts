// FR-AU-55: "until the account has acknowledged the notice, every page of the
// application the account opens shows the wizard in place of its content".
//
// The signed-in layout shows the notice, but Next.js also sends the content of
// the page it leaves out, so each page under `(app)` returns nothing itself
// while the notice is due (src/app/(app)/account.ts). A page added without
// that fails here.
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pages = globSync('src/app/(app)/**/page.tsx');

describe('the pages of a signed-in account', () => {
  it('are found', () => {
    expect(pages.length).toBeGreaterThan(0);
  });

  it.each(pages)('%s holds its content back while the notice is due', (page) => {
    expect(readFileSync(page, 'utf8')).toMatch(/if \(\(await currentAccount\(\)\)\.noticeDue\) return null;/);
  });
});
