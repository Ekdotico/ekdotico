// The address of each heading, for the entries of a contents list (FR-ED-06)
// to link to. The id is drawn on the heading's element by a decoration, at
// render time: it is not an attribute of the node, so it is not stored in the
// document, is not sent over Yjs, is not in the Markdown draft, and the
// collaboration server's shape check (src/lib/collab/shape.ts) never sees it.
//
// A heading is numbered in the order of the document, from 1, as the contents
// list numbers it; one with no text is not listed, so it is not numbered and
// has no id. The number counts every level: a list that shows only the first
// level still points at the same heading as the list that shows all three, and
// two lists in one document never name one id twice. No other element of the
// page has an id of the form `heading-N`.
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

export type DocumentHeading = { level: number; text: string; pos: number; id: string };

/** The headings of a document that have text, in order, each with its position and its id. */
export function headingsOf(doc: PMNode): DocumentHeading[] {
  const found: DocumentHeading[] = [];
  doc.descendants((each, pos) => {
    if (each.type.name === 'heading' && each.textContent.trim() !== '') {
      found.push({
        level: Number(each.attrs.level),
        text: each.textContent,
        pos,
        id: `heading-${found.length + 1}`,
      });
    }
    return !each.isTextblock;
  });
  return found;
}

const key = new PluginKey<DecorationSet>('headingIds');

const draw = (doc: PMNode) =>
  DecorationSet.create(
    doc,
    headingsOf(doc).map(({ pos, id }) => Decoration.node(pos, pos + doc.nodeAt(pos)!.nodeSize, { id })),
  );

/** The fragment of the address, read as a heading's id, or null where it names none. */
function wanted(): string | null {
  try {
    const id = decodeURIComponent(globalThis.location.hash.slice(1));
    return /^heading-\d+$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** The plugin: the decorations are made again at each change of the document, another client's included. */
export const headingIds = () =>
  new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, { doc }) => draw(doc),
      apply: (tr, set) => (tr.docChanged ? draw(tr.doc) : set),
    },
    props: { decorations: (state) => key.getState(state) },
    // The page is opened at the address of an entry before the document has arrived, so the browser
    // finds no element to go to. The first time the heading the address names is drawn, go to it.
    view: (view) => {
      let arrived = false;
      const go = () => {
        if (arrived) return;
        const id = wanted();
        const element = id === null ? null : view.dom.querySelector(`#${id}`);
        if (!element) return;
        arrived = true;
        element.scrollIntoView({ block: 'start' });
      };
      go();
      return { update: go };
    },
  });

export const HeadingIds = Extension.create({
  name: 'headingIds',
  addProseMirrorPlugins: () => [headingIds()],
});
