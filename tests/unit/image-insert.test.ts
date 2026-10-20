// Where the block of an uploaded image goes, and what is said where it does not (FR-ED-08, the review of pull
// request 52, S5): the insertion reports whether the document holds the block. The place of a drop, which the
// binding to the shared document holds, is tested in tests/e2e/images.spec.ts, where the binding runs.
import { Editor, type JSONContent } from '@tiptap/core';
import { Plugin } from '@tiptap/pm/state';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { insertImageBlock } from '../../src/app/(app)/documents/[id]/images.tsx';

const ID = 'cabcdefghijklmnopqrstuvwx';
const paragraph = (text?: string): JSONContent => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});

function editorOf(...content: JSONContent[]) {
  const made = new Editor({
    element: null,
    content: { type: 'doc', content },
    extensions: extensions(new Y.Doc(), undefined, undefined, undefined, false, null, {
      documentId: 'd',
      unreferencedDays: 30,
      report: () => {},
      announce: () => {},
    }),
  });
  made.view.updateState(made.state.reconfigure({ plugins: made.extensionManager.plugins }));
  made.commands.setTextSelection(1);
  return made;
}

const images = (editor: Editor) => {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') found.push(String(node.attrs.id));
  });
  return found;
};

describe('insertImageBlock', () => {
  it('reports true, and the document holds the block', () => {
    const editor = editorOf(paragraph());
    expect(insertImageBlock(editor, ID)).toBe(true);
    expect(images(editor)).toEqual([ID]);
  });

  it('reports false where the editor drops the change, and the document holds no block', () => {
    const editor = editorOf(paragraph('text'));
    const refuse = new Plugin({ filterTransaction: (transaction) => !transaction.docChanged });
    editor.view.updateState(
      editor.state.reconfigure({ plugins: [...editor.extensionManager.plugins, refuse] }),
    );
    expect(insertImageBlock(editor, ID)).toBe(false);
    expect(images(editor)).toEqual([]);
  });
});
