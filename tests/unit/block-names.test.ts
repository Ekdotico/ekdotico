// The names of the controls of a code block and an image block (owner's answer to ux-block-names-wording, "with-place").
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeBlockName, imageAltName, placeAmong } from '../../src/lib/editor/block-names.ts';

describe('block names', () => {
  it('pins the approved texts whole', () => {
    expect(codeBlockName('Copy', 'Python', { n: 2, m: 3 })).toBe('Copy, Python code block 2 of 3');
    expect(codeBlockName('Code language', null, { n: 2, m: 3 })).toBe('Code language, code block 2 of 3');
    expect(codeBlockName('Copy', null, { n: 2, m: 3 })).toBe('Copy, code block 2 of 3');
    expect(imageAltName('', { n: 2, m: 3 })).toBe('Alt text, image 2 of 3');
    expect(imageAltName('The north front', { n: 2, m: 3 })).toBe('Alt text, The north front');
  });
  it('shows 1 of 1 for a single block', () => {
    expect(codeBlockName('Copy', 'Go', { n: 1, m: 1 })).toBe('Copy, Go code block 1 of 1');
    expect(imageAltName('', { n: 1, m: 1 })).toBe('Alt text, image 1 of 1');
  });
  it('counts many, and begins with the visible label', () => {
    expect(codeBlockName('Copy', 'SQL', { n: 12, m: 40 })).toBe('Copy, SQL code block 12 of 40');
    expect(codeBlockName('Code language', 'SQL', { n: 1, m: 2 }).startsWith('Code language')).toBe(true);
    expect(imageAltName('x', null).startsWith('Alt text')).toBe(true);
  });
  it('falls back to the visible label alone before the place is known', () => {
    expect(codeBlockName('Copy', 'Python', null)).toBe('Copy');
    expect(imageAltName('', null)).toBe('Alt text');
  });
  it('places a block among those of its kind in document order', () => {
    expect(placeAmong([3, 10, 20], 10)).toEqual({ n: 2, m: 3 });
    expect(placeAmong([3], 3)).toEqual({ n: 1, m: 1 });
    expect(placeAmong([3], 4)).toBeNull();
  });
  it('is used by the controls', () => {
    const dir = 'src/app/(app)/documents/[id]/';
    const extensions = readFileSync(`${dir}extensions.tsx`, 'utf8');
    expect(extensions).toContain("codeBlockName('Copy', shownLanguage, place)");
    // After a copy the visible word is "Copied", and the name is that word.
    expect(extensions).toContain("copied === 'yes' ? undefined");
    expect(extensions).toContain("codeBlockName('Code language', shownLanguage, place)");
    expect(extensions).toContain("useBlockPlace(editor, getPos, 'codeBlock')");
    const images = readFileSync(`${dir}images.tsx`, 'utf8');
    expect(images).toContain('imageAltName(caption, place)');
    expect(images).toContain("useBlockPlace(editor, getPos, 'image')");
  });
});
