// The cursors of the other people in a document (FR-ED-17): what the editor
// draws from the awareness the collaboration server relays, and nothing else.
// The server holds each connection's name and slot (src/lib/collab/presence.ts,
// `pinAwareness`), so what arrives is trusted for who and in which colour; it
// is still read as data, since another version of the server, or a peer that
// gets round it, can send anything: a state with no name, or with a slot
// outside the colour set, draws nothing.
//
// The drawing is `yCursorPlugin` of @tiptap/y-tiptap, which needs the binding
// of the Collaboration extension: a browser that cannot edit has none (D185),
// so a reader neither shows nor sends a cursor (docs/plan/slice-14.md, S14-1).
import { Extension } from '@tiptap/core';
import type { DecorationAttrs } from '@tiptap/pm/view';
import { yCursorPlugin } from '@tiptap/y-tiptap';
import type { Awareness } from 'y-protocols/awareness';
import { isSlot } from '../../../../lib/collab/presence.ts';
import styles from './editor.module.css';

/** What a state of awareness says of its person, where it says a name and a slot of the colour set, else null. */
function whoIs(user: unknown): { name: string; slot: number } | null {
  if (typeof user !== 'object' || user === null) return null;
  const { name, slot } = user as { name?: unknown; slot?: unknown };
  return typeof name === 'string' && name !== '' && isSlot(slot) ? { name, slot } : null;
}

/** The people who are drawn: not this client, and only those whose state says who they are. */
export function drawn(current: number, other: number, state: { user?: unknown } | null): boolean {
  return current !== other && whoIs(state?.user) !== null;
}

/**
 * The caret of a person, and the label above it, which is the caret's
 * `::after` and shows the attribute `data-name`. The name is set as an
 * attribute, so that nothing a name holds is read as markup, and is drawn by
 * the stylesheet and not placed in the text: the text of the editor, which is
 * what the page's `innerText` and the tests read, is the document's and holds
 * no one's name. The caret is hidden from a screen reader as well: what a
 * screen reader is told of who is present is another question
 * (docs/plan/slice-14.md, S14-6).
 */
export function caretOf(user: unknown): HTMLElement {
  const who = whoIs(user);
  const caret = document.createElement('span');
  caret.className = `${styles.caret} ${who ? (styles[`slot${who.slot}`] ?? '') : ''}`;
  caret.setAttribute('aria-hidden', 'true');
  caret.setAttribute('data-name', who?.name ?? '');
  return caret;
}

/** The wash over what a person has selected. */
export function selectionOf(user: unknown): DecorationAttrs {
  const who = whoIs(user);
  return { class: who ? (styles[`selection${who.slot}`] ?? '') : '' };
}

/**
 * The extension that draws them. With no awareness, which a browser that
 * cannot edit does not use (`reads`), it adds nothing.
 */
export const Cursors = Extension.create<{ awareness: Awareness | null }>({
  name: 'cursors',
  addOptions: () => ({ awareness: null }),
  addProseMirrorPlugins() {
    const { awareness } = this.options;
    if (!awareness) return [];
    return [
      yCursorPlugin(awareness, {
        awarenessStateFilter: drawn,
        cursorBuilder: caretOf,
        selectionBuilder: selectionOf,
      }),
    ];
  },
});
