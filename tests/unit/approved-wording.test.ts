// Words the owner approved on the App UX/UI Questions page, pinned whole where no other test holds them
// (ux-3, 25 November 2026). The texts are written out here from each question's `what` and the chosen option,
// and not taken from the code under test: a word changed there fails here until the owner has approved it.
// The other approved texts are pinned in account-answers, block-names, documents-statements, editor,
// editor-answers, ended-text, error-page, presence, proxy-limit-page, shell-header-phone and visitors.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syncStatus } from '../../src/lib/collab/client.ts';
import { RENAMED_STATEMENT } from '../../src/app/(app)/renamed-statement.ts';

const read = (path: string) => readFileSync(path, 'utf8');
const UNSENT = 'Changes that are not yet sent are lost if this tab is closed.';

describe('ux-readonly-cue: the words of the connection states, whole', () => {
  it('says the restoring state, with the warning only while changes are unsent', () => {
    const restoring =
      'Restoring the connection. Ekdotico keeps changes in this tab and sends them when the connection returns.';
    expect(syncStatus({ phase: 'restoring', unsent: true, opened: true }).label).toBe(
      `${restoring} ${UNSENT}`,
    );
    expect(syncStatus({ phase: 'restoring', unsent: false, opened: true }).label).toBe(restoring);
  });

  it('says the lost state, with the warning only while changes are unsent', () => {
    const lost =
      'Not connected. The document is read-only until the connection returns. Check the connection. Ekdotico tries again automatically.';
    expect(syncStatus({ phase: 'lost', unsent: true, opened: true }).label).toBe(`${lost} ${UNSENT}`);
    expect(syncStatus({ phase: 'lost', unsent: false, opened: true }).label).toBe(lost);
  });
});

describe('ux-toolbar-keys (leave): the sentence that tells of Alt+F10 stays as it is', () => {
  it('reads in full', () => {
    expect(read('src/app/(app)/documents/[id]/editor.tsx')).toContain(
      'Alt+F10 moves from the text to the formatting toolbar when text is selected. When no text is selected, Alt+F10 moves to the controls of the block that holds the cursor. Escape returns to the text.',
    );
  });
});

describe('ux-name-in-document, ux-title-domico, ux-rename-statement: the title of the document page', () => {
  const source = read('src/app/(app)/documents/[id]/document-title.tsx');

  it('is named "Title" and says "Document renamed."', () => {
    expect(source).toContain('label="Title"');
    expect(RENAMED_STATEMENT).toBe('Document renamed.');
    expect(source).toContain('RENAMED_STATEMENT');
  });
});

describe('ux-revoke-confirm: the buttons of the dialog', () => {
  it('are "Revoke invitation" and "Cancel"', () => {
    const source = read('src/app/(app)/documents/[id]/sharing/sharing-settings.tsx');
    expect(source).toMatch(/onClick=\{onCancel\}[^>]*>\s*Cancel\s*<\/Button>|Cancel\s*<\/Button>/);
    expect(source).toMatch(/Revoke invitation\s*<\/Button>/);
  });
});
