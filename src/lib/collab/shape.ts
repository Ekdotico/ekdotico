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
// - D184 and D192: an update that leaves the document with more of a block
//   than its limit, and with more than it had, is refused: 100 tables, 200
//   code blocks, 200 callouts, 5 tables of contents, 500 page breaks, 500
//   dividers, 500 quotes, counted wherever they stand, a table in a cell
//   counted as one more; 1,000 items in one list, and lists nested 10 deep.
//   And D193: a code block of more than 500 KB of text. Counted as the
//   browser counts them (src/app/(app)/documents/[id]/block-limits.ts), and,
//   as for the bounds, what a document holds past a limit already is refused
//   only what takes it further past, so that it can still be deleted from.
//   The total of 5,000 blocks of D192 is not built: what it counts is open.
//
// The bounds and the limits are named here, where the browser can import them
// too (src/app/(app)/documents/[id]/table-bounds.ts and block-limits.ts), so
// that the two hold the same.
import { Schema, type NodeSpec } from '@tiptap/pm/model';
import * as Y from 'yjs';
import { FRAGMENT_NAME } from './protocol.ts';

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

/**
 * The limits of a document (register D184, D192, D193), by name: the most
 * blocks of a type in a document, wherever they stand; `listItems`, the most
 * items of one list; `listDepth`, the most levels of list, one in an item of
 * another, the outermost counted; `codeBytes`, the most bytes of the text of
 * one code block in UTF-8, 500 KB of 1,024 bytes, as the 5 MB of ./state.ts
 * are counted.
 */
export const LIMITS = {
  tables: 100,
  codeBlocks: 200,
  callouts: 200,
  tablesOfContents: 5,
  pageBreaks: 500,
  dividers: 500,
  quotes: 500,
  listItems: 1000,
  listDepth: 10,
  codeBytes: 500 * 1024,
} as const;
export type Limit = keyof typeof LIMITS;
/** The limits that count a block of a type wherever it stands, by the name of its node. */
export const COUNTED: ReadonlyMap<string, Limit> = new Map([
  ['table', 'tables'],
  ['codeBlock', 'codeBlocks'],
  ['callout', 'callouts'],
  ['tableOfContents', 'tablesOfContents'],
  ['pageBreak', 'pageBreaks'],
  ['horizontalRule', 'dividers'],
  ['blockquote', 'quotes'],
]);
export const LISTS: ReadonlySet<string> = new Set(['bulletList', 'orderedList']);
const LIST_PARTS = new Set([...LISTS, 'listItem']);

/**
 * The bytes of a text in UTF-8; or its length in UTF-16, where three bytes
 * for each unit would not pass `LIMITS.codeBytes`. A unit is one byte at
 * least and three at most, and a pair of them four, so only a text between a
 * third of the limit and the limit is counted byte by byte.
 */
export function textBytes(texts: readonly string[]): number {
  let units = 0;
  for (const text of texts) units += text.length;
  if (units * 3 <= LIMITS.codeBytes) return units;
  let bytes = 0;
  for (const text of texts) {
    for (let at = 0; at < text.length; at += 1) {
      const unit = text.charCodeAt(at);
      if (unit < 0x80) bytes += 1;
      else if (unit < 0x800) bytes += 2;
      else if (unit >= 0xd800 && unit < 0xdc00 && at + 1 < text.length) {
        bytes += 4;
        at += 1;
      } else bytes += 3;
    }
  }
  return bytes;
}

/** Past a limit, and further past than before: what a document holds already is not closed to every change. */
export const pastLimit = (limit: Limit, before: number, after: number) =>
  after > LIMITS[limit] && after > before;

/** Which rule an update would break: `incomplete` (D170, D180), `table` (D171, D172), or a limit (D184, D192, D193). */
export type Shape = 'incomplete' | 'table' | Limit;

/** A node of a document as a rule reads it: its name, and what it holds that is not deleted. */
interface Tree<Node> {
  name(node: Node): string | null;
  children(node: Node): Iterable<Node>;
  /** The text of a node that is text, in its pieces. */
  strings?(text: Node): Iterable<string>;
}

/** How many blocks of each type of `COUNTED` stand in what is given, at any depth. */
function countsIn<Node>(tree: Tree<Node>, roots: Iterable<Node>): Map<Limit, number> {
  const found = new Map<Limit, number>();
  const left = [...roots];
  for (let node = left.pop(); node !== undefined; node = left.pop()) {
    const limit = COUNTED.get(tree.name(node) ?? '');
    if (limit) found.set(limit, (found.get(limit) ?? 0) + 1);
    for (const child of tree.children(node)) left.push(child);
  }
  return found;
}
const COUNTED_LIMITS = [...new Set(COUNTED.values())];
/** The first limit of `COUNTED` that a document passes, and further than before. */
const pastCounts = (before: Map<Limit, number>, after: Map<Limit, number>) =>
  COUNTED_LIMITS.find((limit) => pastLimit(limit, before.get(limit) ?? 0, after.get(limit) ?? 0)) ?? null;

/** What the limits of lists count of one list: its items, and how deep it stands, the outermost counted. */
interface Lists {
  listItems: number;
  listDepth: number;
}
/** Each list of an outermost list, itself among them, with what the limits count of it. */
function listsIn<Node>(tree: Tree<Node>, list: Node): Map<Node, Lists> {
  const found = new Map<Node, Lists>();
  const left: [Node, number][] = [[list, 0]];
  for (let next = left.pop(); next; next = left.pop()) {
    const [node, round] = next;
    let above = round;
    if (LISTS.has(tree.name(node) ?? '')) {
      above += 1;
      let items = 0;
      for (const child of tree.children(node)) if (tree.name(child) === 'listItem') items += 1;
      found.set(node, { listItems: items, listDepth: above });
    }
    for (const child of tree.children(node)) left.push([child, above]);
  }
  return found;
}
/**
 * The first limit of lists that a list passes, and further than that same
 * list was before (the review of pull request 41: not the most of all the
 * lists round it, which let a new list past the limit stand beside a list
 * stored past it). `same` names a list as it was before, or nothing for one
 * the update made.
 */
function pastLists<Node>(
  outermost: { before: Map<unknown, Lists>; after: Map<Node, Lists>; same: (list: Node) => unknown }[],
): 'listItems' | 'listDepth' | null {
  for (const limit of ['listItems', 'listDepth'] as const)
    for (const { before, after, same } of outermost)
      for (const [list, now] of after)
        if (pastLimit(limit, before.get(same(list))?.[limit] ?? 0, now[limit])) return limit;
  return null;
}

/** The bytes of the text of a code block (`textBytes`). */
function codeBytesIn<Node>(tree: Tree<Node>, block: Node): number {
  const strings: string[] = [];
  for (const child of tree.children(block)) {
    if (tree.name(child) === 'text') strings.push(...(tree.strings?.(child) ?? []));
  }
  return textBytes(strings);
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
  strings: (text) => stringsOf(text),
};
type DeleteSet = ReturnType<typeof Y.decodeUpdate>['ds'];
/** The ranges of a delete set of one client, each a clock and a length. */
const rangesOf = (deleted: DeleteSet, client: number): { clock: number; len: number }[] =>
  (deleted as unknown as { clients: Map<number, { clock: number; len: number }[]> }).clients.get(client) ??
  [];
type Ranges = { clock: number; end: number }[];
// The ranges of each client of a delete set, sorted and merged once for the
// set, and not once for each item they are asked of (the re-review of pull
// request 41: items times ranges stalled the server for 14 seconds).
const MERGED = new WeakMap<DeleteSet, Map<number, Ranges>>();
function mergedOf(deleted: DeleteSet, client: number): Ranges {
  let clients = MERGED.get(deleted);
  if (!clients) MERGED.set(deleted, (clients = new Map()));
  let merged = clients.get(client);
  if (!merged) {
    merged = [];
    for (const { clock, len } of rangesOf(deleted, client).toSorted((a, b) => a.clock - b.clock)) {
      const last = merged.at(-1);
      if (last && clock <= last.end) last.end = Math.max(last.end, clock + len);
      else merged.push({ clock, end: clock + len });
    }
    clients.set(client, merged);
  }
  return merged;
}
/**
 * What is left of the text of an item where `deleted` deletes part of it: a
 * delete set can delete any part of an item, and Yjs merges typing into long
 * items (the review of pull request 41). Pieces in UTF-16, as the item holds them.
 */
function* survives(item: Y.Item, deleted?: DeleteSet): Iterable<string> {
  const { str } = item.content as Y.ContentString;
  if (!deleted) return yield str;
  const { client, clock } = item.id;
  const ranges = mergedOf(deleted, client);
  // The first range that ends after the item begins, and then only those that overlap it.
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (ranges[middle]!.end <= clock) low = middle + 1;
    else high = middle;
  }
  let from = 0;
  for (let at = low; at < ranges.length && ranges[at]!.clock < clock + str.length; at += 1) {
    const start = Math.max(ranges[at]!.clock - clock, from);
    const end = Math.min(ranges[at]!.end - clock, str.length);
    if (end <= start) continue;
    if (start > from) yield str.slice(from, start);
    from = end;
  }
  if (from < str.length) yield str.slice(from);
}
/** The pieces of a text that are not deleted, nor deleted by `deleted`. */
function* stringsOf(text: Shared, deleted?: DeleteSet): Iterable<string> {
  for (let item = text._start; item; item = item.right) {
    if (!item.deleted && item.content instanceof Y.ContentString) yield* survives(item, deleted);
  }
}
const HIGH = (unit: number) => unit >= 0xd800 && unit < 0xdc00;
const LOW = (unit: number) => unit >= 0xdc00 && unit < 0xe000;
/**
 * Whether an item of text would be split between the two halves of a pair
 * of UTF-16 units at `at` units into it, which Yjs answers by putting U+FFFD
 * for each half: three bytes for each where the pair was four.
 */
const splitsPair = (item: Y.Item | Y.GC | undefined, at: number) => {
  if (!(item instanceof Y.Item) || !(item.content instanceof Y.ContentString)) return false;
  const { str } = item.content;
  return at > 0 && at < str.length && HIGH(str.charCodeAt(at - 1)) && LOW(str.charCodeAt(at));
};
/** The outermost of the named round a shared type, itself among them, or null. */
function outermost(type: Shared, names: ReadonlySet<string>): Shared | null {
  let found: Shared | null = null;
  for (let at: Shared | null = type; at; at = (at._item?.parent as Shared | undefined) ?? null) {
    if (names.has(nameOfType(at) ?? '')) found = at;
  }
  return found;
}
/** The same shared type in the document before an update, where it was there. */
function was(document: Y.Doc, type: Shared): Shared | null {
  const { id } = type._item!;
  return id.clock < Y.getState(document.store, id.client)
    ? (((Y.getItem(document.store, id) as Y.Item).content as Y.ContentType).type as Shared)
    : null;
}
const TABLES = new Set(['table']);

/**
 * Which rule an update would break, asked before it is applied, or null where
 * it keeps both. It throws where Yjs throws applying it, as `pastLimits` does.
 */
export function shapeOf(document: Y.Doc, update: Uint8Array): Shape | null {
  const read = Y.decodeUpdate(update);
  // No element in it and no text: no element is made, no table and no count
  // grows, and no code block is longer.
  if (
    !read.structs.some(
      (struct) =>
        struct instanceof Y.Item && (nameOf(struct) !== null || struct.content instanceof Y.ContentString),
    )
  )
    return null;
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
    const lists = new Set<Shared>();
    const code = new Set<Shared>();
    let counted = false;
    for (const [client, structs] of after.store.clients) {
      const from = reached.get(client) ?? 0;
      if (from >= Y.getState(after.store, client)) continue;
      for (let at = Y.findIndexSS(structs, from); at < structs.length; at += 1) {
        const item = structs[at];
        if (!(item instanceof Y.Item) || item.deleted) continue;
        if (item.content instanceof Y.ContentString) {
          // Text written into a code block.
          const block = (item.parent as Shared)._item?.parent as Shared | undefined;
          if (block && nameOfType(block) === 'codeBlock') code.add(block);
          continue;
        }
        if (!(item.content instanceof Y.ContentType)) continue;
        const type = item.content.type as Shared;
        if (lacks(AS_IT_IS, type)) return 'incomplete';
        const name = nameOfType(type) ?? '';
        const table = TABLE_PARTS.has(name) && outermost(type, TABLES);
        if (table) tables.add(table);
        const list = LIST_PARTS.has(name) && outermost(type, LISTS);
        if (list) lists.add(list);
        counted ||= COUNTED.has(name);
      }
    }
    for (const table of tables) {
      const before = was(document, table);
      if (pastBounds(before ? measure(AS_IT_IS, before) : NONE, measure(AS_IT_IS, table))) return 'table';
    }
    const root = (of: Y.Doc) => {
      const type = of.share.get(FRAGMENT_NAME) as Shared | undefined;
      return type ? AS_IT_IS.children(type) : [];
    };
    const count = counted && pastCounts(countsIn(AS_IT_IS, root(document)), countsIn(AS_IT_IS, root(after)));
    if (count) return count;
    const list = pastLists(
      [...lists].map((each) => {
        const before = was(document, each);
        return {
          before: before ? listsIn(AS_IT_IS, before) : new Map(),
          after: listsIn(AS_IT_IS, each),
          same: (one: Shared) => was(document, one),
        };
      }),
    );
    if (list) return list;
    for (const block of code) {
      const before = was(document, block);
      if (pastLimit('codeBytes', before ? codeBytesIn(AS_IT_IS, before) : 0, codeBytesIn(AS_IT_IS, block)))
        return 'codeBytes';
    }
    return null;
  } finally {
    after.destroy();
  }
}

/**
 * Where an item of an update goes: a shared type of the document, an item of
 * the update, a shared type of the document itself that the document does not
 * hold yet, by its key, or nowhere (it is collected).
 */
type Parent = Shared | Y.Item | string | null;

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
    typeof parent === 'string' ||
    (parent instanceof Y.Item ? alive.get(parent) === true : parent !== null && there(parent));
  /** The children each element of the update or of the document gains, in the order of the run. */
  const gained = new Map<Y.Item | Shared | string, Y.Item[]>();
  const made: Y.Item[] = [];
  // The items that stand where they are put, whatever part of them the update deletes.
  const placed = new Set<Y.Item>();
  // A deletion that begins or ends between the two halves of a pair, in an
  // item of text of the document or of the update, is the copy's (`splitsPair`).
  for (const [deleting, ranges] of (
    ds as unknown as { clients: Map<number, { clock: number; len: number }[]> }
  ).clients) {
    for (const { clock: from, len } of ranges) {
      for (const edge of [from, from + len]) {
        const id = Y.createID(deleting, edge);
        const item =
          edge < Y.getState(store, deleting) ? Y.getItem(store, id) : named(id, Number.MAX_SAFE_INTEGER);
        if (item && splitsPair(item, edge - item.id.clock)) return undefined;
      }
    }
  }
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
    } else if (typeof item.parent === 'string') {
      // A shared type of the document itself, which a decoded update names by its key.
      parent = (document.share.get(item.parent) as Shared | undefined) ?? item.parent;
    } else if (above instanceof Y.Item && above.content instanceof Y.ContentType)
      parent = parents.has(above) ? above : (above.content.type as Shared);
    parents.set(item, parent);
    keys.set(item, key);
    const stands = parent !== null && standsIn(parent) && !(item.content instanceof Y.ContentDeleted);
    if (stands) placed.add(item);
    alive.set(item, stands && !Y.isDeleted(ds, item.id));
    // Where it is put inside an item of text of the document, between the two
    // halves of a pair, Yjs puts U+FFFD for each: the copy's to count.
    if (left && splitsPair(left, origin!.clock - left.id.clock + 1)) return undefined;
    if (right && splitsPair(right, rightOrigin!.clock - right.id.clock)) return undefined;
    if (parent === null || key !== null) continue;
    if (nameOf(item) !== null) made.push(item);
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
    *strings(text) {
      if (!(text instanceof Y.Item)) yield* stringsOf(text, ds);
      for (const item of gained.get(text) ?? []) {
        if (placed.has(item) && item.content instanceof Y.ContentString) yield* survives(item, ds);
      }
    },
  };
  /** The outermost of the named round a node: up through the update, then through the document. */
  const outermostOf = (node: Node, names: ReadonlySet<string>) => {
    let found: Node | null = null;
    for (let at: Node | null = node; at;) {
      if (names.has(name(at) ?? '')) found = at;
      const up: Parent =
        at instanceof Y.Item ? parents.get(at)! : ((at._item?.parent as Shared | undefined) ?? null);
      at = typeof up === 'string' ? null : up;
    }
    return found;
  };
  const tables = new Set<Node>();
  const lists = new Set<Node>();
  const code = new Set<Node>();
  let counted = false;
  for (const item of made) {
    if (!alive.get(item)) continue;
    const children = inOrder(gained.get(item) ?? []);
    if (!children) return undefined;
    const itself: Tree<Node> = { name, children: () => children.filter((child) => alive.get(child)) };
    if (lacks(itself, item)) return 'incomplete';
    const type = nameOf(item)!;
    const table = TABLE_PARTS.has(type) && outermostOf(item, TABLES);
    if (table) tables.add(table);
    const list = LIST_PARTS.has(type) && outermostOf(item, LISTS);
    if (list) lists.add(list);
    counted ||= COUNTED.has(type);
  }
  // Text written into a code block, in a text that is there or that the update made.
  for (const item of structs) {
    if (!(item instanceof Y.Item) || !placed.has(item) || !(item.content instanceof Y.ContentString))
      continue;
    const text = parents.get(item)!;
    const block =
      text instanceof Y.Item
        ? parents.get(text)
        : typeof text === 'string'
          ? null
          : (text?._item?.parent as Shared);
    if (block && typeof block !== 'string' && name(block) === 'codeBlock') code.add(block);
  }
  for (const table of tables) {
    const before = table instanceof Y.Item ? NONE : measure(AS_IT_IS, table);
    if (pastBounds(before, measure(after, table))) return 'table';
  }
  if (counted) {
    // The whole document, before and after, where the update made a block that a limit counts.
    const root = document.share.get(FRAGMENT_NAME) as Shared | undefined;
    const roots = root
      ? [...after.children(root)]
      : (gained.get(FRAGMENT_NAME) ?? []).filter((item) => alive.get(item) && nameOf(item) !== null);
    const count = pastCounts(countsIn(AS_IT_IS, root ? AS_IT_IS.children(root) : []), countsIn(after, roots));
    if (count) return count;
  }
  const list = pastLists(
    [...lists].map((each) => ({
      before: each instanceof Y.Item ? new Map<Shared, Lists>() : listsIn(AS_IT_IS, each),
      after: listsIn(after, each),
      same: (one: Node) => one,
    })),
  );
  if (list) return list;
  for (const block of code) {
    const before = block instanceof Y.Item ? 0 : codeBytesIn(AS_IT_IS, block);
    if (pastLimit('codeBytes', before, codeBytesIn(after, block))) return 'codeBytes';
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
