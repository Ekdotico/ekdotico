import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source pins for the narrow-widths walk, N-4: the row under a document's title is one control to a line at
// phone width, and untouched from 768 px up. No phone project exists in the end-to-end suite.
const css = readFileSync('src/app/pages.module.css', 'utf8');
const page = readFileSync('src/app/(app)/documents/[id]/page.tsx', 'utf8');

describe('the row under the title (N-4)', () => {
  it('is a column only below 768px, and sets nothing the cluster sets', () => {
    const rule = /@media \(max-width: 767\.98px\) \{\s*\.titleRow \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/flex-direction: column/);
    expect(rule?.[1]).not.toMatch(/gap/);
  });

  it('narrows only the sheet side padding below 768px and keeps the Insert room (N-2)', () => {
    const sheet = readFileSync('src/app/(app)/documents/[id]/editor.module.css', 'utf8');
    expect(sheet).toMatch(/@media \(max-width: 767\.98px\) \{\s*\.sheet \{\s*padding-inline: var\(--sp-2\);/);
    expect(sheet).toMatch(/\.writable \{\s*padding-inline-end: var\(--sp-8\);/);
  });

  it('is the class of the header cluster', () => {
    expect(page).toMatch(/<Cluster gap=\{3\} align="center" className=\{styles\.titleRow\}>/);
  });
});
