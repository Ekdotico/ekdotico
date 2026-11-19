// The Insert control appears when the pointer is near it, is not seen at rest, and does not glide.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isNear, REACH } from '../../src/app/(app)/documents/[id]/near.ts';

const box = { left: 100, right: 120, top: 50, bottom: 70 };

describe('near the Insert control', () => {
  it('is anywhere inside the box', () => {
    expect(isNear({ x: 110, y: 60 }, box)).toBe(true);
  });

  it('is within the reach of the nearest edge, and no further', () => {
    expect(isNear({ x: 120 + REACH, y: 60 }, box)).toBe(true);
    expect(isNear({ x: 120 + REACH + 1, y: 60 }, box)).toBe(false);
    expect(isNear({ x: 110, y: 50 - REACH }, box)).toBe(true);
    expect(isNear({ x: 110, y: 50 - REACH - 1 }, box)).toBe(false);
  });

  it('measures a corner by the straight line to it', () => {
    // 3-4-5: 30 across and 40 down from the corner is 50 away.
    expect(isNear({ x: 150, y: 110 }, box, 50)).toBe(true);
    expect(isNear({ x: 151, y: 110 }, box, 50)).toBe(false);
  });
});

describe('the Insert control in the stylesheet', () => {
  const css = readFileSync('src/app/(app)/documents/[id]/editor.module.css', 'utf8');
  const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).match(/\{([^}]*)\}/)![1]!;

  it('is not seen at rest, and appears near the pointer and under the keyboard', () => {
    expect(rule('.insert')).toContain('opacity: 0;');
    expect(css).toMatch(/\.insert\[data-near='true'\],\n\.insert:focus-within \{\n {2}opacity: 1;/);
  });

  it('animates its appearing and never its place', () => {
    expect(rule('.insert')).toContain('transition: opacity var(--dur-fast) var(--ease-soft);');
    expect(css).not.toMatch(/transition:[^;]*\b(left|top)\b/);
  });

  it('is solid under the pointer and the focus, and takes the package icon at its own size', () => {
    expect(css).toMatch(
      /\.insertButton:hover,\n\.insertButton:focus-visible \{\n {2}background: var\(--fg-1\);\n {2}color: var\(--bg-canvas\);/,
    );
    expect(css).not.toContain('.insertButton svg');
  });
});
