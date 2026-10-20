// What the blocks of the editor share to carry their own controls: whether the
// document can be edited now, the mark Alt+F10 looks for, and the element that
// holds a block's controls (./extensions.tsx and ./images.tsx).
'use client';

import { createContext } from 'react';
import type { Editor } from '@tiptap/react';

/** Whether the document can be edited now: the role, and the connection (FR-ED-18). Node views read it. */
export const Editable = createContext(false);

/** The mark on the element that holds a block's controls: Alt+F10 looks for it (./editor.tsx). */
export const BLOCK_CONTROLS = 'data-block-controls';

/**
 * A block's own controls, inside the block and outside its text. Escape
 * returns to the text, unless a control used the key itself (a menu closing
 * its list).
 */
export function BlockControls({
  editor,
  className,
  children,
}: {
  editor: Editor;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      {...{ [BLOCK_CONTROLS]: '' }}
      className={className}
      contentEditable={false}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) editor.commands.focus();
      }}
    >
      {children}
    </div>
  );
}
