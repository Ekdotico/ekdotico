// The page-load step of procedure 1 (register D297): the largest contentful paint of a page, over a number of loads,
// in Chromium under Playwright, signed in with an account's cookie. Each load has a browser context of its own, so
// the cache is empty at every load. The cookie is given to the context and is written nowhere.
import { chromium } from '@playwright/test';
import { cookiesOf } from './browser.ts';

/** The time of the last largest-contentful-paint entry of each of `loads` loads of `path`, in milliseconds. */
export async function largestContentfulPaints(options: {
  origin: string;
  cookie: string;
  path: string;
  loads: number;
}): Promise<number[]> {
  const browser = await chromium.launch();
  const times: number[] = [];
  try {
    for (let load = 0; load < options.loads; load++) {
      const context = await browser.newContext({ baseURL: options.origin });
      try {
        await context.addCookies(cookiesOf(options.cookie, options.origin));
        const page = await context.newPage();
        await page.addInitScript(() => {
          const w = window as unknown as { __lcp: number };
          w.__lcp = -1;
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries()) w.__lcp = entry.startTime;
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        });
        await page.goto(options.path, { waitUntil: 'load' });
        // The paint can come after the load event; the page is then left a moment to settle.
        await page.waitForTimeout(1000);
        const lcp = await page.evaluate(() => (window as unknown as { __lcp: number }).__lcp);
        if (lcp < 0) throw new Error(`No largest contentful paint was reported for ${options.path}.`);
        times.push(lcp);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
  return times;
}
