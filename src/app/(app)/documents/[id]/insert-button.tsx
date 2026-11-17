'use client';

// The "Insert" control (audit row F05; the owner's decision ui-dc-insert): one button beside the line the
// cursor is on, which opens the block palette that the slash opens (./slash-palette.tsx, `openSlashPalette`).
// It is a second way to the same list and the same choice, not a second list.

import { useLayoutEffect, useState, type RefObject } from 'react';
import { useEditorState, type Editor } from '@tiptap/react';
import { Button, Tooltip } from '@ekdotico/domico/components';
import { PlusIcon } from '@ekdotico/domico/icons';
import styles from './editor.module.css';
import { openSlashPalette } from './slash-palette.tsx';

// PROPOSED words, for the owner's approval: the control's name, which a screen reader reads and the
// tooltip shows. Nothing else of it is written.
export const INSERT_NAME = 'Insert a block';

/** Beside the line of the cursor, in the margin the surface keeps for it. Shown only to a person who may edit. */
export function InsertButton({
  editor,
  surface,
}: {
  editor: Editor;
  surface: RefObject<HTMLDivElement | null>;
}) {
  const head = useEditorState({ editor, selector: ({ editor: current }) => current.state.selection.head });
  const [top, setTop] = useState<number | null>(null);

  // The middle of the cursor's line, in the surface's own coordinates. It moves nothing: it is absolute.
  useLayoutEffect(() => {
    const put = () => {
      if (!surface.current) return;
      const line = editor.view.coordsAtPos(Math.min(head, editor.state.doc.content.size));
      setTop((line.top + line.bottom) / 2 - surface.current.getBoundingClientRect().top);
    };
    put();
    // The text wraps anew at another width, and the line moves with it.
    window.addEventListener('resize', put);
    return () => window.removeEventListener('resize', put);
  }, [editor, surface, head]);

  return (
    <div className={styles.insert} style={top === null ? { visibility: 'hidden' } : { top }}>
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
