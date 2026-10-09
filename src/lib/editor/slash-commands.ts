// The rows of the slash command palette (FR-ED-12) and its filter (FR-ED-11),
// as far as they need no control: the name of each command, its aliases, and
// the block it inserts, as the document's schema holds it
// (../../app/(app)/documents/[id]/extensions.tsx).
//
// NOT YET REACHED BY ANY PAGE. The palette itself waits for a control of
// `@ekdotico/domico`: a list of options shown at the cursor and filtered as
// the person types, with the focus kept in the text. The package has none at
// 0.27.0, and one is not drawn in the application (FR-AU-88; the owner's
// decision E1). When the control is released, the palette is this list behind
// it.
//
// The rows are the block types of α 0.1.0 that the editor holds today, in the
// order of the requirement. The image and the footnote join with the slices
// that build those blocks; `/latex`, `/mermaid` and `/cite` are not in the
// release (Build phases, "Slash palette and shortcuts").
//
// Every attribute below is a value its node's own closed list holds: nothing
// a person types in the palette reaches a node (NFR-SE-06, A03).

/** A node as the editor takes it: the JSON of the schema. */
export interface Block {
  type: string;
  attrs?: Record<string, string | number>;
  content?: Block[];
}

export interface SlashCommand {
  /** The command, without its slash. */
  name: string;
  aliases: readonly string[];
  inserts: Block;
}

const paragraph: Block = { type: 'paragraph' };
const cell: Block = { type: 'tableCell', content: [paragraph] };
const row: Block = { type: 'tableRow', content: [cell, cell, cell] };

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: 'text', aliases: ['p', 'paragraph'], inserts: paragraph },
  { name: 'h1', aliases: ['heading1'], inserts: { type: 'heading', attrs: { level: 1 } } },
  { name: 'h2', aliases: ['heading2'], inserts: { type: 'heading', attrs: { level: 2 } } },
  { name: 'h3', aliases: ['heading3'], inserts: { type: 'heading', attrs: { level: 3 } } },
  {
    name: 'bullet',
    aliases: ['ul', 'unordered'],
    inserts: { type: 'bulletList', content: [{ type: 'listItem', content: [paragraph] }] },
  },
  {
    name: 'numbered',
    aliases: ['ol', 'ordered'],
    inserts: { type: 'orderedList', content: [{ type: 'listItem', content: [paragraph] }] },
  },
  { name: 'quote', aliases: ['blockquote'], inserts: { type: 'blockquote', content: [paragraph] } },
  {
    name: 'table',
    aliases: [],
    // "3×3 default": three rows of three cells, in its block, with its caption (FR-ED-09).
    inserts: {
      type: 'tableBlock',
      content: [{ type: 'table', content: [row, row, row] }, { type: 'tableCaption' }],
    },
  },
  { name: 'code', aliases: ['codeblock'], inserts: { type: 'codeBlock', attrs: { language: 'plaintext' } } },
  {
    name: 'callout',
    aliases: ['note'],
    // "Callout block (note variant)".
    inserts: { type: 'callout', attrs: { type: 'note' }, content: [paragraph] },
  },
  { name: 'toc', aliases: ['contents'], inserts: { type: 'tableOfContents' } },
  { name: 'divider', aliases: ['hr', 'rule'], inserts: { type: 'horizontalRule' } },
  { name: 'page-break', aliases: ['pagebreak'], inserts: { type: 'pageBreak' } },
];

/**
 * FR-ED-11: "The filter shall match against command name and aliases." What
 * was typed after the slash is compared, without regard to case, with the
 * start of the name and of each alias; nothing typed lists every command. The
 * order is the requirement's.
 *
 * PROVISIONAL: the requirement does not say whether the match is from the
 * start or anywhere, nor how case is read. Reported as a row for the register.
 */
export function matchSlashCommands(typed: string): readonly SlashCommand[] {
  const query = typed.toLowerCase();
  return SLASH_COMMANDS.filter(({ name, aliases }) =>
    [name, ...aliases].some((each) => each.startsWith(query)),
  );
}
