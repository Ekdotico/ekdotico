// The Insert control's geometry: a 20px box with a target of at least 24px, and a middle on the line box.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineCentre } from '../../src/app/(app)/documents/[id]/line-centre.ts';

const css = readFileSync('src/app/(app)/documents/[id]/editor.module.css', 'utf8');
const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).match(/\{([^}]*)\}/)![1]!;

describe('the target of the Insert control', () => {
  it('is at least 24px square around a 20px box with a 1px border', () => {
    const own = rule('.insertButton');
    const size = Number(/inline-size: (\d+)px/.exec(own)![1]);
    const border = Number(/border: (\d+)px/.exec(own)![1]);
    const inset = Number(/inset: -(\d+)px/.exec(rule('.insertButton::before'))![1]);
    expect(size).toBe(20);
    // The inset is taken from the padding box, inside the border.
    expect(size - 2 * border + 2 * inset).toBeGreaterThanOrEqual(24);
  });
});

describe('the middle of the line', () => {
  it('is the middle of the line box, not of the glyph box (17px text on a 28.05px line)', () => {
    // Glyph box 17px tall, 5.5px under the top of the first line: middle 14, line box middle 14.025.
    expect(lineCentre(105.5, 122.5, 100, 28.05)).toBeCloseTo(114.025, 3);
    // The second line of the block.
    expect(lineCentre(133.55, 150.55, 100, 28.05)).toBeCloseTo(142.075, 3);
  });

  it('keeps the caret middle where the line height is not a number', () => {
    expect(lineCentre(10, 30, 0, Number.NaN)).toBe(20);
  });
});
