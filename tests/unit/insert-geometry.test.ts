// The Insert control's geometry: a 20px box with a target of at least 24px, and a middle on the line box.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lineCentre } from '../../src/app/(app)/documents/[id]/line-centre.ts';

const css = readFileSync('src/app/(app)/documents/[id]/editor.module.css', 'utf8');
const rule = (selector: string) => css.slice(css.indexOf(`${selector} {`)).match(/\{([^}]*)\}/)![1]!;

describe('the target of the Insert control', () => {
  it('is at least 24px square around a 20px box with a 1px border', () => {
    const own = rule('.insertButton');
    const size = Number(/--insert-box: (\d+)px/.exec(rule('.writable'))![1]);
    const border = Number(/border: (\d+)px/.exec(own)![1]);
    const inset = Number(/inset: -(\d+)px/.exec(rule('.insertButton::before'))![1]);
    expect(size).toBe(20);
    expect(own).toContain('inline-size: var(--insert-box)');
    expect(own).toContain('block-size: var(--insert-box)');
    // The wrapper that is centred on the line is exactly as tall as the box, or it centres its own height.
    expect(rule('.insert')).toContain('block-size: var(--insert-box)');
    // The inset is taken from the padding box, inside the border.
    expect(size - 2 * border + 2 * inset).toBeGreaterThanOrEqual(24);
  });
});

describe('the placeholder offset of an empty block', () => {
  it('is the control box plus its gap, from the same two properties, set where the control is', () => {
    const writable = rule('.writable');
    expect(writable).toContain(
      '--ekd-editor-placeholder-offset: calc(var(--insert-box) + var(--insert-gap))',
    );
    expect(writable).toContain('--insert-gap: var(--sp-2)');
    expect(rule('.insert')).toContain('margin-inline-start: var(--insert-gap)');
    // Nowhere else: the reader's surface has no control and no offset.
    expect(css.match(/--ekd-editor-placeholder-offset:/g)).toHaveLength(1);
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
