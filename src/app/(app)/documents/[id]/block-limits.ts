// The limits of a document, as the browser holds them (register D182, D184,
// D192, D193; `LIMITS` of src/lib/collab/shape.ts, which the collaboration
// server holds as well, counted alike).
//
// REFUSED AT THE CHANGE, NEVER TAKEN OUT LATER (Q45, D190). A change of this
// writer's that would leave the document past a limit, and further past than
// it was, is not applied, and is said to be so in the owner's words
// (`limitRefusal`, asked by `Closed` of ./extensions.tsx). Nothing a document
// holds is ever taken out for a limit.
//
// A DOCUMENT PAST A LIMIT ALREADY (D184), stored before the limit or by a tab
// of an earlier release, opens read-only with a statement that names the count
// and the limit (`overLimits`), and becomes editable once it is back under
// every limit. While it is past one, the text stays editable for deletions
// alone: a change of the writer's is applied only where every step of it
// deletes and puts nothing in (`deletesOnly`), so that tables, blocks, items
// and text can be taken out with the keyboard, by cutting, or by the menu of a
// table, and nothing can be written, formatted or set. Anything else is
// refused with the statement itself.
//
// The total of 5,000 blocks of D192 is not built: whether a paragraph in a
// cell of a table is a block is open, and with it whether one table at its
// bounds (10,000 cells) passes the total.
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { ReplaceStep } from '@tiptap/pm/transform';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { COUNTED, LIMITS, LISTS, textBytes, type Limit } from '../../../../lib/collab/shape.ts';
import { TABLE_CELLS_MOST, TABLE_DEPTH_MOST, TABLE_MOST, tablesIn } from './table-bounds.ts';

type Counts = Record<Limit, number>;
const ALL = Object.keys(LIMITS) as Limit[];
type CountedLimit = Exclude<Limit, 'listItems' | 'listDepth' | 'codeBytes'>;
const COUNTED_LIMITS = [...new Set(COUNTED.values())] as CountedLimit[];
const ZERO: Counts = Object.freeze(Object.fromEntries(ALL.map((limit) => [limit, 0]))) as Counts;
// A node never changes, and a change keeps every node it does not touch: what
// was counted once is not counted again at the next key.
const COUNTS = new WeakMap<PMNode, Counts>();

/**
 * What the limits count in a node, itself among it: the blocks of each type,
 * wherever they stand; the most items of one list and how deep lists stand,
 * the outermost counted; and the bytes of the longest code block.
 */
export function countsOf(node: PMNode): Counts {
  if (node.isText || (node.isTextblock && node.type.name !== 'codeBlock')) return ZERO;
  let counts = COUNTS.get(node);
  if (counts) return counts;
  const made = { ...ZERO };
  const { name } = node.type;
  if (name === 'codeBlock') made.codeBytes = textBytes([node.textContent]);
  else {
    node.forEach((child) => {
      const held = countsOf(child);
      for (const limit of COUNTED_LIMITS) made[limit] += held[limit];
      made.listItems = Math.max(made.listItems, held.listItems);
      made.listDepth = Math.max(made.listDepth, held.listDepth);
      made.codeBytes = Math.max(made.codeBytes, held.codeBytes);
    });
  }
  const counted = COUNTED.get(name);
  if (counted) made[counted] += 1;
  if (LISTS.has(name)) {
    made.listItems = Math.max(made.listItems, node.childCount);
    made.listDepth += 1;
  }
  COUNTS.set(node, made);
  counts = made;
  return counts;
}

const number = (count: number) => count.toLocaleString('en-GB');
/** What each block a document counts is called, one and more than one. */
const BLOCKS: Record<CountedLimit, readonly [one: string, many: string]> = {
  tables: ['table', 'tables'],
  codeBlocks: ['code block', 'code blocks'],
  callouts: ['callout', 'callouts'],
  tablesOfContents: ['table of contents', 'tables of contents'],
  pageBreaks: ['page break', 'page breaks'],
  dividers: ['divider', 'dividers'],
  quotes: ['quote', 'quotes'],
};
const KB = (bytes: number) => `${number(Math.ceil(bytes / 1024))} KB`;
const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/**
 * The words for a paste or a command that would take a table past the bounds
 * it shares with the tables in its cells (FR-ED-09; ./table-bounds.ts).
 *
 * For a paste, the owner's text of 18 October 2026, word for word (D178).
 * For a command, such as a row added, the sentence that D178 approved before
 * it: the owner's text names a paste, and what a command is told is open.
 */
export const TABLE_PASTE_NO_ROOM = `We cannot paste this table. A table and the tables in its cell hold ${number(TABLE_CELLS_MOST)} cells, ${COUNT_WORDS[TABLE_DEPTH_MOST] ?? TABLE_DEPTH_MOST} levels deep and this surpasses our current limits.`;
export const TABLE_NO_ROOM = `The table has no room for this. A table and the tables in its cells hold ${number(TABLE_CELLS_MOST)} cells, ${COUNT_WORDS[TABLE_DEPTH_MOST] ?? TABLE_DEPTH_MOST} levels deep.`;

/**
 * The title of the statement where the collaboration server refused a change
 * of this tab for the bounds of a table: the owner's words of 18 October 2026
 * (D171). This browser sends no such change of its own accord: it is seen
 * where two writers together take a table past a bound, by an undo or by a
 * row added at once, and by a tab of a release that held other bounds.
 */
export const TABLE_PAST_BOUNDS = `We cannot apply this change. A table holds ${TABLE_MOST} rows, ${TABLE_MOST} cells in a row and ${number(TABLE_CELLS_MOST)} cells, ${COUNT_WORDS[TABLE_DEPTH_MOST] ?? TABLE_DEPTH_MOST} levels deep, and this change passes our current limits.`;

/**
 * The title of the statement where the collaboration server refused a change
 * of this tab for a limit of the document, in the voice of D171 and D192.
 * Written for the owner's approval. Seen in the same cases as the bounds of a
 * table: two writers who together pass a limit, an undo, an earlier release.
 */
export function heldTitle(limit: Limit): string {
  const passes = 'and this change passes it.';
  if (limit === 'listItems')
    return `We cannot apply this change. Our current limit per list is ${number(LIMITS.listItems)} items, ${passes}`;
  if (limit === 'listDepth')
    return `We cannot apply this change. Our current limit is ${number(LIMITS.listDepth)} levels of nesting, ${passes}`;
  if (limit === 'codeBytes')
    return `We cannot apply this change. Our current limit per code block is ${KB(LIMITS.codeBytes)}, ${passes}`;
  return `We cannot apply this change. Our current limit per document is ${number(LIMITS[limit])} ${BLOCKS[limit][1]}, ${passes}`;
}

/**
 * The words for a change of the writer's that would pass a limit: the owner's
 * patterns of 18 October 2026 (D182, D184, D192), and the words of D193 for a
 * code block, proposed for his approval. `before` and `after` are the counts
 * of the document; `pasted`, whether the change is a paste or a drop.
 */
export function refusalWords(limit: Limit, before: Counts, after: Counts, pasted: boolean): string {
  if (limit === 'listItems')
    return `We cannot add this list item. Our current limit per list is ${number(LIMITS.listItems)} items.`;
  if (limit === 'listDepth')
    return `We cannot nest this list further. Our current limit is ${number(LIMITS.listDepth)} levels of nesting.`;
  if (limit === 'codeBytes')
    return after.codeBlocks > before.codeBlocks
      ? `We cannot add this code block. Our current limit per code block is ${KB(LIMITS.codeBytes)}.`
      : `We cannot add this text. Our current limit per code block is ${KB(LIMITS.codeBytes)}.`;
  const [one, many] = BLOCKS[limit];
  const most = LIMITS[limit];
  if (limit === 'tables')
    return pasted
      ? `We could not paste this. It would bring the document to ${number(after.tables)} tables, more than our current limit for tables (${number(most)}).`
      : `We cannot add another table. Our current limit per document is ${number(most)} tables.`;
  if (!pasted) return `We cannot add this ${one}. Our current limit per document is ${number(most)} ${many}.`;
  const count = after[limit] - before[limit];
  return `We cannot paste this. It holds ${number(count)} ${count === 1 ? one : many}, and our current limit per document is ${number(most)}.`;
}

/**
 * The statement of a document past a limit already (D184): one sentence for
 * each limit it is past, naming the count and the limit, and none where it is
 * past none. Written for the owner's approval, in the words of his example.
 */
export function overLimits(doc: PMNode): string[] {
  const counts = countsOf(doc);
  const after = 'It is read-only until it is back under the limit.';
  return ALL.filter((limit) => counts[limit] > LIMITS[limit]).map((limit) => {
    const count = counts[limit];
    if (limit === 'listItems')
      return `This document holds a list of ${number(count)} items, more than our current limit per list (${number(LIMITS.listItems)}). ${after} You can still delete list items.`;
    if (limit === 'listDepth')
      return `This document nests a list ${number(count)} levels deep, more than our current limit (${number(LIMITS.listDepth)}). ${after} You can still delete lists.`;
    if (limit === 'codeBytes')
      return `This document holds a code block of ${KB(count)}, more than our current limit per code block (${KB(LIMITS.codeBytes)}). ${after} You can still delete text in it.`;
    const [, many] = BLOCKS[limit];
    return `This document holds ${number(count)} ${many}, more than our current limit per document (${number(LIMITS[limit])}). ${after} You can still delete ${many}.`;
  });
}

/**
 * Whether every step of a transaction deletes, and puts nothing in but the
 * empty paragraph that the schema requires where everything was deleted: of
 * a document, of a cell, of a callout.
 */
export const deletesOnly = (transaction: Transaction) =>
  transaction.steps.every((step) => {
    if (!(step instanceof ReplaceStep)) return false;
    if (step.slice.size === 0) return true;
    let nothing = step.from < step.to;
    step.slice.content.forEach((node) => {
      if (node.type.name !== 'paragraph' || node.content.size > 0) nothing = false;
    });
    return nothing;
  });

/**
 * The words of the refusal of a transaction for a bound of a table or a limit
 * of the document, or null where it is applied. A change from the
 * collaboration binding is another client's or an undo, and passes: the
 * collaboration server holds the same limits.
 */
export function limitRefusal(transaction: Transaction, before: PMNode): string | null {
  const binding = transaction.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
  if (!transaction.docChanged || binding?.isChangeOrigin === true) return null;
  const event = transaction.getMeta('uiEvent') as unknown;
  const pasted = Boolean(transaction.getMeta('paste')) || event === 'paste' || event === 'drop';
  if (tablesIn(transaction.doc).past && !tablesIn(before).past)
    return pasted ? TABLE_PASTE_NO_ROOM : TABLE_NO_ROOM;
  const was = countsOf(before);
  const now = countsOf(transaction.doc);
  const limit = ALL.find((each) => now[each] > LIMITS[each] && now[each] > was[each]);
  if (limit) return refusalWords(limit, was, now, pasted);
  const over = overLimits(before);
  return over.length > 0 && !deletesOnly(transaction) ? over.join(' ') : null;
}

/**
 * Whether a block put at a place would pass a limit: the slash palette does
 * not list a block at its limit (D182, D192). A list put in an item of a list
 * stands a level deeper for each list round the place.
 */
export function passesLimits(doc: PMNode, block: PMNode, $at: ResolvedPos): boolean {
  const have = countsOf(doc);
  const brings = countsOf(block);
  if (COUNTED_LIMITS.some((limit) => brings[limit] > 0 && have[limit] + brings[limit] > LIMITS[limit]))
    return true;
  let round = 0;
  for (let depth = 1; depth <= $at.depth; depth += 1) if (LISTS.has($at.node(depth).type.name)) round += 1;
  return brings.listDepth > 0 && round + brings.listDepth > LIMITS.listDepth;
}
