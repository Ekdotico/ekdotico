// The `test` of every end-to-end file. Each test runs under the application's
// Content-Security-Policy as a deployment serves it, and fails where a page
// did anything the policy refuses: the proof that the application works under
// it (src/lib/csp.ts). tests/unit/e2e-fixtures.test.ts holds every file to it.
import { expect, test as base, type BrowserContext } from '@playwright/test';

export { expect };
export type { Locator, Page } from '@playwright/test';

/** What the pages of a test did against the policy. */
export interface Violations {
  /** Each as `directive blocked-address`, and each line the browser wrote about the policy. */
  seen: string[];
  /** Set by a test that breaks the policy on purpose, and then reads `seen` itself. */
  expected: boolean;
}

async function watch(context: BrowserContext, violations: Violations): Promise<void> {
  await context.exposeBinding('__violation', (_, line: string) => {
    violations.seen.push(line);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __violation?: (line: string) => void }).__violation;
      report?.(`${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  context.on('console', (message) => {
    if (/Content Security Policy|Content-Security-Policy/i.test(message.text())) {
      violations.seen.push(`console: ${message.text().slice(0, 300)}`);
    }
  });
}

export const test = base.extend<{ violations: Violations }>({
  violations: [
    async ({ context, browser }, use) => {
      const violations: Violations = { seen: [], expected: false };
      await watch(context, violations);
      // The contexts a test opens for a second person are watched as the first is.
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (options) => {
        const made = await newContext(options);
        await watch(made, violations);
        return made;
      };
      await use(violations);
      browser.newContext = newContext;
      if (!violations.expected) expect(violations.seen, 'what the pages did against the policy').toEqual([]);
    },
    { auto: true },
  ],
});
