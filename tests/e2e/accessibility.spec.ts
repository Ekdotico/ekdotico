// The automated accessibility check (NFR-IC-19, procedure 4 step 2): axe-core, through @axe-core/playwright, on the
// sign-in page, the list of documents, the editor, the sharing settings and the account settings, each in a light
// and a dark colour scheme, against WCAG 2.0 to 2.2 Level A and AA. It runs against the real collaboration
// server, as the editor does.
//
// A page that fails is not made to pass here. A finding that exists today is listed in KNOWN with its page, its
// theme, its rule and the element, and a comment that names it; anything else fails the test, and so does an
// entry of KNOWN that no longer occurs, so that a fix removes its line.
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from './fixtures.ts';
import { newPerson, signUp } from './account.ts';
import { startCollab, stopCollab } from './collab.ts';
import { shareNew } from './sharing.ts';

test.describe.configure({ mode: 'serial' });
test.beforeAll(() => startCollab());
test.afterAll(stopCollab);

type Theme = 'light' | 'dark';

/** Findings that exist today: `page | theme | rule | element`. Each has a comment that names the finding. */
const KNOWN = new Set<string>([]);

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

async function scan(page: Page, name: string, theme: Theme, seen: Set<string>): Promise<string[]> {
  const { violations, passes } = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  // Proof that the rules ran on a page with content, so that a scan that checks nothing cannot pass.
  expect(passes.length, `${name}: rules that passed`).toBeGreaterThan(10);
  const found: string[] = [];
  for (const violation of violations) {
    for (const node of violation.nodes) {
      const key = `${name} | ${theme} | ${violation.id} | ${node.target.join(' ')}`;
      seen.add(key);
      if (!KNOWN.has(key)) found.push(`${key}  (${violation.help}; impact ${node.impact ?? 'n/a'})`);
    }
  }
  return found;
}

for (const theme of ['light', 'dark'] as const) {
  test(`axe finds nothing new on the five pages, in the ${theme} scheme`, async ({ page }) => {
    test.slow();
    await page.emulateMedia({ colorScheme: theme });
    const seen = new Set<string>();
    const found: string[] = [];

    await page.goto('/sign-in');
    await expect(page.getByRole('textbox', { name: 'Email address' })).toBeVisible();
    found.push(...(await scan(page, 'sign-in', theme, seen)));

    await signUp(page, newPerson());
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeVisible();
    found.push(...(await scan(page, 'document list', theme, seen)));

    // shareNew creates a document and opens its sharing settings; the editor is the page before.
    await shareNew(page);
    found.push(...(await scan(page, 'sharing', theme, seen)));
    await page.goBack();
    await expect(page.getByRole('textbox', { name: 'Document text' })).toBeVisible();
    found.push(...(await scan(page, 'editor', theme, seen)));

    await page.goto('/settings');
    await expect(page.getByRole('main')).toBeVisible();
    found.push(...(await scan(page, 'account', theme, seen)));

    expect(found, 'findings that are not in KNOWN').toEqual([]);
    const gone = [...KNOWN].filter((key) => key.split(' | ')[1] === theme && !seen.has(key));
    expect(gone, 'entries of KNOWN that no longer occur: remove them').toEqual([]);
  });
}
