// The owner's answers for the editor page: words pinned whole, and source-level guards for what a unit test
// cannot render (the page needs a browser and a server).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { syncStatus } from '../../src/lib/collab/client.ts';
import { REDONE, SYNC_HELP, UNDONE } from '../../src/app/(app)/documents/[id]/spoken.ts';

const editor = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
const extensions = readFileSync('src/app/(app)/documents/[id]/extensions.tsx', 'utf8');

describe('the editor page: the owner answers', () => {
  it('ux-readonly-cue: the words of the lost state are the indicator’s, shown once more above the text', () => {
    const { label } = syncStatus({ phase: 'lost', unsent: true, opened: true });
    expect(label).toBe(
      'Not connected. The document is read-only until the connection returns. Check the connection. Ekdotico tries again automatically. Changes that are not yet sent are lost if this tab is closed.',
    );
    expect(editor).toContain("state.phase === 'lost' && state.opened");
    expect(editor).toContain('<p>{status.label}</p>');
  });

  it('ux-undo-words: undo and redo are spoken, whole', () => {
    expect([UNDONE, REDONE]).toEqual(['Undone.', 'Redone.']);
    expect(extensions).toContain("'Mod-z': said('Mod-z', UNDONE)");
    expect(extensions).toContain("'Mod-y': said('Mod-y', REDONE)");
    expect(extensions).toContain("'Shift-Mod-z': said('Shift-Mod-z', REDONE)");
    expect(editor).toContain('<Heard kind="history"');
  });

  it('ux-sync-button-name: the button is described, and keeps its label for a name', () => {
    expect(SYNC_HELP).toBe('Checks the working version against the server.');
    expect(editor).toContain('aria-describedby={syncHelp}');
    expect(editor).toContain('label={status.label}');
  });

  it('ux-toc-focus: a reader’s focus moves to the heading', () => {
    expect(extensions).toContain("heading.setAttribute('tabindex', '-1')");
  });

  it('ux-image-added-stays: the line is drawn only with words, and "Image added" goes at the next change', () => {
    expect(editor).toContain('{uploading ? <p className={pageStyles.meta}>{uploading}</p> : null}');
    expect(editor).toContain('<Heard kind="upload"');
    expect(editor).toContain("editor.on('update', changed)");
    expect(editor).toContain('was === IMAGE_TEXT.added');
  });
});
