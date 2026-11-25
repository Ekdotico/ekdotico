// Two fixes of the live walk of 25 November 2026, held as source checks (W-5, W-2).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('live walk, batch 1', () => {
  it('W-5: the sessions block stands in the same column as the forms above it', () => {
    const page = read('src/app/(app)/settings/page.tsx');
    expect(page).toMatch(/aria-labelledby="sessions-heading" className=\{styles\.narrow\}/);
  });

  it('W-8: the toolbar keeps one row at its own width, so the component can move it left', () => {
    const css = read('src/app/(app)/documents/[id]/editor.module.css');
    expect(css).toMatch(/\.toolbar \{[^}]*inline-size: max-content;[^}]*max-inline-size: 100%;/s);
  });

  it('W-2: above the selection the toolbar tooltips open downwards, off "Choose an image"', () => {
    const toolbar = read('src/app/(app)/documents/[id]/selection-toolbar.tsx');
    expect(toolbar).toContain("placement={place?.below ? 'top' : 'bottom'}");
  });
});
