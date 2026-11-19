'use client';

// The "Insert" control (audit row F05; the owner's decisions ui-dc-insert and its sketch of 17 November 2026,
// and the owner's word of 19 November 2026 on how it looks and moves): a plus a step to the right of the
// cursor, on the cursor's line, which acts as a typed "/" when pressed (./slash-palette.tsx,
// `openSlashPalette`): the same palette, list and choice.
//
// It is not seen at rest. It appears when the pointer comes near the cursor, and turns solid under the
// pointer itself. It stands where the cursor stands in the same frame: it does not glide.
//
// It is placed only where nothing follows the cursor in its block, so it never covers text: at the end of a
// text block, empty or not, as the sketch has it. Elsewhere it is hidden with `visibility`, never removed from
// the page.

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { useEditorState, type Editor } from '@tiptap/react';
import { Tooltip } from '@ekdotico/domico/components';
import { PlusIcon } from '@ekdotico/domico/icons';
import styles from './editor.module.css';
import { INSERT_NAME } from './insert-name.ts';
import { lineCentre } from './line-centre.ts';
import { isNear, type Point } from './near.ts';
import { openSlashPalette } from './slash-palette.tsx';

/** The gap between the cursor and the control, from the stylesheet's own `--insert-gap`, in pixels. */
const getGap = (element: HTMLElement) => Number.parseFloat(getComputedStyle(element).marginInlineStart) || 0;

/** A collapsed cursor at the end of a text block that is not code: the only place the control is shown. */
function endsBlock(state: EditorState): boolean {
  const { selection } = state;
  const { $head } = selection;
  return (
    selection.empty &&
    $head.parent.isTextblock &&
    !$head.parent.type.spec.code &&
    $head.parentOffset === $head.parent.content.size
  );
}

/**
 * Whether the pointer is near the control, written to the element as `data-near`: the stylesheet shows the
 * control by it. Read after every placement too, since the control comes to a resting pointer as well as
 * the pointer to it.
 */
function reveal(element: HTMLElement | null, pointer: Point | null) {
  if (!element) return;
  const near =
    pointer !== null &&
    element.style.visibility !== 'hidden' &&
    isNear(pointer, element.getBoundingClientRect());
  element.dataset.near = String(near);
}

/** Beside the cursor, in the margin the surface keeps for it. Shown only to a person who may edit. */
export function InsertButton({
  editor,
  surface,
}: {
  editor: Editor;
  surface: RefObject<HTMLDivElement | null>;
}) {
  // Where the cursor is, and whether it is at the end of a text block that is not code. The size of the
  // document is read too, so that a change of the text above, which moves the line, is seen.
  const cursor = useEditorState({
    editor,
    selector: ({ editor: current }) => {
      const { selection, doc } = current.state;
      return { head: selection.head, size: doc.content.size, atEnd: endsBlock(current.state) };
    },
  });
  const control = useRef<HTMLDivElement>(null);
  // Where the pointer last was, in the viewport; null until a mouse or a pen has moved, after it has left
  // the page, and from a change of the text until it moves again, so that nothing appears beside the
  // words while they are typed.
  const pointer = useRef<Point | null>(null);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      // A finger has no place between its touches; a touch screen shows the control always (the stylesheet).
      if (event.pointerType === 'touch') return;
      pointer.current = { x: event.clientX, y: event.clientY };
      reveal(control.current, pointer.current);
    };
    const leave = () => {
      pointer.current = null;
      reveal(control.current, null);
    };
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
    };
  }, []);

  // The right edge of the cursor and the middle of its line, in the surface's own coordinates, written to
  // the element itself: it is a position that follows an external system (the editor's layout), and a state
  // would render it twice. The control is absolute, so nothing moves with it, and it has no transition of
  // its place: it is at the cursor in the frame the cursor moves.
  useLayoutEffect(() => {
    const element = control.current;
    if (!element) return;
    // Hidden, and put back at the origin: a hidden box still counts in the page's width, so a place it was
    // given at a wide viewport would scroll the page sideways at 320 pixels (FR-AU-88).
    const hide = () => {
      element.style.visibility = 'hidden';
      element.style.left = '0px';
      element.style.top = '0px';
      element.dataset.near = 'false';
    };
    if (!cursor.atEnd) {
      hide();
      return;
    }
    const put = () => {
      if (!surface.current) return;
      // Read from the editor's own state now, not from the render's: this also runs on the transaction itself.
      const head = Math.min(editor.state.selection.head, editor.state.doc.content.size);
      const line = editor.view.coordsAtPos(head);
      const box = surface.current.getBoundingClientRect();
      const at = editor.view.domAtPos(head).node;
      const block = at instanceof Element ? at : at.parentElement;
      let middle = (line.top + line.bottom) / 2;
      if (block) {
        const style = getComputedStyle(block);
        const contentTop =
          block.getBoundingClientRect().top +
          (Number.parseFloat(style.paddingTop) || 0) +
          (Number.parseFloat(style.borderTopWidth) || 0);
        middle = lineCentre(line.top, line.bottom, contentTop, Number.parseFloat(style.lineHeight));
      }
      // On an empty block the control stands at the start of the line, and the placeholder begins after it
      // (`--ekd-editor-placeholder-offset`, the box and the gap): its own gap is taken back there.
      const gap = editor.state.selection.$head.parent.content.size === 0 ? getGap(element) : 0;
      element.style.left = `${line.right - box.left - gap}px`;
      element.style.top = `${middle - box.top}px`;
      element.style.visibility = 'visible';
      reveal(element, pointer.current);
    };
    put();
    let again = 0;
    // On the transaction itself, in the frame of the change, and not on the render that follows it: the
    // document changes under a cursor that has not moved (a closed list's `/` taken out). It is hidden at
    // once where the cursor has left the end of its block. A change of the text is placed once more a
    // frame later, when the layout has settled.
    const onTransaction = ({ transaction }: { transaction: Transaction }) => {
      if (!endsBlock(editor.state)) {
        hide();
        return;
      }
      cancelAnimationFrame(again);
      if (transaction.docChanged) {
        pointer.current = null;
        again = requestAnimationFrame(put);
      }
      put();
    };
    // The text wraps anew at another width, and the line moves with it.
    window.addEventListener('resize', put);
    editor.on('transaction', onTransaction);
    return () => {
      cancelAnimationFrame(again);
      window.removeEventListener('resize', put);
      editor.off('transaction', onTransaction);
    };
  }, [editor, surface, cursor.atEnd, cursor.head, cursor.size]);

  return (
    <div ref={control} className={styles.insert} data-near="false" style={{ visibility: 'hidden' }}>
      <Tooltip content={INSERT_NAME} placement="top">
        <button
          type="button"
          className={styles.insertButton}
          aria-label={INSERT_NAME}
          // The text keeps its focus and its cursor while the button is pressed.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openSlashPalette(editor)}
        >
          <PlusIcon />
        </button>
      </Tooltip>
    </div>
  );
}
