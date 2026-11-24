'use client';

// The place of a node view among the blocks of its kind (src/lib/editor/block-names.ts). A node view re-renders only
// when its own node changes, so a block added or removed elsewhere would leave a stale place. Each view therefore
// subscribes to the editor's transactions and reads a string snapshot: React re-renders it only when the string
// differs, so a keystroke re-renders no block whose place is unchanged. The positions of each kind are found once for
// each document state (a WeakMap on the document node), not once for each view.
import { useCallback, useSyncExternalStore } from 'react';
import type { Node } from '@tiptap/pm/model';
import type { Editor } from '@tiptap/react';
import { placeAmong, type BlockPlace } from '../../../../lib/editor/block-names.ts';

const found = new WeakMap<Node, Map<string, number[]>>();

function positionsOf(doc: Node, type: string): number[] {
  let byType = found.get(doc);
  if (!byType) found.set(doc, (byType = new Map()));
  let positions = byType.get(type);
  if (!positions) {
    const list: number[] = [];
    doc.descendants((node, pos) => {
      if (node.type.name === type) list.push(pos);
    });
    byType.set(type, (positions = list));
  }
  return positions;
}

export function useBlockPlace(
  editor: Editor,
  getPos: () => number | undefined,
  type: string,
): BlockPlace | null {
  const subscribe = useCallback(
    (notify: () => void) => {
      editor.on('transaction', notify);
      return () => void editor.off('transaction', notify);
    },
    [editor],
  );
  const snapshot = useCallback(() => {
    let pos: number | undefined;
    try {
      pos = getPos();
    } catch {
      return null;
    }
    if (typeof pos !== 'number') return null;
    const place = placeAmong(positionsOf(editor.state.doc, type), pos);
    return place ? `${place.n}/${place.m}` : null;
  }, [editor, getPos, type]);
  const seen = useSyncExternalStore(subscribe, snapshot, () => null);
  if (!seen) return null;
  const [n, m] = seen.split('/').map(Number) as [number, number];
  return { n, m };
}
