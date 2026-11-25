import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Source pins for the narrow-widths walk, N-4: the row under a document's title is one control to a line at
// phone width, and untouched from 768 px up. No phone project exists in the end-to-end suite.
const css = readFileSync('src/app/pages.module.css', 'utf8');
const page = readFileSync('src/app/(app)/documents/[id]/page.tsx', 'utf8');

describe('the row under the title (N-4)', () => {
  it('is a column only below 768px', () => {
    const rule = /@media \(max-width: 767\.98px\) \{\s*\.titleRow \{([^}]*)\}/.exec(css);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/flex-direction: column/);
  });

  it('narrows only the sheet side padding below 768px and keeps the Insert room (N-2)', () => {
    const sheet = readFileSync('src/app/(app)/documents/[id]/editor.module.css', 'utf8');
    expect(sheet).toMatch(/@media \(max-width: 767\.98px\) \{\s*\.sheet \{\s*padding-inline: var\(--sp-2\);/);
    expect(sheet).toMatch(/\.writable \{\s*padding-inline-end: var\(--sp-8\);/);
  });

  it('scrolls the toolbar sideways below 768px, and leaves W-8 alone above it (N-3)', () => {
    const sheet = readFileSync('src/app/(app)/documents/[id]/editor.module.css', 'utf8');
    const tsx = readFileSync('src/app/(app)/documents/[id]/selection-toolbar.tsx', 'utf8');
    expect(sheet).toMatch(/\.toolbarScroll,\s*\.toolbarTrack \{\s*display: contents;/);
    const phone = /@media \(max-width: 767\.98px\) \{\s*\.toolbarScroll \{([^}]*)\}/.exec(sheet)?.[1] ?? '';
    expect(phone).toMatch(/overflow-x: auto/);
    expect(phone).toMatch(/mask-image: linear-gradient/);
    expect(sheet).toMatch(/inline-size: max-content;\s*max-inline-size: 100%;/);
    expect(tsx).toMatch(
      /styles\.toolbarScroll[\s\S]*styles\.toolbarTrack[\s\S]*<Toolbar label="Formatting" floating>/,
    );
  });

  // A source pin reads the files, not the cascade: it cannot compute which rule wins. What it can hold is the cause
  // of the first N-4 miss: the row was a package Cluster, whose `[data-align]` selector outranked this class's
  // `align-items`. So the row is not a Cluster, and the app class owns both alignments.
  it("is the app's own box, with no package layout whose selector could outrank it", () => {
    expect(page).toMatch(/<div className=\{styles\.titleRow\}>/);
    expect(page).not.toMatch(/<Cluster/);
    const base = /\n\.titleRow \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(base).toMatch(/display: flex;/);
    expect(base).toMatch(/flex-wrap: wrap;/);
    expect(base).toMatch(/align-items: center;/);
    expect(base).toMatch(/gap: var\(--sp-3\);/);
    const phone = /@media \(max-width: 767\.98px\) \{\s*\.titleRow \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(phone).toMatch(/align-items: flex-start;/);
  });
});
