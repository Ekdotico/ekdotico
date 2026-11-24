// The headings of the text, drawn one level lower (the owner's answers ux-heading-levels and
// ux-headings-domico): a Heading 1, 2 or 3 of the text is an `h2`, `h3` or `h4` with `data-level`
// 1, 2 or 3, so that the page has one `h1`, which is the document's title, and the headings look as
// they did (the stylesheet of the editor draws a heading by `data-level`).
//
// This is rendering alone. The stored heading keeps its `level` of 1 to 3, so the shared document,
// the shape check, the contents list, the heading ids, the Markdown export, the toolbar and the
// slash palette, which read the node and not the tag, are as they were.
//
// What leaves the editor is the stored level: a copy or a drag puts `h1`, `h2` or `h3` on the
// clipboard (an `h2` that stood for a Heading 1 would arrive in another application as a Heading 2),
// and what comes in is read by the tag it carries, so a pasted `h1` is a Heading 1. A heading that
// was drawn by this editor and comes back (`h2` with `data-level="1"`) is read by its `data-level`.
import { mergeAttributes } from '@tiptap/core';
import Heading from '@tiptap/extension-heading';
import { DOMSerializer, type Schema } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';

const LEVELS = [1, 2, 3] as const;

/** The clipboard's serializer: as the schema's, but a heading is the tag of its stored level. */
export function clipboardSerializerOf(schema: Schema): DOMSerializer {
  const own = DOMSerializer.fromSchema(schema);
  return new DOMSerializer(
    {
      ...own.nodes,
      heading: (node) => [`h${Math.min(Math.max(Number(node.attrs.level), 1), 3)}`, 0],
    },
    own.marks,
  );
}

export const HeadingLevels = Heading.extend({
  parseHTML() {
    return [
      // The element this editor draws, read before the tag so that an `h2` of a Heading 1 is not a Heading 2.
      ...LEVELS.map((level) => ({
        tag: `h${level + 1}[data-level="${level}"]`,
        attrs: { level },
        priority: 60,
      })),
      ...(this.parent?.() ?? []),
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const stored = Number(node.attrs.level);
    const level = this.options.levels.includes(stored as 1 | 2 | 3) ? stored : this.options.levels[0]!;
    return [
      `h${level + 1}`,
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-level': level }),
      0,
    ];
  },
  addProseMirrorPlugins() {
    return [new Plugin({ props: { clipboardSerializer: clipboardSerializerOf(this.editor.schema) } })];
  },
}).configure({ levels: [1, 2, 3] });
