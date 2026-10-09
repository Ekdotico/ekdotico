// The Markdown input of FR-ED-14, as one extension, so that the editor can
// turn on the input rules of this extension and of no other
// (`enableInputRules` in ./editor.tsx). The patterns are in
// src/lib/editor/markdown.ts; here each is bound to its block or mark.
//
// The library keeps a rule from acting while text is being composed (an input
// method, a dead key), inside a code block, and inside inline code.
import { Extension, InputRule, markInputRule, textblockTypeInputRule, wrappingInputRule } from '@tiptap/core';
import type { MarkType } from '@tiptap/pm/model';
import { MARKDOWN } from '../../../../lib/editor/markdown.ts';

export const MARKDOWN_INPUT = 'markdownInput';

/** A mark on closing, and only where the block takes that mark: a caption takes none, and keeps its signs. */
function mark(find: RegExp, type: MarkType) {
  const rule = markInputRule({ find, type });
  return new InputRule({
    find,
    handler: (props) =>
      props.state.doc.resolve(props.range.from).parent.type.allowsMarkType(type) ? rule.handler(props) : null,
  });
}

export const MarkdownInput = Extension.create({
  name: MARKDOWN_INPUT,
  addInputRules() {
    const { nodes, marks } = this.editor.schema;
    return [
      textblockTypeInputRule({
        find: MARKDOWN.heading,
        type: nodes.heading!,
        getAttributes: (match) => ({ level: match[1]!.length }),
      }),
      wrappingInputRule({ find: MARKDOWN.bulletList, type: nodes.bulletList! }),
      wrappingInputRule({ find: MARKDOWN.orderedList, type: nodes.orderedList! }),
      wrappingInputRule({ find: MARKDOWN.blockquote, type: nodes.blockquote! }),
      // The rule in place of the block, where a rule may stand; the block stays, empty, after it.
      new InputRule({
        find: MARKDOWN.horizontalRule,
        handler: ({ state, range }) => {
          const $start = state.doc.resolve(range.from);
          const at = $start.index(-1);
          if (!$start.node(-1).canReplaceWith(at, at, nodes.horizontalRule!)) return null;
          state.tr.delete(range.from, range.to).insert($start.before(), nodes.horizontalRule!.create());
        },
      }),
      // The language is the block's default, plain text: none is read from what was typed.
      textblockTypeInputRule({ find: MARKDOWN.codeBlock, type: nodes.codeBlock! }),
      mark(MARKDOWN.bold, marks.bold!),
      mark(MARKDOWN.italic, marks.italic!),
      mark(MARKDOWN.strike, marks.strike!),
      mark(MARKDOWN.code, marks.code!),
    ];
  },
});
