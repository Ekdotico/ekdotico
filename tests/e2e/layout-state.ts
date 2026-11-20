import type { Locator } from '@playwright/test';

/**
 * Where the page stands, so that a failure of a test that compares layout names what moved: the scroll, the top
 * of the text and of the block it sits in, and the height and words of everything that precedes the text at each
 * level of the page (the header's rows, a notice, a status line).
 */
export async function layoutState(text: Locator): Promise<string> {
  const state = await text.evaluate((element) => {
    const name = (node: Element) =>
      `${node.tagName.toLowerCase()}.${String(node.getAttribute('class') ?? '').slice(0, 40)}`;
    const above: string[] = [];
    for (let node: Element | null = element; node && node !== document.body; node = node.parentElement) {
      for (let before = node.previousElementSibling; before; before = before.previousElementSibling) {
        const box = before.getBoundingClientRect();
        const words = (before.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        above.push(`${name(before)} h=${box.height} top=${box.top} "${words}"`);
      }
    }
    return {
      scrollY: window.scrollY,
      textTop: element.getBoundingClientRect().top,
      blockTop: element.parentElement?.getBoundingClientRect().top,
      above,
    };
  });
  return JSON.stringify(state);
}
