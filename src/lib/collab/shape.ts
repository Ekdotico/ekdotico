// The shape of a document that the collaboration server holds every update to,
// beside its three limits (./state.ts). Two rules of the register, decided and
// owed before sharing:
//
// - D170, as D180 narrows it: an update that CREATES an element lacking the
//   content the editor's schema requires of it is refused. A browser that
//   opened such an element would fill it and write the filling back, and for
//   many elements that write is past 5 MB, so the server refused the writer who
//   did nothing (the reviews of pull request 28). An update that empties an
//   element that is there already is not refused: it cannot be told from an
//   honest deletion made at the same time as another writer's (D180). What it
//   costs a browser to repair is the browser's to bound, which is not built.
// - D171 with D172: an update that takes a table past a bound is refused. The
//   bounds are those the browser holds (FR-ED-09): 100 rows, 100 cells in a
//   row, 10,000 cells in a table and the tables in its cells together, and two
//   levels of table, the outermost counted. As for the limits, a table past a
//   bound already, stored before there was one, is refused only what takes it
//   further past, so that it can still be written in and deleted from.
//
// The rules are asked of what the update would leave, without copying the
// document where that can be read off the update and the document as they are
// (`withoutCopy`): an update that holds no element, which is every key typed in
// text, is answered from its decoding alone; one that does, from the elements
// it names and the tables round them. Only an update that Yjs would not take
// in whole and at once is applied to a copy (`withCopy`), as the measure of the
// limits is: one that waits for content the document was never sent, that
// wakes what the document waits with, or that holds the structs of more than
// one client. No browser sends such an update while it writes; the copy is the
// cost the limits already accept for it (register D132, D167), bounded by the
// limit of messages.
//
// The bounds are named here, where the browser can import them too
// (src/app/(app)/documents/[id]/table-bounds.ts), so that the two hold the same.
import { Schema, type NodeSpec } from '@tiptap/pm/model';
import * as Y from 'yjs';

/** The most rows of a table, and the most cells of a row (FR-ED-09). */
export const TABLE_MOST = 100;
/** The most cells of a table and of every table in its cells, together (register D171). */
export const TABLE_CELLS_MOST = TABLE_MOST * TABLE_MOST;
/** The most levels of table, one in a cell of another, the outermost counted (register D172). */
export const TABLE_DEPTH_MOST = 2;

/**
 * What each node of the editor's schema holds, in the order of the schema:
 * the server's copy of the content and the groups of
 * src/app/(app)/documents/[id]/extensions.tsx, which it cannot import.
 * tests/unit/collab-shape.test.ts fails where the two differ.
 */
export const NODES: Record<string, NodeSpec> = {
  paragraph: { content: 'inline*', group: 'block' },
  blockquote: { content: 'block+', group: 'block' },
  bulletList: { content: 'listItem+', group: 'block list' },
  doc: { content: 'block+' },
  hardBreak: { group: 'inline', inline: true },
  heading: { content: 'inline*', group: 'block' },
  horizontalRule: { group: 'block' },
  listItem: { content: 'paragraph block*' },
  orderedList: { content: 'listItem+', group: 'block list' },
  text: { group: 'inline' },
  codeBlock: { content: 'text*', group: 'block' },
  callout: { content: 'paragraph+', group: 'block' },
  tableOfContents: { group: 'block' },
  pageBreak: { group: 'block' },
  table: { content: `tableRow{1,${TABLE_MOST}}`, group: '' },
  tableRow: { content: `(tableCell | tableHeader){0,${TABLE_MOST}}` },
  tableHeader: { content: 'block+' },
  tableCell: { content: 'block+' },
  tableBlock: { content: 'table tableCaption', group: 'block' },
  tableCaption: { content: 'text*' },
};
const SCHEMA = new Schema({ nodes: NODES, topNode: 'doc' });

/** Which rule an update would break: `incomplete` (D170, D180) or `table` (D171, D172). */
export type Shape = 'incomplete' | 'table';

/** A node of a document as a rule reads it: its name, and what it holds that is not deleted. */
interface Tree<Node> {
  name(node: Node): string | null;
  children(node: Node): Iterable<Node>;
}

/**
 * Whether an element the schema would have to fill: its children are taken in
 * their order, each that the content takes after those before it, as
 * `closeSchema` of the editor takes them, and what is left is not a whole.
 * A child the content does not take is left out by the browser, which writes
 * nothing for it, so it is no part of this rule. An element of no type is
 * left out whole.
 */
function lacks<Node>(tree: Tree<Node>, element: Node): boolean {
  const type = SCHEMA.nodes[tree.name(element) ?? ''];
  if (!type) return false;
  let match = type.contentMatch;
  for (const child of tree.children(element)) {
    const childType = SCHEMA.nodes[tree.name(child) ?? ''];
    const next = childType && match.matchType(childType);
    if (next) match = next;
  }
  return !match.validEnd;
}

/** What the bounds of D171 and D172 count, for a table and the tables in its cells. */
interface Measure {
  /** The most rows of one of the tables. */
  rows: number;
  /** The most cells of one of their rows. */
  row: number;
  /** Their cells, together. */
  cells: number;
  /** How deep they stand, the outermost counted. */
  levels: number;
}
const BOUNDS: Measure = {
  rows: TABLE_MOST,
  row: TABLE_MOST,
  cells: TABLE_CELLS_MOST,
  levels: TABLE_DEPTH_MOST,
};
const NONE: Measure = { rows: 0, row: 0, cells: 0, levels: 0 };
const TABLE_PARTS = new Set(['table', 'tableRow', 'tableCell', 'tableHeader']);
const CELLS = new Set(['tableCell', 'tableHeader']);

/**
 * A table and the tables in its cells, counted as the browser counts them
 * (`tablesIn` of table-bounds.ts): the rows of a table, the cells of a row,
 * and a table anywhere in a cell one level further. Counted with a list of
 * what is still to be looked at, and never by a function that calls itself.
 */
function measure<Node>(tree: Tree<Node>, table: Node): Measure {
  const found = { ...NONE };
  const tables: [Node, number][] = [[table, 1]];
  for (let next = tables.pop(); next; next = tables.pop()) {
    const [held, level] = next;
    found.levels = Math.max(found.levels, level);
    let rows = 0;
    for (const row of tree.children(held)) {
      if (tree.name(row) !== 'tableRow') continue;
      rows += 1;
      let cells = 0;
      for (const cell of tree.children(row)) {
        if (!CELLS.has(tree.name(cell) ?? '')) continue;
        cells += 1;
        const inside = [cell];
        for (let node = inside.pop(); node !== undefined; node = inside.pop()) {
          for (const child of tree.children(node)) {
            if (tree.name(child) === 'table') tables.push([child, level + 1]);
            else inside.push(child);
          }
        }
      }
      found.row = Math.max(found.row, cells);
      found.cells += cells;
    }
    found.rows = Math.max(found.rows, rows);
  }
  return found;
}

/** Past a bound, and further past than before: a table stored past one is not closed to every change. */
const pastBounds = (before: Measure, after: Measure) =>
  (Object.keys(BOUNDS) as (keyof Measure)[]).some(
    (key) => after[key] > BOUNDS[key] && after[key] > before[key],
  );

type Shared = Y.AbstractType<unknown>;
const nameOfType = (type: unknown): string | null => {
  if (type instanceof Y.XmlText) return 'text';
  const name = (type as { nodeName?: unknown }).nodeName;
  return typeof name === 'string' ? name : null;
};
function* live(type: Shared): Iterable<Y.Item> {
  for (let item = type._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentType) yield item;
  }
}
/** A document as it is: its shared types, and what each holds that is not deleted. */
const AS_IT_IS: Tree<Shared> = {
  name: nameOfType,
  *children(type) {
    for (const item of live(type)) yield (item.content as Y.ContentType).type as Shared;
  },
};
/** The outermost table round a shared type, itself among them, or null. */
function outermost(type: Shared): Shared | null {
  let found: Shared | null = null;
  for (let at: Shared | null = type; at; at = (at._item?.parent as Shared | undefined) ?? null) {
    if (nameOfType(at) === 'table') found = at;
  }
  return found;
}

/**
 * Which rule an update would break, asked before it is applied, or null where
 * it keeps both. It throws where Yjs throws applying it, as `pastLimits` does.
 */
export function shapeOf(document: Y.Doc, update: Uint8Array): Shape | null {
  const read = Y.decodeUpdate(update);
  // No element in it: no element is made, and no table grows.
  if (!read.structs.some((struct) => struct instanceof Y.Item && nameOf(struct) !== null)) return null;
  const quick = withoutCopy(document, read);
  return quick === undefined ? withCopy(document, update) : quick;
}

/** The name of what an item of an update holds, where it holds a shared type: an element, or text. */
function nameOf(item: Y.Item): string | null {
  return item.content instanceof Y.ContentType ? nameOfType(item.content.type) : null;
}

/**
 * `shapeOf` on a copy of the document that the update is applied to: exact,
 * and the time of a store (65 to 250 ms at 5 MB; ./state.ts). The elements an
 * update creates are those of a clock the document had not reached, which
 * takes in what the document waited with and the update brought in.
 */
export function withCopy(document: Y.Doc, update: Uint8Array): Shape | null {
  const reached = Y.decodeStateVector(Y.encodeStateVector(document));
  const after = new Y.Doc();
  try {
    Y.applyUpdate(after, Y.encodeStateAsUpdate(document));
    Y.applyUpdate(after, update);
    const tables = new Set<Shared>();
    for (const [client, structs] of after.store.clients) {
      const from = reached.get(client) ?? 0;
      if (from >= Y.getState(after.store, client)) continue;
      for (let at = Y.findIndexSS(structs, from); at < structs.length; at += 1) {
        const item = structs[at];
        if (!(item instanceof Y.Item) || item.deleted || !(item.content instanceof Y.ContentType)) continue;
        const type = item.content.type as Shared;
        if (lacks(AS_IT_IS, type)) return 'incomplete';
        const table = TABLE_PARTS.has(nameOfType(type) ?? '') && outermost(type);
        if (table) tables.add(table);
      }
    }
    for (const table of tables) {
      // The same table before the update, where it was there.
      const { id } = table._item!;
      const was =
        id.clock < Y.getState(document.store, id.client)
          ? ((Y.getItem(document.store, id) as Y.Item).content as Y.ContentType).type
          : null;
      if (pastBounds(was ? measure(AS_IT_IS, was as Shared) : NONE, measure(AS_IT_IS, table))) return 'table';
    }
    return null;
  } finally {
    after.destroy();
  }
}

// What stands directly in the document, as the parent of an item of an update.
const ROOT = Symbol('root');
/** Where an item of an update goes: a shared type of the document, an item of the update, the document itself, or nowhere (it is collected). */
type Parent = Shared | Y.Item | typeof ROOT | null;

/**
 * `shapeOf` without the copy, or undefined where it cannot be said so. It
 * answers for an update that Yjs takes in whole and at once: the structs of
 * one client, in a run that begins exactly where the document has that client
 * and has no gap, each naming only what the document holds or what comes
 * before it in the run, and none of a client the document waits for. That is
 * what a browser sends.
 *
 * EXACTLY, AND NOT EARLIER (the review of pull request 39). A run that begins
 * earlier can hold a struct the document has in part, of which Yjs applies
 * the rest; two pieces sent once and again merged into one struct are such a
 * struct. An item named by a clock in that rest would be read here as the
 * struct the document does not hold whole, which a decoded update gives no
 * parent, and would go nowhere where Yjs puts it in its parent. Beginning
 * exactly at the document's clock, every struct of the run is new and read
 * here in order, and every clock below it is the document's own: so each
 * identifier names either a struct of the document or one this function has
 * already placed. Any other run is the copy's.
 *
 * Where each item goes is then read as Yjs reads it (`Item.getMissing`,
 * `Item.integrate` of Yjs 13.6.33): by its parent, or by the item to its left
 * or right; to nowhere where one of those is collected; and deleted where the
 * update deletes it or what it stands in. Not counted: a delete set that the
 * document holds waiting (`store.pendingDs`), which Yjs tries again at every
 * update and which can delete what this update brings. That can only delete,
 * so it can leave an element this update made without its content, which is
 * the emptying that D180 accepts the server does not refuse; and it can make
 * a table smaller than counted here, never larger.
 *
 * The order of the children of an element the update creates is read off it
 * where each was put right after the one before (no item to its right, and no
 * two after one), which is how the editor's binding writes an element whole;
 * otherwise the answer is the copy's. Only `tableBlock` turns on that order.
 */
export function withoutCopy(
  document: Y.Doc,
  { structs, ds }: ReturnType<typeof Y.decodeUpdate>,
): Shape | null | undefined {
  const { store } = document;
  const client = structs[0]!.id.client;
  const had = Y.getState(store, client);
  if (structs[0]!.id.clock !== had || store.pendingStructs?.missing.has(client)) return undefined;
  let clock = structs[0]!.id.clock;
  for (const struct of structs) {
    if (struct instanceof Y.Skip || struct.id.client !== client || struct.id.clock !== clock)
      return undefined;
    clock += struct.length;
  }
  /** What an identifier names: a struct of the document, or one of the run before `before`, or undefined. */
  const named = (id: Y.ID, before: number): Y.Item | Y.GC | undefined => {
    if (id.clock < Y.getState(store, id.client)) return Y.getItem(store, id) as Y.Item | Y.GC;
    if (id.client !== client || id.clock >= before) return undefined;
    let low = 0;
    let high = structs.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (structs[middle]!.id.clock <= id.clock) low = middle;
      else high = middle - 1;
    }
    return structs[low] as Y.Item | Y.GC;
  };
  const parents = new Map<Y.Item, Parent>();
  const keys = new Map<Y.Item, string | null>();
  const alive = new Map<Y.Item, boolean>();
  const shared = new Map<Shared, boolean>();
  /** Whether a shared type of the document is there after the update: it and all round it, not deleted. */
  const there = (type: Shared): boolean => {
    let known = shared.get(type);
    if (known === undefined) {
      known = true;
      for (let item = type._item; item; item = (item.parent as Shared)._item) {
        if (item.deleted || Y.isDeleted(ds, item.id)) known = false;
      }
      shared.set(type, known);
    }
    return known;
  };
  const standsIn = (parent: Parent): boolean =>
    parent === ROOT ||
    (parent instanceof Y.Item ? alive.get(parent) === true : parent !== null && there(parent));
  /** The children each element of the update or of the document gains, in the order of the run. */
  const gained = new Map<Y.Item | Shared, Y.Item[]>();
  const made: Y.Item[] = [];
  for (const item of structs) {
    if (!(item instanceof Y.Item)) continue;
    const { origin, rightOrigin } = item;
    const ids = [origin, rightOrigin, item.parent instanceof Y.ID ? item.parent : null];
    const found = ids.map((id) => (id ? named(id, item.id.clock) : null));
    if (found.some((struct) => struct === undefined)) return undefined;
    const [left, right, above] = found as (Y.Item | Y.GC | null)[];
    let parent: Parent = null;
    let key = item.parentSub;
    if (left instanceof Y.GC || right instanceof Y.GC) parent = null;
    else if (item.parent === null) {
      // Where the item to its left or right is.
      const beside = left ?? right;
      if (!beside) return undefined;
      parent = parents.has(beside) ? parents.get(beside)! : (beside.parent as Shared);
      key = parents.has(beside) ? keys.get(beside)! : beside.parentSub;
    } else if (typeof item.parent === 'string' || item.parent instanceof Y.AbstractType) {
      // A shared type of the document itself, which a decoded update names by its key.
      parent = ROOT;
    } else if (above instanceof Y.Item && above.content instanceof Y.ContentType)
      parent = parents.has(above) ? above : (above.content.type as Shared);
    parents.set(item, parent);
    keys.set(item, key);
    alive.set(
      item,
      parent !== null &&
        standsIn(parent) &&
        !Y.isDeleted(ds, item.id) &&
        !(item.content instanceof Y.ContentDeleted),
    );
    if (parent === null || key !== null) continue;
    if (nameOf(item) !== null) made.push(item);
    if (parent === ROOT) continue;
    const list = gained.get(parent) ?? [];
    list.push(item);
    gained.set(parent, list);
  }

  type Node = Shared | Y.Item;
  const name = (node: Node) => (node instanceof Y.Item ? nameOf(node) : nameOfType(node));
  const after: Tree<Node> = {
    name,
    *children(node) {
      if (!(node instanceof Y.Item)) {
        for (const item of live(node)) {
          if (!Y.isDeleted(ds, item.id)) yield (item.content as Y.ContentType).type as Shared;
        }
      }
      for (const item of gained.get(node) ?? []) if (alive.get(item) && nameOf(item) !== null) yield item;
    },
  };
  const tables = new Set<Node>();
  for (const item of made) {
    if (!alive.get(item)) continue;
    const children = inOrder(gained.get(item) ?? []);
    if (!children) return undefined;
    const itself: Tree<Node> = { name, children: () => children.filter((child) => alive.get(child)) };
    if (lacks(itself, item)) return 'incomplete';
    if (!TABLE_PARTS.has(nameOf(item)!)) continue;
    // The outermost table round it: up through the update, then through the document.
    let table: Node | null = null;
    for (let at: Node | null = item; at;) {
      if (name(at) === 'table') table = at;
      const up: Parent =
        at instanceof Y.Item ? parents.get(at)! : ((at._item?.parent as Shared | undefined) ?? ROOT);
      at = up === ROOT || up === null ? null : up;
    }
    if (table) tables.add(table);
  }
  for (const table of tables) {
    const before = table instanceof Y.Item ? NONE : measure(AS_IT_IS, table);
    if (pastBounds(before, measure(after, table))) return 'table';
  }
  return null;
}

/**
 * The children an element of the update was made with, in their order, where
 * each was put right after the one before it; or undefined.
 */
function inOrder(children: Y.Item[]): Y.Item[] | undefined {
  const byEnd = new Map<string, Y.Item>();
  for (const child of children) byEnd.set(`${child.id.client}:${child.id.clock + child.length - 1}`, child);
  const next = new Map<Y.Item | null, Y.Item>();
  for (const child of children) {
    const left = child.origin ? byEnd.get(`${child.origin.client}:${child.origin.clock}`) : null;
    if (child.rightOrigin || left === undefined || next.has(left)) return undefined;
    next.set(left, child);
  }
  const order: Y.Item[] = [];
  for (let child = next.get(null); child; child = next.get(child)) order.push(child);
  return order.length === children.length ? order : undefined;
}
