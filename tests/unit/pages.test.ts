// FR-AU-55: "until the account has acknowledged the notice, every page of the
// application the account opens shows the wizard in place of its content".
//
// The signed-in layout shows the notice, but Next.js also sends the content of
// the page it leaves out, so each page under `(app)` returns nothing itself
// while the notice is due (src/app/(app)/account.ts). A page added without
// that fails here, and so does a page added anywhere else.
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const EXTENSIONS = '{tsx,ts,jsx,js}';
const SIGNED_IN = 'src/app/(app)/';

// The pages that are not under the signed-in layout, each with the requirement
// that excepts it: a person without a session opens them, so no notice is due.
const WITHOUT_NOTICE: Record<string, string> = {
  'src/app/(auth)/sign-in/page.tsx': 'FR-AU-81; NFR-SE-05 (a): the sign-in page, opened without a session',
  'src/app/(auth)/sign-up/[token]/page.tsx':
    'FR-AU-90; NFR-SE-05 (a): the link of an admission invitation, opened without a session',
};

// A layout below the signed-in one renders beside the notice as a page does,
// and nothing here checks what it sends: none is admitted unless it is listed,
// with the reason it shows nothing of the account.
const LAYOUTS_BELOW: Record<string, string> = {};

const pages = globSync(`src/app/**/page.${EXTENSIONS}`);
const signedIn = pages.filter((page) => page.startsWith(SIGNED_IN));

/** What follows the parameters of the default export: its body, from the opening brace. */
function bodyOfDefaultExport(source: string): string {
  const start = source.indexOf('export default async function');
  if (start < 0) return '';
  let depth = 0;
  for (let at = source.indexOf('(', start); at >= 0 && at < source.length; at += 1) {
    if (source[at] === '(') depth += 1;
    if (source[at] === ')' && --depth === 0) return source.slice(at + 1);
  }
  return '';
}

describe('the pages of the application', () => {
  it('are found', () => {
    expect(signedIn.length).toBeGreaterThan(0);
  });

  it('are each under the signed-in layout, or excepted by name', () => {
    for (const page of pages) {
      expect(page.startsWith(SIGNED_IN) || page in WITHOUT_NOTICE, page).toBe(true);
    }
  });

  it('excepts no page that does not exist', () => {
    for (const page of Object.keys(WITHOUT_NOTICE)) expect(pages).toContain(page);
  });

  // The first statement: nothing of the account is read or rendered before it.
  it.each(signedIn)('%s holds its content back while the notice is due, before anything else', (page) => {
    expect(bodyOfDefaultExport(readFileSync(page, 'utf8'))).toMatch(
      /^(: [^{]+)? \{\n\s*if \(\(await currentAccount\(\)\)\.noticeDue\) return null;/,
    );
  });

  it('have no layout below the signed-in one that is not listed', () => {
    const below = globSync(`${SIGNED_IN}**/layout.${EXTENSIONS}`).filter(
      (layout) => layout !== `${SIGNED_IN}layout.tsx`,
    );
    expect(below.sort()).toEqual(Object.keys(LAYOUTS_BELOW).sort());
  });
});
