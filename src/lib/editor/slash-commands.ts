// The rows of the slash command palette (FR-ED-12) and its filter (FR-ED-11),
// as far as they need no control: the name of each command, its aliases, and
// the block it inserts, as the document's schema holds it
// (../../app/(app)/documents/[id]/extensions.tsx).
//
// The palette itself, on the control of `@ekdotico/domico` 0.28.0, is
// ../../app/(app)/documents/[id]/slash-palette.tsx.
//
// The rows are the block types of α 0.1.0 that the editor holds today, in the
// order of the requirement. The footnote joins with the slice that builds that
// block; `/latex`, `/mermaid` and `/cite` are not in the release (Build
// phases, "Slash palette and shortcuts").
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
  /**
   * What a choice does instead of putting `inserts` in place: `image` opens the file picker, and
   * the block is put where the cursor is when the upload is done (FR-ED-08). `inserts` is then the
   * block as the document's limits and its place are asked of it.
   */
  action?: 'image';
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
    // "3×3 default": three rows of three cells, in its block, with its caption
    // (FR-ED-09). Three plain rows and no header row (the owner's decision of
    // 9 October 2026).
    inserts: {
      type: 'tableBlock',
      content: [{ type: 'table', content: [row, row, row] }, { type: 'tableCaption' }],
    },
  },
  { name: 'code', aliases: ['codeblock'], inserts: { type: 'codeBlock', attrs: { language: 'plaintext' } } },
  // FR-ED-12: "Image block". The picker opens, and the block follows the upload (FR-ED-08).
  { name: 'image', aliases: ['img'], inserts: { type: 'image' }, action: 'image' },
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
 * order is the requirement's. From the start, and without regard to case, by
 * the owner's decision of 9 October 2026.
 */
export function matchSlashCommands(typed: string): readonly SlashCommand[] {
  const query = typed.toLowerCase();
  return SLASH_COMMANDS.filter(({ name, aliases }) =>
    [name, ...aliases].some((each) => each.startsWith(query)),
  );
}
