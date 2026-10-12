// The keyboard shortcuts of the editor (FR-ED-13; in α 0.1.0 every row but the
// comment shortcut, Build phases). After this extension the editor answers to
// the requirement's list and to no other formatting shortcut.
//
// The library already binds most of the list: bold, italic, underline,
// strikethrough, undo, redo, and Tab and Shift+Tab in a list item. Two are
// added here, inline code on the requirement's key and the hyperlink. The
// library's others are taken away (REMOVED). What stays beside the list is
// what a person edits text with and no formatting: Enter, Backspace, Delete,
// the arrows, the platform's own keys for deleting a word or a line and for
// selecting everything, the line break, Tab between the cells of a table,
// and Ctrl+Y, which is redo on Windows.
//
// ProseMirror runs none of this while the document is read-only (FR-ED-18).
import { Extension } from '@tiptap/core';
import { keydownHandler } from '@tiptap/pm/keymap';
import { Plugin } from '@tiptap/pm/state';

/** Sent from the text, and heard by the toolbar, which holds the dialog of a link (./selection-toolbar.tsx). */
export const EDIT_LINK = 'ekdotico-edit-link';

/** The requirement's list, in its order, as the editor names each key. `Mod` is Cmd on Apple platforms and Ctrl elsewhere. */
export const SHORTCUTS = [
  'Mod-b',
  'Mod-i',
  'Mod-u',
  'Mod-Shift-s',
  'Mod-`',
  'Mod-k',
  'Mod-z',
  'Mod-Shift-z',
  'Tab',
  'Shift-Tab',
] as const;

/**
 * The library's shortcuts that are not on the list: the paragraph, the three
 * headings, the two lists, the blockquote, the code block, inline code on its
 * other key, highlight, subscript and superscript.
 * tests/unit/editor-keys.test.ts fails when the library binds one that is
 * neither here nor accounted for.
 */
export const REMOVED = [
  'Mod-Alt-0',
  'Mod-Alt-1',
  'Mod-Alt-2',
  'Mod-Alt-3',
  'Mod-Shift-7',
  'Mod-Shift-8',
  'Mod-Shift-b',
  'Mod-Alt-c',
  'Mod-e',
  'Mod-Shift-h',
  'Mod-,',
  'Mod-.',
] as const;

export const Shortcuts = Extension.create({
  name: 'shortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-`': () => this.editor.isEditable && this.editor.commands.toggleCode(),
      // "Insert or edit hyperlink": on selected text that may carry a link, or
      // with the cursor in one. The key is the editor's in either case, so
      // the browser's own use of it never follows.
      'Mod-k': () => {
        const { editor } = this;
        const text = !editor.state.selection.empty && editor.can().toggleMark('link');
        if (editor.isEditable && (text || editor.isActive('link'))) {
          editor.view.dom.dispatchEvent(new Event(EDIT_LINK, { bubbles: true }));
        }
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    // Matched as the library matches its own, and answered before it: the
    // editor then does nothing with the key, and the key is not taken from
    // the browser either.
    const removed = keydownHandler(Object.fromEntries(REMOVED.map((chord) => [chord, () => true])));
    return [new Plugin({ props: { handleDOMEvents: { keydown: (view, event) => removed(view, event) } } })];
  },
});
