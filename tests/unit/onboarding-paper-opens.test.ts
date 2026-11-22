// The Onboarding paper opens in the editor as any document does: the editor's own binding, held as the
// browser holds it (`holdBinding`, src/app/(app)/documents/[id]/extensions.tsx), builds the text from the
// stored state without telling that the document cannot be shown, without writing a mending, and to the
// text the JSON of the paper says.
import { Node } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import { ySyncPlugin, ySyncPluginKey, type ProsemirrorBinding } from '@tiptap/y-tiptap';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { holdBinding } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { FRAGMENT_NAME } from '../../src/lib/collab/protocol.ts';
import { applyState } from '../../src/lib/collab/state.ts';
import { onboardingPaper, onboardingState } from '../../src/lib/documents/onboarding-paper.ts';
import { editorSchema } from './export-fixtures.ts';

/** The document of a stored state, opened as the browser opens it. */
function open(state: Uint8Array) {
  const document = new Y.Doc();
  applyState(document, state);
  const schema = editorSchema();
  let current = EditorState.create({
    schema,
    plugins: [ySyncPlugin(document.getXmlFragment(FRAGMENT_NAME))],
  });
  const mended: unknown[] = [];
  document.on('update', (_update: Uint8Array, origin: unknown) => {
    if (origin === 'mend') mended.push(origin);
  });
  const view = {
    get state() {
      return current;
    },
    dispatch(transaction: Transaction) {
      current = current.apply(transaction);
    },
    hasFocus: () => false,
    editable: true,
  };
  const unshown = vi.fn();
  const unrepairable = vi.fn();
  const { binding } = ySyncPluginKey.getState(current) as { binding: ProsemirrorBinding };
  holdBinding(view as never, unshown, unrepairable);
  binding.initView(view);
  binding._forceRerender();
  return { text: () => current.doc, unshown, unrepairable, mended };
}

describe('the Onboarding paper in the editor', () => {
  it('is built as the browser builds a document, whole, with nothing left out and nothing mended', () => {
    const editor = open(onboardingState());
    expect(editor.unshown).not.toHaveBeenCalled();
    expect(editor.unrepairable).not.toHaveBeenCalled();
    expect(editor.mended).toEqual([]);
    expect(editor.text().eq(Node.fromJSON(editorSchema(), onboardingPaper))).toBe(true);
  });
});
