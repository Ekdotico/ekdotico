import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'src/app/(app)/documents/[id]/';
const css = readFileSync(`${dir}editor.module.css`, 'utf8');
const tsx = readFileSync(`${dir}editor.tsx`, 'utf8');

/** The body of the first rule whose selector is exactly `selector`, outside any at-rule. */
function rule(source: string, selector: string): string {
  const match = new RegExp(`(?:^|\\n)${selector.replace('.', '\\.')} \\{([^}]*)\\}`).exec(source);
  expect(match, `${selector} rule`).not.toBeNull();
  return match![1]!;
}

describe('the document sheet (modernisation A1)', () => {
  const sheet = rule(css, '.sheet');

  it('is a surface with a hairline, the large radius and the resting shadow, by tokens', () => {
    expect(sheet).toContain('background-color: var(--bg-surface)');
    expect(sheet).toContain('border: 1px solid var(--rule-soft)');
    expect(sheet).toContain('border-radius: var(--radius-lg)');
    expect(sheet).toContain('box-shadow: var(--shadow-1)');
  });

  it('pads --sp-4 at phone width and --sp-8 from 768px', () => {
    expect(sheet).toContain('padding: var(--sp-4)');
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*\.sheet \{\s*padding: var\(--sp-8\);/);
  });

  it('has no shadow in print', () => {
    expect(css).toMatch(/@media print \{\s*\.sheet \{[^}]*box-shadow: none;/);
  });

  it('sets no width, so the column and the measure are unchanged, and no literal', () => {
    expect(sheet).not.toMatch(/(?:inline-size|width)/);
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });

  it('wraps the hint, the picker and the surface, with no role or tab stop', () => {
    const open = tsx.indexOf('className={styles.sheet}');
    expect(open).toBeGreaterThan(0);
    const inside = tsx.slice(open, tsx.indexOf('</Editable.Provider>'));
    expect(inside).toContain('{KEYS}');
    expect(inside).toContain('IMAGE_TEXT.choose');
    expect(inside).toContain('ref={surface}');
    expect(tsx.slice(open - 40, open + 30)).not.toMatch(/role=|tabIndex/);
  });
});
