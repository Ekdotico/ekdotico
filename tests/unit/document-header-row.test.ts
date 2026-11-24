import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dir = 'src/app/(app)/documents/[id]/';
const page = readFileSync(`${dir}page.tsx`, 'utf8');
const exportDraft = readFileSync(`${dir}export-draft.tsx`, 'utf8');
const editor = readFileSync(`${dir}editor.tsx`, 'utf8');

describe('the document header row (modernisation A2)', () => {
  it('draws Sharing as a quiet ButtonLink and Export as a quiet Button, with the labels unchanged', () => {
    expect(page).toMatch(
      /<ButtonLink variant="quiet" href=\{`\/documents\/\$\{document\.id\}\/sharing`\}>\s*Sharing\s*<\/ButtonLink>/,
    );
    expect(exportDraft).toMatch(/<Button\s+variant="quiet"/);
    expect(exportDraft).toContain("const LABEL = 'Export as Markdown';");
  });

  it('keeps the order title, Sharing, Export, people, status on one baseline', () => {
    // The title is its own line, the controls one Cluster under it.
    expect(page).toMatch(
      /<Stack gap=\{3\}>\s*\{\/\*[^]*?<DocumentTitle[^]*?<Cluster gap=\{3\} align="center">/,
    );
    const order = [
      '<DocumentTitle',
      'href={`/documents/${document.id}/sharing`}',
      '<ExportDraft',
      'id={PEOPLE_SLOT}',
      'id={STATUS_SLOT}',
    ].map((s) => page.indexOf(s));
    expect(order.every((n) => n >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('lets the status wrap inside the row, so that a long label never adds a row', () => {
    expect(page).toContain('styles.statusSlot');
    const css = readFileSync('src/app/pages.module.css', 'utf8');
    // A floor of one size for every label, never one taken from the label: the status is then on the same line
    // whatever it says, and is never squeezed to less than a word (it ran past a 320 screen with a floor of 0).
    expect(css).toMatch(/\.statusSlot\s*\{[^}]*flex:\s*1 1 0;[^}]*min-inline-size:\s*var\(--sp-12\);/);
  });

  it('puts the sync status in its slot in the header', () => {
    expect(editor).toContain('document.getElementById(STATUS_SLOT)');
  });
});
