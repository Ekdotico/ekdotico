// The stored state of a document read into a plain tree, for the Markdown draft export (FR-EX-36).
//
// WHAT IS READ IS HOSTILE. The collaboration server holds a document to its size, its depth and a few shapes
// (src/lib/collab/state.ts, shape.ts) and reads no attribute of it, so every attribute of every node and mark is
// whatever a client sent. The editor holds each to a rule where it makes a node (`ATTRIBUTE_RULES` of
// src/app/(app)/documents/[id]/extensions.tsx, which this module cannot import: it is a client module). Each rule
// is applied again here, in the same words where the editor's own module can be imported (the address of a link,
// an image's attributes, a footnote's identifier, the languages of a code block) and in a copy where it cannot;
// tests/unit/export-read.test.ts holds the copies to the editor's, value by value. What fails a rule is what the
// editor makes of it: the default, or, for a node it has no type for, nothing. Nothing here throws on the shape of
// a document, and the walk is by function but bounded in depth, which the server's own limit already bounds.
//
// A node the schema does not have, text among blocks, and anything that is not an element or text, are left out:
// the editor leaves them out of what it shows (`closeSchema`).
import * as Y from 'yjs';
import { FRAGMENT_NAME } from '../collab/protocol.ts';
import { MAX_ELEMENT_DEPTH, applyState } from '../collab/state.ts';
import { codeLanguage } from '../editor/code-languages.ts';
import { linkAddress } from '../editor/link.ts';
import { isFootnoteId } from '../footnotes/node.ts';
import { IMAGE_ID, imageAttributeAllowed } from '../images/node.ts';

export type MarkName =
  'bold' | 'italic' | 'strike' | 'code' | 'underline' | 'superscript' | 'subscript' | 'highlight';
export type Mark = { name: MarkName } | { name: 'link'; href: string };

export type Inline =
  | { kind: 'text'; text: string; marks: readonly Mark[] }
  | { kind: 'break' }
  /** A footnote marker; the identifier is null where it holds none that is valid. */
  | { kind: 'note'; id: string | null };

export type Block =
  | { kind: 'paragraph'; content: Inline[] }
  | { kind: 'heading'; level: 1 | 2 | 3; content: Inline[] }
  | { kind: 'code'; language: string | null; text: string }
  | { kind: 'rule' }
  | { kind: 'quote'; children: Block[] }
  | { kind: 'callout'; variant: 'note' | 'warning' | 'tip'; children: Block[] }
  | { kind: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { kind: 'table'; rows: Row[]; caption: string }
  | { kind: 'image'; id: string | null; alt: string; caption: string };

export interface Cell {
  header: boolean;
  colspan: number;
  rowspan: number;
  children: Block[];
}
export type Row = Cell[];

export interface ReadDocument {
  /** Every block of the document but the lists of footnote entries, in order. */
  body: Block[];
  /** The words of each footnote entry, by identifier: the first entry of an identifier in the document. */
  entries: Map<string, Inline[]>;
}

/** The marks in the order they are nested, outermost first; a link is outside, and code is inside everything. */
const MARK_ORDER: readonly (MarkName | 'link')[] = [
  'link',
  'bold',
  'italic',
  'strike',
  'underline',
  'superscript',
  'subscript',
  'highlight',
  'code',
];

// The bounds of src/app/(app)/documents/[id]/extensions.tsx (`SPAN_MOST`, `START_MOST`, `TABLE_MOST` of table-bounds.ts).
const SPAN_MOST = 100;
const START_MOST = 9999;
const COLUMNS_MOST = 100;
const CALLOUTS: readonly unknown[] = ['note', 'warning', 'tip'];

/** A whole number from `least` to `most`, or `otherwise`. A number written as text is not one. */
const whole = (given: unknown, least: number, most: number, otherwise: number): number =>
  typeof given === 'number' && Number.isInteger(given) && given >= least && given <= most ? given : otherwise;

/** A Yjs value is an element, told by what it carries and not by its class, as the editor tells it. */
const isElement = (value: unknown): value is Y.XmlElement =>
  typeof (value as { nodeName?: unknown } | null)?.nodeName === 'string';
const isText = (value: unknown): value is Y.XmlText =>
  !isElement(value) && typeof (value as { toDelta?: unknown } | null)?.toDelta === 'function';

/** `link--Xa9fQw+/` is the mark `link`: the binding adds a hash to the name of a mark that can overlap itself. */
const markNameOf = (key: string) => /^(.*)--[a-zA-Z0-9+/=]{8}$/u.exec(key)?.[1] ?? key;

function marksOf(attributes: unknown): Mark[] {
  if (typeof attributes !== 'object' || attributes === null) return [];
  const found = new Map<string, Mark>();
  for (const [key, value] of Object.entries(attributes)) {
    const name = markNameOf(key);
    if (!MARK_ORDER.includes(name as MarkName) || found.has(name)) continue;
    if (name === 'link') {
      const href: unknown =
        typeof value === 'object' && value !== null ? (value as { href?: unknown }).href : null;
      const address = linkAddress(href);
      // A link whose address the editor refuses is no link: the text stays.
      if (address !== null) found.set(name, { name: 'link', href: address });
    } else {
      found.set(name, { name: name as MarkName });
    }
  }
  return MARK_ORDER.flatMap((name) => found.get(name) ?? []);
}

/** The pieces of text of a run, each with its marks. Embedded values are not text and are left out. */
function textOf(run: Y.XmlText): Inline[] {
  const out: Inline[] = [];
  for (const op of run.toDelta() as { insert?: unknown; attributes?: unknown }[]) {
    if (typeof op.insert === 'string' && op.insert !== '') {
      out.push({ kind: 'text', text: op.insert, marks: marksOf(op.attributes) });
    }
  }
  return out;
}

/** The inline content of an element: runs of text, line breaks and markers of footnotes; whatever else stands there is left out. */
function inlineOf(parent: Y.XmlFragment): Inline[] {
  const out: Inline[] = [];
  for (const child of parent.toArray()) {
    if (isText(child)) out.push(...textOf(child));
    else if (isElement(child) && child.nodeName === 'hardBreak') out.push({ kind: 'break' });
    else if (isElement(child) && child.nodeName === 'footnoteReference') {
      const id: unknown = child.getAttribute('id');
      out.push({ kind: 'note', id: isFootnoteId(id) ? id : null });
    }
  }
  return out;
}

/** The text of the runs of an element and nothing else: a code block's code, a caption. Marks are not looked at. */
function plainOf(parent: Y.XmlFragment): string {
  let out = '';
  for (const child of parent.toArray())
    if (isText(child)) for (const part of textOf(child)) if (part.kind === 'text') out += part.text;
  return out;
}

const attribute = (element: Y.XmlElement, name: string): unknown => element.getAttribute(name);

function imageOf(element: Y.XmlElement): Block {
  const id = attribute(element, 'id');
  const alt = attribute(element, 'alt');
  const caption = attribute(element, 'caption');
  return {
    kind: 'image',
    id: typeof id === 'string' && imageAttributeAllowed('id', id) ? id : null,
    alt: typeof alt === 'string' && imageAttributeAllowed('alt', alt) ? alt : '',
    caption: typeof caption === 'string' && imageAttributeAllowed('caption', caption) ? caption : '',
  };
}

/** The rows of a table with the spans of its cells held to its grid, as the editor holds them (`closeGrid`). */
function tableOf(table: Y.XmlElement, depth: number, caption: string): Block {
  const rows: Row[] = [];
  for (const row of table.toArray()) {
    if (!isElement(row) || row.nodeName !== 'tableRow') continue;
    const cells: Cell[] = [];
    for (const cell of row.toArray()) {
      if (!isElement(cell) || (cell.nodeName !== 'tableCell' && cell.nodeName !== 'tableHeader')) continue;
      cells.push({
        header: cell.nodeName === 'tableHeader',
        colspan: whole(attribute(cell, 'colspan'), 1, SPAN_MOST, 1),
        rowspan: whole(attribute(cell, 'rowspan'), 1, SPAN_MOST, 1),
        children: blocksOf(cell, depth + 1),
      });
    }
    rows.push(cells);
  }
  // As the editor closes a grid (`closeGrid`): a cell that reaches below the last row spans one row, and where the
  // grid is then wider than the bound every cell spans one row and one column.
  rows.forEach((cells, at) => {
    for (const cell of cells) if (cell.rowspan > rows.length - at) cell.rowspan = 1;
  });
  if (widest(rows) > COLUMNS_MOST) {
    for (const cells of rows) for (const cell of cells) Object.assign(cell, { colspan: 1, rowspan: 1 });
  }
  return { kind: 'table', rows, caption };
}

/** The widest row of a grid, in columns: the columns a row's own cells span, and those of every cell above that reaches down into it. */
function widest(rows: readonly Row[]): number {
  let most = 0;
  // The cells that reach into the row at hand: how many rows further, and how wide.
  let reaching: [further: number, columns: number][] = [];
  for (const cells of rows) {
    let width = reaching.reduce((sum, [, columns]) => sum + columns, 0);
    const next = reaching.flatMap(([further, columns]) =>
      further > 1 ? [[further - 1, columns] as [number, number]] : [],
    );
    for (const cell of cells) {
      width += cell.colspan;
      if (cell.rowspan > 1) next.push([cell.rowspan - 1, cell.colspan]);
    }
    most = Math.max(most, width);
    reaching = next;
  }
  return most;
}

function blockOf(element: Y.XmlElement, depth: number): Block | null {
  switch (element.nodeName) {
    case 'paragraph':
      return { kind: 'paragraph', content: inlineOf(element) };
    case 'heading':
      return {
        kind: 'heading',
        level: whole(attribute(element, 'level'), 1, 3, 1) as 1 | 2 | 3,
        content: inlineOf(element),
      };
    case 'codeBlock': {
      const language = codeLanguage(attribute(element, 'language'));
      return { kind: 'code', language: language === 'plaintext' ? null : language, text: plainOf(element) };
    }
    case 'horizontalRule':
      return { kind: 'rule' };
    case 'blockquote':
      return { kind: 'quote', children: blocksOf(element, depth + 1) };
    case 'callout': {
      const type = attribute(element, 'type');
      return {
        kind: 'callout',
        variant: CALLOUTS.includes(type) ? (type as 'note' | 'warning' | 'tip') : 'note',
        children: blocksOf(element, depth + 1),
      };
    }
    case 'bulletList':
    case 'orderedList': {
      const ordered = element.nodeName === 'orderedList';
      const items: Block[][] = [];
      for (const item of element.toArray()) {
        if (isElement(item) && item.nodeName === 'listItem') items.push(blocksOf(item, depth + 1));
      }
      return {
        kind: 'list',
        ordered,
        start: ordered ? whole(attribute(element, 'start'), 1, START_MOST, 1) : 1,
        items,
      };
    }
    case 'tableBlock': {
      const children = element.toArray();
      const table = children.find(
        (each): each is Y.XmlElement => isElement(each) && each.nodeName === 'table',
      );
      const caption = children.find(
        (each): each is Y.XmlElement => isElement(each) && each.nodeName === 'tableCaption',
      );
      return table ? tableOf(table, depth + 1, caption ? plainOf(caption) : '') : null;
    }
    // A table outside its block, which the editor does not make, is still a table.
    case 'table':
      return tableOf(element, depth + 1, '');
    case 'image':
      return imageOf(element);
    // The table of contents and the page break have no output (FR-EX-36); the rest is not a block of the schema.
    default:
      return null;
  }
}

/** The blocks that stand directly in an element. Text among them, and an element that is no block, is left out. */
function blocksOf(parent: Y.XmlFragment, depth: number): Block[] {
  // The server holds a document to MAX_ELEMENT_DEPTH levels; one past it is not read.
  if (depth > MAX_ELEMENT_DEPTH + 1) return [];
  const out: Block[] = [];
  for (const child of parent.toArray()) {
    if (!isElement(child)) continue;
    const block = blockOf(child, depth);
    if (block) out.push(block);
  }
  return out;
}

/** The entries of the lists of footnotes that stand directly in the document: by identifier, the first of each. */
function entriesOf(root: Y.XmlFragment): Map<string, Inline[]> {
  const entries = new Map<string, Inline[]>();
  for (const list of root.toArray()) {
    if (!isElement(list) || list.nodeName !== 'footnotes') continue;
    for (const entry of list.toArray()) {
      if (!isElement(entry) || entry.nodeName !== 'footnote') continue;
      const id = attribute(entry, 'id');
      if (!isFootnoteId(id) || entries.has(id)) continue;
      // An entry holds text and line breaks; a marker in one is not a footnote of its own and is left out.
      entries.set(
        id,
        inlineOf(entry).filter((each) => each.kind !== 'note'),
      );
    }
  }
  return entries;
}

/** The document in a stored state, which is null where the document has never been stored: then it is empty. */
export function readDocument(state: Uint8Array | null): ReadDocument {
  const document = new Y.Doc();
  try {
    if (state) applyState(document, state);
    const root = document.getXmlFragment(FRAGMENT_NAME);
    return { body: blocksOf(root, 0), entries: entriesOf(root) };
  } finally {
    document.destroy();
  }
}

/** The identifiers of the images the blocks hold, each once, in the order of the document, wherever the blocks stand. */
export function imageIdsOf(blocks: readonly Block[]): string[] {
  const found = new Set<string>();
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.kind === 'image') {
        if (block.id !== null && IMAGE_ID.test(block.id)) found.add(block.id);
      } else if (block.kind === 'quote' || block.kind === 'callout') walk(block.children);
      else if (block.kind === 'list') for (const item of block.items) walk(item);
      else if (block.kind === 'table')
        for (const row of block.rows) for (const cell of row) walk(cell.children);
    }
  };
  walk(blocks);
  return [...found];
}
