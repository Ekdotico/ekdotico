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
 * AWAITS THE OWNER (R32 allows a table in a cell and names no depth; the row
 * for the register is reported with the pull request). The limit of the
 * collaboration server alone, 50 elements one in another
 * (src/lib/collab/state.ts), would allow 12: each level is four elements, the
 * block, the table, the row and the cell, and the text of the twelfth is the
 * 49th. Two is the least that the decision asks for, and the one choice that
 * can be changed without loss: a bound that is raised deletes nothing, and one
 * that is lowered deletes every table past it, for everyone.
 */
export const TABLE_DEPTH_MOST = 2;

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
  if (table) return kept.length > 0 ? node.type.create(node.attrs, kept, node.marks) : null;
  if (
    node.children.some((child) => role(child) === 'table') &&
    !kept.some((child) => role(child) === 'table')
  )
    return null;
  // A cell or a quotation that held nothing else holds an empty paragraph.
  const content = Fragment.from(kept);
  return node.type.validContent(content)
    ? node.copy(content)
    : node.type.createAndFill(node.attrs, content, node.marks);
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
