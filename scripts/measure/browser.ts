// The typing browser of procedure 1: Chromium under Playwright, signed in with an account's cookie, typing at the
// end of the document with the keyboard. The page notes the clock at each `keydown`, and the clock at the end of the
// frame in which the character is drawn: a MutationObserver finds the change to the editor, and the end of the
// frame is taken as the task that follows the next animation frame (a MessageChannel message after
// `requestAnimationFrame`). The page is the application's own, under its Content-Security-Policy, so the
// instrumentation is added by Playwright's init script, which the policy does not govern.
import { chromium } from '@playwright/test';
import type { Typist } from './harness.ts';

export function cookiesOf(header: string, origin: string) {
  return header
    .split(';')
    .map((pair) => pair.trim())
    .filter(Boolean)
    .map((pair) => {
      const at = pair.indexOf('=');
      return { name: pair.slice(0, at), value: pair.slice(at + 1), url: origin };
    });
}

export async function browserTypist(options: {
  origin: string;
  cookie: string;
  documentId: string;
}): Promise<Typist> {
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: options.origin });
  await context.addCookies(cookiesOf(options.cookie, options.origin));
  await context.addInitScript(() => {
    const w = window as unknown as { __keys: number[]; __renders: number[]; __pending: number[] };
    w.__keys = [];
    w.__renders = [];
    w.__pending = [];
    addEventListener(
      'keydown',
      (event) => {
        if (event.key.length !== 1) return;
        const at = performance.timeOrigin + event.timeStamp;
        w.__keys.push(at);
        w.__pending.push(at);
      },
      true,
    );
    const channel = new MessageChannel();
    const waiting: (() => void)[] = [];
    channel.port1.onmessage = () => waiting.shift()?.();
    new MutationObserver(() => {
      const started = w.__pending.shift();
      if (started === undefined) return;
      requestAnimationFrame(() => {
        waiting.push(() => w.__renders.push(performance.timeOrigin + performance.now() - started));
        channel.port2.postMessage(0);
      });
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  const page = await context.newPage();
  await page.goto(`/documents/${options.documentId}`);
  const editor = page.locator('.ProseMirror').first();
  await editor.waitFor({ timeout: 30_000 });
  await editor.click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  // The characters in the last paragraph already: counted from the page, as the receivers count them.
  const base = await page.evaluate(() => {
    const paragraphs = document.querySelectorAll('.ProseMirror p');
    return paragraphs[paragraphs.length - 1]?.textContent?.length ?? 0;
  });
  return {
    base: () => base,
    async type(char) {
      await page.keyboard.type(char);
    },
    keyTimes: () => page.evaluate(() => (window as unknown as { __keys: number[] }).__keys),
    renderTimes: async () => {
      // The last frame may not have been drawn yet.
      await page.waitForTimeout(500);
      return page.evaluate(() => (window as unknown as { __renders: number[] }).__renders);
    },
    close: () => browser.close(),
  };
}
