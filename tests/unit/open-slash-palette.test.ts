// The Insert control's way to the palette (ui-dc-insert): `openSlashPalette` types the `/` for the writer, so the
// palette is the same one, under the rules of FR-ED-10. WRITTEN, NOT RUN.
import { Editor, type JSONContent } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  chooseSlashCommand,
  openSlashPalette,
  slashPalette,
} from '../../src/app/(app)/documents/[id]/slash-palette.tsx';
import { SLASH_COMMANDS } from '../../src/lib/editor/slash-commands.ts';

const paragraph = (text?: string): JSONContent => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

function editorOf(content: JSONContent[], cursor: number) {
  const made = new Editor({
    element: null,
    content: { type: 'doc', content },
    extensions: extensions(new Y.Doc()),
  });
  made.view.updateState(made.state.reconfigure({ plugins: made.extensionManager.plugins }));
  made.commands.setTextSelection(cursor);
  return made;
}

describe('opening the palette from the Insert control (FR-ED-10)', () => {
  it('opens it in an empty block, with every command, as the typed slash does', () => {
    const editor = editorOf([paragraph()], 1);
    expect(openSlashPalette(editor)).toBe(true);
    expect(editor.state.doc.textContent).toBe('/');
    expect(slashPalette(editor.state).options.map(({ id }) => id)).toEqual(
      SLASH_COMMANDS.map(({ name }) => name),
    );
  });

  it('opens it after a space that is already there, adding none', () => {
    const editor = editorOf([paragraph('word ')], 6);
    expect(openSlashPalette(editor)).toBe(true);
    expect(editor.state.doc.textContent).toBe('word /');
  });

  it('adds the space a slash needs after a word', () => {
    const editor = editorOf([paragraph('word')], 5);
    expect(openSlashPalette(editor)).toBe(true);
    expect(editor.state.doc.textContent).toBe('word /');
    expect(slashPalette(editor.state).open).toBe(true);
  });

  it('leaves nothing behind where the rules do not open it: the start of a block that holds text', () => {
    const editor = editorOf([paragraph('word')], 1);
    expect(openSlashPalette(editor)).toBe(false);
    expect(editor.state.doc.textContent).toBe('word');
    expect(slashPalette(editor.state).open).toBe(false);
  });

  it('does nothing where the document cannot be edited', () => {
    const editor = editorOf([paragraph()], 1);
    editor.setEditable(false);
    expect(openSlashPalette(editor)).toBe(false);
    expect(editor.state.doc.textContent).toBe('');
  });

  it('places a chosen block as the slash does, through the same choice', () => {
    const editor = editorOf([paragraph()], 1);
    openSlashPalette(editor);
    chooseSlashCommand(editor, 'divider');
    expect(slashPalette(editor.state).open).toBe(false);
    expect(editor.state.doc.textContent).not.toContain('/');
  });
});
