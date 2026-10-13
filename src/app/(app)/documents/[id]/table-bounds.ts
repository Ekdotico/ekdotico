// The bounds of a table, and of the tables in its cells (FR-ED-09; the owner's
// decision R32 of 12 October 2026: a cell may hold a table).
//
// The schema bounds one table: `TABLE_MOST` rows, and `TABLE_MOST` cells in a
// row (./extensions.tsx). A table in a cell multiplies that: a hundred by a
// hundred in each cell of a hundred by a hundred is 10^8 cells, and one level
// more is 10^12. So two bounds are held on what the tables make TOGETHER,
// which no content expression of a schema can say:
//
// - CELLS. A table and every table in its cells, however deep, hold at most
//   `TABLE_CELLS_MOST` cells: what one table could hold before the decision.
//   So no table that is laid out is larger than the largest there already was.
// - LEVELS. Tables stand at most `TABLE_DEPTH_MOST` deep, the outermost
//   counted.
//
// They are held in two places, which between them are every way a table is
// made. Where the schema makes a table, from another client's change, a stored
// document, an undo, a paste or JSON, what is past a bound is LEFT OUT
// (`closeNested`, called by `closeSchema` of ./extensions.tsx). And a change of
// this writer's that would take a table past a bound is not applied
// (`holdsTables`, there too): a step of a transaction copies the nodes round a
// change and asks the schema nothing.
//
// KNOWN, AND LEFT (the review of pull request 28; reported to the owner):
//
// - Near the bound, an undo can cost another writer's rows for good. One
//   writer deletes a large table from a cell, another then adds rows to a
//   table further down, and the first undoes: the large table is back, the
//   count is past the bound, and what is left out is the last in the order of
//   the document, which is the other writer's rows. They are taken out of the
//   shared document as no one's change, so neither writer's undo brings them
//   back.
// - A table can be left with a row a cell short. Where rows are left out of a
//   table in a cell and a cell above reached down into them, or where a client
//   sends such a table at 9,999 cells, the table library's repair adds the
//   missing cell; where that would pass the bound the repair is not applied
//   (`holdsTables`), at this key and at every later one, and the table stays as
//   it is until a cell is deleted somewhere in the outermost table.
// - The collaboration server holds none of these bounds: it reads the size and the
//   depth of a document and nothing else.
import { Fragment, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';

// The bounds are this file's: the Docs give none (reported for the register).
/** The most rows of a table, and the most cells of a row. */
export const TABLE_MOST = 100;
/** The most cells of a table and of every table in its cells, together. */
export const TABLE_CELLS_MOST = TABLE_MOST * TABLE_MOST;
/**
 * The most levels of table, one in a cell of another, the outermost counted:
 * a table in a cell of a table, and no table in a cell of that one.
 *
 * The owner's decision R57 of 12 October 2026 (its register row is pending):
 * tables nest at most 2 deep. The limit of the collaboration server alone, 50
 * elements one in another (src/lib/collab/state.ts), would allow 12: each
 * level is four elements, the block, the table, the row and the cell, and the
 * text of the twelfth is the 49th.
 *
 * Changing it is not free either way. A bound that is lowered deletes every
 * table past it, for everyone, at once. And one that is raised is not safe at
 * once. Every browser holds the bound it was loaded
 * with, so for as long as one tab of an earlier release has a document open,
 * that tab leaves out the tables past ITS bound and takes them out of the
 * shared document, for everyone. A higher bound is safe only once no browser
 * runs the lower one: released in two steps, or with the server holding the
 * bound, which it does not.
 */
export const TABLE_DEPTH_MOST = 2;
/**
 * The most tables a writer may bring a document to, a table in a cell counted
 * as one more (the owner's decision R58 of 13 October 2026: "refuse only,
 * never delete, at 100"; specification rows D182 and D184, pending).
 *
 * REFUSE ONLY. A change of the writer's own that would leave the document
 * with more tables than this, and more than it had, is not applied
 * (`tableRefusal` of ./extensions.tsx), and the palette lists no Table at the
 * number. Nothing that a document holds is ever taken out for it: a document
 * with more, from another client, from storage, from another release, or
 * from two writers who each added the hundredth at once, is shown whole and
 * written in, and takes no table more. So the number can be changed without
 * loss, which the bounds that leave out cannot.
 *
 * Counted in the text the editor holds, after the schema has made it, so that
 * nothing the schema leaves out is counted.
 *
 * KNOWN, AND ACCEPTED UNTIL THE OWNER SAYS OTHERWISE (the review of pull
 * request 35): in a document at or past the number, a table that is cut
 * cannot be pasted back. The cut is applied, and the paste would leave the
 * document with more tables than it then had, so it is refused, in the words
 * of the refusal. Undoing the cut restores the table.
 *
 * The unit is the table, though the cost it stands for is not a table's
 * alone. Measured on 12 October 2026 (Chromium, Apple M2 Pro; the row "Editor
 * keystroke to character render" of §2.4, under 16 ms at P50 in the reference
 * document of 5,000 words): a key is 8 ms with no table, 14 with 50 tables of
 * five rows by four, 23 with 100; a table of one cell costs a third of that,
 * a callout as much as a table of one cell, and a code block more. The owner
 * left a wider count, of every block with controls, for β.
 *
 * The collaboration server holds neither this number nor the next.
 */
export const TABLE_COUNT_MOST = 100;
/**
 * The most tables a document is opened with: past it, the tables that are
 * last in the order of the document are left out and taken out of the shared
 * document, as the rows and the cells past their bounds are (`floodOfTables`
 * of ./extensions.tsx). Against a flood and nothing
 * else: a client that is no editor can send sixty thousand tables in under 5
 * MB, and a page that is asked to draw them does not answer.
 *
 * The number was approved by the owner on 13 October 2026 (R58: "a much
 * higher threshold, in the thousands, against a flood"). IT MUST NOT BE
 * LOWERED ONCE SHARING IS RELEASED: a browser that holds a lower number takes
 * the tables past it out of the shared document, for everyone. It was
 * proposed from the same measurement, in the
 * reference document: with 1,000 tables of one cell a key takes 57 ms and the
 * document opens in 1 second; with 2,000, 105 ms and 2.2 seconds, and with
 * 2,000 of five rows by four, 187 ms and 4.1 seconds; with 5,000 of one cell,
 * 228 ms and 12 seconds. So 2,000 is where a document still opens in seconds
 * and answers a key within a fifth of a second, and is twenty times what a
 * writer can make.
 *
 * It deletes, so it is not free to change either way: see `TABLE_DEPTH_MOST`.
 * A browser that cannot edit the document writes nothing, and where it is
 * handed a document past this number it says that the document cannot be
 * shown (`holdBinding` of ./extensions.tsx says what that costs a reader).
 */
export const TABLE_FLOOD_MOST = 2000;

/** The tables in a node: their cells, how deep they stand, and whether one of them is past a bound. */
interface Held {
  cells: number;
  levels: number;
  past: boolean;
}
const NONE: Held = { cells: 0, levels: 0, past: false };
// A node never changes, and a change to a document keeps every node it does
// not touch: what was counted once is not counted again at the next key.
const COUNTED = new WeakMap<PMNode, Held>();

const role = (node: PMNode): unknown => node.type.spec.tableRole;

// A node that a rule made again, with less in it or with other attributes, and
// the node it was made of. The collaboration binding knows a node of the
// shared document by the node it first made of it; so that the one that stands
// in the text in its place is known for the same (`leftOut` of ./extensions.tsx).
const MADE_OF = new WeakMap<PMNode, PMNode>();
/** Records that `made` stands for `of`, and returns it. */
export function madeOf<Made extends PMNode | null>(made: Made, of: PMNode): Made {
  if (made && made !== of) MADE_OF.set(made, of);
  return made;
}
/** The node that was first made, of which this one was made again, however often. */
export function firstOf(node: PMNode): PMNode {
  for (let of = MADE_OF.get(node); of; of = MADE_OF.get(node)) node = of;
  return node;
}

function tablesAmong(content: Fragment): Held {
  let cells = 0;
  let levels = 0;
  let past = false;
  content.forEach((child) => {
    const held = tablesIn(child);
    cells += held.cells;
    levels = Math.max(levels, held.levels);
    past ||= held.past;
  });
  return cells || levels ? { cells, levels, past } : NONE;
}

/** The tables in a node, itself among them where it is one. */
export function tablesIn(node: PMNode): Held {
  if (node.isLeaf || node.isTextblock) return NONE;
  let held = COUNTED.get(node);
  if (!held) {
    const { cells, levels, past } = tablesAmong(node.content);
    if (role(node) === 'table') {
      held = {
        cells,
        levels: levels + 1,
        past: past || cells > TABLE_CELLS_MOST || levels + 1 > TABLE_DEPTH_MOST,
      };
    } else if (role(node) === 'cell' || role(node) === 'header_cell') {
      held = { cells: cells + 1, levels, past };
    } else held = cells || levels ? { cells, levels, past } : NONE;
    COUNTED.set(node, held);
  }
  return held;
}

const TABLES = new WeakMap<PMNode, number>();
/** How many tables a node holds, itself among them where it is one, and those in cells among them. */
export function tableCount(node: PMNode): number {
  if (node.isLeaf || node.isTextblock) return 0;
  let count = TABLES.get(node);
  if (count === undefined) {
    count = role(node) === 'table' ? 1 : 0;
    for (const child of node.children) count += tableCount(child);
    TABLES.set(node, count);
  }
  return count;
}

/**
 * A node with the tables in it inside what is left of the two bounds, or null
 * where nothing of it is left. `levels` is how many more levels of table may
 * open in it; `left.cells` is how many more cells, counted down as they are
 * kept.
 */
function fit(node: PMNode, levels: number, left: { cells: number }): PMNode | null {
  // No table in it: a paragraph, a cell of text.
  if (tablesIn(node).levels === 0) return node;
  const table = role(node) === 'table';
  if (table && levels === 0) return null;
  let changed = false;
  const kept: PMNode[] = [];
  node.forEach((child) => {
    let fitted: PMNode | null = null;
    // A row is kept whole or not at all, so that the table stays a grid: its
    // own cells are counted first, and then what is in them.
    if (!table) fitted = fit(child, levels, left);
    else if (child.childCount <= left.cells) {
      left.cells -= child.childCount;
      fitted = fit(child, levels - 1, left);
    }
    if (fitted !== child) changed = true;
    if (fitted) kept.push(fitted);
  });
  if (!changed) return node;
  // A table without a row is none, and a block that held a table and holds
  // none now is nothing: the schema would fill it with a table of no cell.
  if (table) return kept.length > 0 ? madeOf(node.type.create(node.attrs, kept, node.marks), node) : null;
  if (
    node.children.some((child) => role(child) === 'table') &&
    !kept.some((child) => role(child) === 'table')
  )
    return null;
  // A cell or a quotation that held nothing else holds an empty paragraph.
  const content = Fragment.from(kept);
  return madeOf(
    node.type.validContent(content)
      ? node.copy(content)
      : node.type.createAndFill(node.attrs, content, node.marks),
    node,
  );
}

/**
 * The rows of a table with the tables in its cells inside the two bounds, and
 * the rows themselves where they are inside them already.
 *
 * WHAT IS LEFT OUT, where they are not. A table that would stand deeper than
 * `TABLE_DEPTH_MOST`, with its block and its caption. And of the cells past
 * `TABLE_CELLS_MOST`: the table's own cells are counted first, and are never
 * what goes; then the rows of the tables in its cells are counted in the order
 * of the document, and a row that would take the count past the bound is left
 * out, whole, with what is in it. A table left without a row goes with its
 * block.
 *
 * In the order of the document, and not the newest: a shared document holds
 * no time, and the order is the one thing every browser holds alike
 * (`closeSchema`). So every browser leaves out the same, and what is left is
 * inside the bounds, so that nothing more is left out when it is made again.
 *
 * Nothing is added but the empty paragraph of a cell that held a table alone:
 * what is left out is taken out of the shared document by every browser that
 * opens it, and two that take the same thing out agree, where two that put
 * something in would each put in their own (`holdBinding`).
 */
export function closeNested(rows: Fragment): Fragment {
  const { cells, levels } = tablesAmong(rows);
  if (cells <= TABLE_CELLS_MOST && levels < TABLE_DEPTH_MOST) return rows;
  let own = 0;
  rows.forEach((row) => (own += row.childCount));
  const left = { cells: TABLE_CELLS_MOST - own };
  return Fragment.from(rows.content.map((row) => fit(row, TABLE_DEPTH_MOST - 1, left)!));
}

/**
 * What a table put at a place may still hold: how many levels of table, itself
 * counted, and how many cells. The cells are those left to the outermost
 * table round the place, and all of them where no table is round it.
 */
export function tableRoom($at: ResolvedPos): { cells: number; levels: number } {
  let levels = TABLE_DEPTH_MOST;
  let outermost: PMNode | null = null;
  for (let depth = 1; depth <= $at.depth; depth += 1) {
    if (role($at.node(depth)) !== 'table') continue;
    levels -= 1;
    outermost ??= $at.node(depth);
  }
  return { cells: TABLE_CELLS_MOST - (outermost ? tablesIn(outermost).cells : 0), levels };
}

const cell = (node: PMNode) => role(node) === 'cell' || role(node) === 'header_cell';
/** Whether the last thing a cell holds is a table, in its block: the cell then ends where no text can be written. */
const endsInTable = (node: PMNode) => cell(node) && role(node.lastChild?.firstChild ?? node) === 'table';

/**
 * The end of every cell of `after` whose last child is the block of a table
 * that is not the last child of a cell of `before`: where a paragraph is put
 * after a table that this writer's paste left at the end of a cell (`Closed`
 * of ./extensions.tsx).
 *
 * The table is known by the node, and a node is the same only while nothing
 * in it changed. So this is every cell that the paste made end in a table,
 * AND every cell that ended in one already where the paste changed anything
 * inside that table: plain text pasted into a cell of a table that ends its
 * cell gives that cell a paragraph too (the re-review of pull request 28).
 * That is kept: the paste is the writer's own change in that cell, and the
 * paragraph is in the same step of undo. A cell that ends in a table in which
 * the paste changed nothing is left as it was, whoever made it so.
 */
export function tablesEndingCells(before: PMNode, after: PMNode): number[] {
  const ended = new WeakSet<PMNode>();
  before.descendants((node) => {
    if (endsInTable(node)) ended.add(node.lastChild!);
    return tablesIn(node).levels > 0;
  });
  const ends: number[] = [];
  after.descendants((node, pos) => {
    if (endsInTable(node) && !ended.has(node.lastChild!)) ends.push(pos + node.nodeSize - 1);
    return tablesIn(node).levels > 0;
  });
  return ends;
}
