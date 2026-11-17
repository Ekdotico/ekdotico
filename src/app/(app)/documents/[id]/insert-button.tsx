'use client';

// The "Insert" control (audit row F05; the owner's decisions ui-dc-insert and its sketch of 17 November 2026):
// a "+" immediately to the right of the cursor, on the cursor's line, which follows the cursor as it moves and
// acts as a typed "/" when pressed (./slash-palette.tsx, `openSlashPalette`): the same palette, list and choice.
//
// It is shown only where nothing follows the cursor in its block, so it never covers text: at the end of a
// text block, empty or not, as the sketch has it. Elsewhere it is hidden with `visibility`, never removed from
// the page.

import { useEffect, useLayoutEffect, useState, type RefObject } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { Button, Tooltip } from '@ekdotico/domico/components';
import { PlusIcon } from '@ekdotico/domico/icons';
import styles from './editor.module.css';
import { INSERT_NAME } from './insert-name.ts';
import { openSlashPalette } from './slash-palette.tsx';

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
      const { $head } = selection;
      return {
        head: selection.head,
        size: doc.content.size,
        atEnd:
          selection.empty &&
          $head.parent.isTextblock &&
          !$head.parent.type.spec.code &&
          $head.parentOffset === $head.parent.content.size,
      };
    },
  });
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  // Whether it has been placed before, so that it glides from one place to the next and does not fly in from
  // wherever it last was after being hidden.
  const [settled, setSettled] = useState(false);

  // The right edge of the cursor and the middle of its line, in the surface's own coordinates. The control is
  // absolute, so nothing moves with it.
  useLayoutEffect(() => {
    if (!cursor.atEnd) {
      setPlace(null);
      return;
    }
    const put = () => {
      if (!surface.current) return;
      const line = editor.view.coordsAtPos(Math.min(cursor.head, editor.state.doc.content.size));
      const box = surface.current.getBoundingClientRect();
      setPlace({ left: line.right - box.left, top: (line.top + line.bottom) / 2 - box.top });
    };
    put();
    // The text wraps anew at another width, and the line moves with it.
    window.addEventListener('resize', put);
    return () => window.removeEventListener('resize', put);
  }, [editor, surface, cursor.atEnd, cursor.head, cursor.size]);

  const placed = place !== null;
  useEffect(() => setSettled(placed), [placed]);

  return (
    <div
      className={styles.insert}
      data-settled={settled}
      style={place ? { left: place.left, top: place.top } : { visibility: 'hidden' }}
    >
      <Tooltip content={INSERT_NAME} placement="top">
        <Button
          variant="secondary"
          aria-label={INSERT_NAME}
          // The text keeps its focus and its cursor while the button is pressed.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => openSlashPalette(editor)}
        >
          <PlusIcon />
        </Button>
      </Tooltip>
    </div>
  );
}
