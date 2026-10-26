// Footnotes in the editor (FR-ED-05, FR-ED-02; docs/plan/slice-20.md): the
// three nodes, the numbering, the rule that keeps the list of entries what it
// must be, the way from a marker to its entry, and what a copied marker becomes.
//
// A FOOTNOTE IS A MARKER AND AN ENTRY THAT SHARE AN IDENTIFIER. The marker is an
// inline node in the text; the entries are the blocks of one list at the end of
// the document (the owner's decision on Q16 (c), 7 October 2026). Each holds the
// identifier and nothing else (src/lib/footnotes/node.ts); the server holds a
// client to that (src/lib/collab/shape.ts).
//
// THE NUMBER IS STORED NOWHERE. It is the place of a marker among the markers in
// the order of the document, from 1, and the number of an entry is the number of
// its marker. Both are drawn from the text of the editor by a decoration, so two
// clients that hold the same document draw the same numbers whatever order they
// received its changes in, and whatever place an entry stands in.
//
// ONE FUNCTION SAYS WHAT THE LIST MUST HOLD (`applyNotes`): one entry for each
// marker, and none else. What is not wanted is taken out, and what is missing is
// put in, each by a change of its own that touches nothing that stays: an entry
// is never written again to put it in another place, which the binding would
// write as one in the place of the other, with a change that another writer made
// to the place gone to the wrong entry (the register row S20-11).
//
// - After a change THIS writer made, in the same transaction (so in the same
//   step of undo): what is not wanted is taken out, and the entry of each marker
//   that has none is made, empty, at its place in the order of the markers.
// - After a change that arrives from the binding, another client's or an undo:
//   what is not wanted is taken out, and nothing is put in. A deletion that every
//   client makes is the same deletion, so any number of them converge (an entry
//   twice: each deletes the later and keeps the same first). An entry that every
//   client made would be one for each, so a marker that arrives without its
//   entry waits for the next change of this writer, which makes it. The deletions that follow an arriving
//   change are applied in the editor at once and written to the shared document with this writer's next
//   change (the binding applies an arriving change under its own lock), so they join that step of undo, and
//   what is stored, read, or exported by another meanwhile still holds the entry (register row S20-13).
//
// THE MARKUP IS BARE ELEMENTS, which the editor's stylesheet of
// `@ekdotico/domico` draws as a superscript link and a numbered list: the
// package has no class for a footnote (`@ekdotico/domico` 0.32.0; register row
// S20-1), and nothing is improvised here in its place. When it has, the places
// that make the markup are `MARKER_MARKUP`, `markerView`, `LIST_MARKUP`,
// `ENTRY_MARKUP` and the attributes of `numbersOf`, and nothing else changes.
import { Extension, Node, type Editor } from '@tiptap/core';
import { Fragment, Slice, type DOMOutputSpec, type Node as PMNode, type NodeType } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { isFootnoteId, newFootnoteId } from '../../../../lib/footnotes/node.ts';

/** The names of the three nodes. */
export const MARKER = 'footnoteReference';
export const LIST = 'footnotes';
export const ENTRY = 'footnote';

// The owner approves the words with the pull request (docs/plan/slice-20.md, section 7).
/** The name of the region that holds the entries. */
export const FOOTNOTES_NAME = 'Footnotes';
/** The name of a marker, a link: the number is the derived one, and is in the name as it is on the screen (WCAG 2.5.3). */
export const markerName = (number: number) => `Footnote ${number}`;
/** The prompt of an empty entry: generated content, which a screen reader may read (the plan says so, section 7). */
export const ENTRY_PROMPT = 'Footnote text';

/** The anchor of an entry, which a marker links to. */
const anchor = (id: string) => `footnote-${id}`;

// ── What is in a document ───────────────────────────────────────────────────
/**
 * The markers a node holds, in the order of the document: their identifiers, how many hold none that is valid,
 * and how many carry a mark (none may: `marks: ''` of the node keeps a mark off what it holds, but ProseMirror asks
 * the parent when a mark is put across a marker, so bold or a link over a sentence reached the marker).
 */
interface Scan {
  ids: readonly string[];
  bad: number;
  marked: number;
}
const NONE: Scan = { ids: [], bad: 0, marked: 0 };
// A node never changes, and a change keeps every node it does not touch: what was read once is not read
// again at the next key.
const SCANS = new WeakMap<PMNode, Scan>();

/** The markers of a node, itself among them, wherever they stand; the lists of entries are not looked in. */
function scan(node: PMNode): Scan {
  if (node.isText) return NONE;
  if (node.type.name === MARKER) {
    const id: unknown = node.attrs.id;
    const marked = node.marks.length > 0 ? 1 : 0;
    return isFootnoteId(id) ? { ids: [id], bad: 0, marked } : { ids: [], bad: 1, marked };
  }
  if (node.isLeaf || node.type.name === LIST) return NONE;
  let held = SCANS.get(node);
  if (held) return held;
  const ids: string[] = [];
  let bad = 0;
  let marked = 0;
  node.forEach((child) => {
    const inside = scan(child);
    for (const id of inside.ids) ids.push(id);
    bad += inside.bad;
    marked += inside.marked;
  });
  held = ids.length === 0 && bad === 0 && marked === 0 ? NONE : { ids, bad, marked };
  SCANS.set(node, held);
  return held;
}

/** Each marker of the body with its place, its identifier (null where it holds none), and whether it carries a mark, in the order of the document. */
function markersIn(doc: PMNode): { pos: number; id: string | null; marked: boolean }[] {
  const found: { pos: number; id: string | null; marked: boolean }[] = [];
  const walk = (node: PMNode, start: number) => {
    node.forEach((child, offset) => {
      const pos = start + offset;
      if (child.type.name === MARKER) {
        const id: unknown = child.attrs.id;
        found.push({ pos, id: isFootnoteId(id) ? id : null, marked: child.marks.length > 0 });
      } else if (!child.isText && !child.isLeaf && child.type.name !== LIST) {
        const inside = scan(child);
        if (inside.ids.length > 0 || inside.bad > 0 || inside.marked > 0) walk(child, pos + 1);
      }
    });
  };
  walk(doc, 0);
  return found;
}

/** A list of entries among the children of the document, with the place before it. */
interface Listed {
  node: PMNode;
  pos: number;
}

/**
 * Every list of entries of a document, in its order. There is one, at the end, where one writer made it. Two
 * writers who each make the first list, or a writer who adds a block at the end while another makes it, leave
 * two, or a block after one, and the schema tolerates both: nothing a writer wrote is taken out to mend them.
 */
function listsOf(doc: PMNode): Listed[] {
  const found: Listed[] = [];
  doc.forEach((child, offset) => {
    if (child.type.name === LIST) found.push({ node: child, pos: offset });
  });
  return found;
}

/**
 * Where the body of the document ends: the place before its last run of lists, or the end of the document
 * where it does not end in one. The paragraph kept at the end of the document stands here.
 */
export function bodyEnd(doc: PMNode): number {
  let end = doc.content.size;
  for (let at = doc.childCount - 1; at > 0 && doc.child(at).type.name === LIST; at -= 1)
    end -= doc.child(at).nodeSize;
  return end;
}

/** An entry with its place (before it) and the list it stands in. */
interface Placed {
  id: unknown;
  node: PMNode;
  pos: number;
  list: Listed;
}

/** Every entry of every list, in the order of the document. */
function entriesOf(doc: PMNode): Placed[] {
  const found: Placed[] = [];
  for (const list of listsOf(doc)) {
    list.node.forEach((node, offset) =>
      found.push({ id: node.attrs.id, node, pos: list.pos + 1 + offset, list }),
    );
  }
  return found;
}

/** The identifiers of the markers in the order of the document, each once, the first of it standing. */
const orderOf = (doc: PMNode): string[] => [...new Set(scan(doc).ids)];

/** The number of each footnote: the place of its marker among the markers, from 1. */
export function numbering(doc: PMNode): ReadonlyMap<string, number> {
  const numbers = new Map<string, number>();
  for (const id of orderOf(doc)) numbers.set(id, numbers.size + 1);
  return numbers;
}

/** The entry of a footnote, wherever it stands, with its place; the first of it in the document where there are two, or null. */
export function entryOf(doc: PMNode, id: string): { pos: number; node: PMNode } | null {
  const found = entriesOf(doc).find((each) => each.id === id);
  return found ? { pos: found.pos, node: found.node } : null;
}

// What a pasted marker's entry is made with. A marker that is pasted is a new footnote with a new
// identifier (`transformPasted`), and its entry holds the words of the one it was copied from; the words
// wait here, by the new identifier, until the list is made, which takes them.
const PENDING = new Map<string, Fragment>();
// The words of the entries of what was last copied or cut, by the old identifier: a cut takes the entry
// with its marker, and the paste comes after. One tab, in memory, the last `KEPT_MOST`.
const KEPT = new Map<string, Fragment>();
const KEPT_MOST = 50;
const PENDING_MOST = 200;

function remember(map: Map<string, Fragment>, id: string, words: Fragment, most: number) {
  map.delete(id);
  map.set(id, words);
  while (map.size > most) map.delete(map.keys().next().value!);
}

/** What `applyNotes` did. */
interface Applied {
  changed: boolean;
  /** The entries it made, whose words (if any) it took from `PENDING`. */
  made: string[];
}

/**
 * Makes the entries of `tr.doc` what they must be (see the head of this file), in `tr`. The markers that are not
 * wanted go first: one that holds no valid identifier, and one whose identifier an earlier marker holds, each taken
 * out by deletion, so that every client that does it deletes the same; and a mark on a marker is taken off it.
 *
 * NOTHING A WRITER WROTE IS TAKEN OUT TO MEND A STRUCTURE, and a list is never deleted once it is made: an
 * entry that no marker wants goes, and a second entry of one identifier, by deletion of the entry alone, and the
 * list it stood in stays, empty, where it was. Two writers who each made the first list, or one who added a block
 * after the end while another made it, left two lists or a block after one, which the schema takes, and entries
 * are found by their identifier wherever they stand.
 *
 * With `deletionsOnly` it takes out what is not wanted and puts nothing in: no entry made. That is what a client
 * does after a change that arrives from another (the binding's), where doing the same as the other clients all
 * together converges, and making an entry would not: two clients that made the entry of one marker would leave two.
 */
export function applyNotes(tr: Transform, deletionsOnly = false): Applied {
  const applied: Applied = { changed: false, made: [] };
  const { nodes } = tr.doc.type.schema;
  const entryType = nodes[ENTRY] as NodeType | undefined;
  const listType = nodes[LIST] as NodeType | undefined;
  if (!entryType || !listType) return applied;

  // The places below are read from the document as it stands now, and moved through what this function does.
  const first = tr.steps.length;
  const read = scan(tr.doc);
  if (read.bad > 0 || read.marked > 0 || new Set(read.ids).size !== read.ids.length) {
    const seen = new Set<string>();
    const going: number[] = [];
    const bare: number[] = [];
    for (const { pos, id, marked } of markersIn(tr.doc)) {
      if (id === null || seen.has(id)) going.push(pos);
      else {
        seen.add(id);
        if (marked) bare.push(pos);
      }
    }
    // The deletions from the last, so that no place moves before it is used; a mark taken off moves none.
    for (const pos of going.reverse()) tr.delete(pos, pos + 1);
    for (const pos of bare) {
      const at = tr.mapping.slice(first).map(pos);
      tr.removeMark(at, at + 1);
    }
    applied.changed = going.length > 0 || bare.length > 0;
  }

  const wanted = orderOf(tr.doc);

  // 1. TAKE OUT what is not wanted, each entry by deletion and none put in again: an entry of no marker, one that
  // holds no valid identifier, and a second of one identifier (the first in the order of the document stands).
  // Two writers who do this at once delete the same entries, and nothing that stays is touched.
  const isWanted = new Set(wanted);
  const seen = new Set<string>();
  const going: { pos: number; size: number }[] = [];
  for (const entry of entriesOf(tr.doc)) {
    const id = entry.id;
    if (isFootnoteId(id) && isWanted.has(id) && !seen.has(id)) seen.add(id);
    else going.push({ pos: entry.pos, size: entry.node.nodeSize });
  }
  for (const { pos, size } of going.reverse()) tr.delete(pos, pos + size);
  applied.changed ||= going.length > 0;

  if (deletionsOnly) return applied;

  // 2. PUT IN the entry of each marker that has none, empty, at its place in the order of the markers: before the
  // entry of the next marker that has one, or at the end of the last list where the document ends in one, or in a
  // new list at the end. Nothing that stays is touched, and the entries are NEVER WRITTEN AGAIN to put them in
  // the order of the markers: the binding writes a reorder of same-named elements by writing each in the place of
  // the other (its id and its words), so what another writer typed in one in that moment would stand in the
  // other. Entries stand in the order their markers had when they were made, which is the order of the markers
  // unless two writers put theirs in at one place; each entry is drawn with the number of its own marker
  // whatever its place (`numbersOf`), so the number is right and the order of the list, there, can lag
  // (register row S20-11).
  const rank = new Map(wanted.map((id, at) => [id, at]));
  const have = new Set(seen);
  for (const id of wanted) {
    if (have.has(id)) continue;
    applied.made.push(id);
    const entry = entryType.create({ id }, PENDING.get(id) ?? Fragment.empty);
    const next = entriesOf(tr.doc).find((each) => rank.get(each.id as string)! > rank.get(id)!);
    if (next) {
      tr.insert(next.pos, entry);
    } else {
      const last = listsOf(tr.doc).at(-1);
      // The last list, where it ends the document: its end, inside it.
      if (last && last.pos + last.node.nodeSize === tr.doc.content.size) {
        tr.insert(last.pos + last.node.nodeSize - 1, entry);
      } else tr.insert(tr.doc.content.size, listType.create(null, [entry]));
    }
    applied.changed = true;
  }
  return applied;
}

/** The document as `applyNotes` would leave it, for a rule that asks about the document after the entries are made. */
export function withNotes(doc: PMNode): PMNode {
  const tr = new Transform(doc);
  applyNotes(tr);
  return tr.doc;
}

// ── Putting a footnote in ───────────────────────────────────────────────────

/**
 * The change that puts a footnote where `range` stands (the selection where none
 * is given): the marker in place of what the range holds, the entry made, and the
 * cursor at the end of the entry, scrolled into view. Null where a marker cannot
 * stand there: in a code block, a caption, an entry.
 */
export function insertingFootnote(
  state: EditorState,
  range: { from: number; to: number } = state.selection,
  id: string = newFootnoteId(),
): Transaction | null {
  const marker = state.schema.nodes[MARKER];
  if (!marker) return null;
  const $from = state.doc.resolve(range.from);
  if (!$from.parent.canReplaceWith($from.index(), state.doc.resolve(range.to).indexAfter(), marker))
    return null;
  const tr = state.tr.replaceWith(range.from, range.to, marker.create({ id }));
  applyNotes(tr);
  const entry = entryOf(tr.doc, id);
  if (!entry) return null;
  return tr.setSelection(TextSelection.create(tr.doc, entry.pos + entry.node.nodeSize - 1)).scrollIntoView();
}

// ── Reaching an entry from its marker ───────────────────────────────────────

/**
 * The way from a marker to its entry (FR-ED-05, "shall scroll the editor to the
 * corresponding footnote entry"). Where the document can be edited the cursor
 * goes to the end of the entry, and the entry is scrolled to; where it cannot,
 * the entry is scrolled to and takes the focus, so that what it holds is read.
 */
export function followMarker(editor: Editor, id: unknown): boolean {
  if (!isFootnoteId(id)) return false;
  const entry = entryOf(editor.state.doc, id);
  if (!entry) return false;
  if (editor.isEditable) {
    editor
      .chain()
      .setTextSelection(entry.pos + entry.node.nodeSize - 1)
      .focus(undefined, { scrollIntoView: false })
      .run();
  }
  const dom = editor.view.nodeDOM(entry.pos);
  if (dom instanceof HTMLElement) {
    // Without motion of its own: the browser's, which follows the reader's setting.
    dom.scrollIntoView({ block: 'center' });
    if (!editor.isEditable) dom.focus({ preventScroll: true });
  }
  return true;
}

// ── The nodes ───────────────────────────────────────────────────────────────

/** The markup of a marker, which the view draws; this is what a clipboard and `getHTML` carry: the identifier, no link. */
const MARKER_MARKUP = (id: unknown): DOMOutputSpec => [
  'sup',
  { 'data-footnote-id': isFootnoteId(id) ? id : '' },
];

/**
 * The marker's own view: a superscript link, named by its number (`numbersOf` hands the number in a decoration).
 *
 * THE LINK IS A STOP OF TAB, in the text as well as where the document cannot be edited. An arrow key does not
 * select an inline node (ProseMirror moves the cursor over it), so the way to a marker's entry from the keyboard
 * is the link's own: Tab from the text reaches the markers in the order of the document, from the first and not
 * from the caret (register row S20-12), and Enter follows the one that has the focus.
 * The keys pressed on the link are the link's and not the editor's, which would otherwise answer Enter by
 * splitting the paragraph at the cursor (`stopEvent`).
 */
export function markerView({
  node,
  editor,
  decorations = [],
}: {
  node: PMNode;
  editor: Editor;
  decorations?: readonly Decoration[];
}) {
  let id: unknown = node.attrs.id;
  const dom = document.createElement('sup');
  const link = document.createElement('a');
  link.setAttribute('role', 'doc-noteref');
  // Said, and not left to the element: a link inside an editable region is not always a stop of Tab.
  link.tabIndex = 0;
  dom.append(link);
  link.addEventListener('click', (event) => {
    event.preventDefault();
    followMarker(editor, id);
  });
  const draw = (given: PMNode, decorations: readonly Decoration[]) => {
    id = given.attrs.id;
    const spec = decorations.map((each) => each.spec as { footnoteNumber?: number });
    const number = spec.find((each) => typeof each.footnoteNumber === 'number')?.footnoteNumber;
    // A marker with no valid identifier, which nothing links to, is not shown: it is taken out at the next change.
    dom.hidden = number === undefined || !isFootnoteId(id);
    if (dom.hidden) return;
    link.href = `#${anchor(id as string)}`;
    link.textContent = String(number);
    link.setAttribute('aria-label', markerName(number!));
  };
  draw(node, decorations);
  return {
    dom,
    update(updated: PMNode, decorations: readonly Decoration[]) {
      if (updated.type !== node.type) return false;
      draw(updated, decorations);
      return true;
    },
    // The keys of a link that has the focus are the browser's.
    stopEvent: (event: Event) =>
      event.type === 'keydown' || event.type === 'keyup' || event.type === 'keypress',
    ignoreMutation: () => true,
  };
}

const FootnoteReference = Node.create({
  name: MARKER,
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  // A marker is no text: no mark is put on it, and a link mark could not be put round the link it is.
  marks: '',
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-footnote-id'),
      },
    };
  },
  // Before the superscript mark's own rule for `sup`.
  parseHTML() {
    return [{ tag: 'sup[data-footnote-id]', priority: 1000 }];
  },
  renderHTML({ node }) {
    return MARKER_MARKUP(node.attrs.id);
  },
  addNodeView() {
    return markerView;
  },
});

/** The markup of the list of entries: a region that is named, round the list the entries stand in. */
const LIST_MARKUP: DOMOutputSpec = [
  'section',
  { role: 'doc-endnotes', 'aria-label': FOOTNOTES_NAME },
  ['ol', 0],
];

const FootnoteList = Node.create({
  name: LIST,
  // It may stand empty, and is never deleted once made: a writer who adds an entry to it while another takes the
  // last entry out would otherwise lose the new one with the list. It is not drawn while it is empty (`numbersOf`).
  content: 'footnote*',
  // Nothing is put across its edge: a block is not put in it and it is put in no block. It is made by
  // `applyNotes`, and is never parsed from HTML: a pasted list is an ordinary one.
  isolating: true,
  renderHTML() {
    return LIST_MARKUP;
  },
});

/** The markup of an entry: a list item that its marker links to. */
const ENTRY_MARKUP = (id: unknown): DOMOutputSpec => ['li', isFootnoteId(id) ? { id: anchor(id) } : {}, 0];

const FootnoteEntry = Node.create({
  name: ENTRY,
  // FR-ED-02: the nine marks, as a paragraph takes them. Text and a line break, and no marker.
  content: '(text | hardBreak)*',
  // Backspace at its start does not join it to the entry before.
  isolating: true,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-footnote-id'),
      },
    };
  },
  renderHTML({ node }) {
    return ENTRY_MARKUP(node.attrs.id);
  },
});

/** The document: the blocks, and after them the list of footnotes where there is one (FR-ED-05). */
export const FootnoteDocument = Node.create({
  name: 'doc',
  topNode: true,
  content: 'block+ (footnotes | block)*',
});

// ── The behaviour ───────────────────────────────────────────────────────────

const NUMBERS = new PluginKey('footnoteNumbers');

/** The decorations of a document: the number of each marker, and of each entry. One result is kept, for the one document. */
let LAST: { doc: PMNode; editable: boolean; set: DecorationSet } | null = null;
function numbersOf(doc: PMNode, editable: boolean): DecorationSet {
  if (LAST?.doc === doc && LAST.editable === editable) return LAST.set;
  const lists = listsOf(doc);
  let set = DecorationSet.empty;
  if (scan(doc).ids.length > 0 || lists.length > 0) {
    const numbers = numbering(doc);
    const found: Decoration[] = [];
    for (const { pos, id } of markersIn(doc)) {
      if (id) found.push(Decoration.node(pos, pos + 1, {}, { footnoteNumber: numbers.get(id) }));
    }
    for (const list of lists) {
      // A list with no entry is not drawn: no empty region is read, and none stands between the text and its end.
      if (list.node.childCount === 0)
        found.push(Decoration.node(list.pos, list.pos + list.node.nodeSize, { hidden: 'hidden' }));
    }
    for (const entry of entriesOf(doc)) {
      const number = isFootnoteId(entry.id) ? numbers.get(entry.id) : undefined;
      const attributes: Record<string, string> = {};
      // `value` is the ordinal of a list item, whatever its place in the list.
      if (number !== undefined) attributes.value = String(number);
      // An entry is focused when a marker leads to it in a document that cannot be edited.
      if (!editable) attributes.tabindex = '-1';
      found.push(Decoration.node(entry.pos, entry.pos + entry.node.nodeSize, attributes));
    }
    set = DecorationSet.create(doc, found);
  }
  LAST = { doc, editable, set };
  return set;
}

/**
 * What a slice holds, as the text and line breaks of an entry: the words of each block in the order of the slice,
 * a line break between one block and the next. A marker, an image and every other node that is no text is left out.
 */
function inlineOnly(slice: Slice): Slice {
  const out: PMNode[] = [];
  const lineBreak = slice.content.firstChild?.type.schema.nodes.hardBreak;
  let blocks = 0;
  slice.content.descendants((node) => {
    if (node.isTextblock) {
      if (blocks > 0 && lineBreak) out.push(lineBreak.create());
      blocks += 1;
      node.forEach((child) => {
        if (child.isText || child.type.name === 'hardBreak') out.push(child);
      });
      return false;
    }
    if (node.isText) out.push(node);
    return true;
  });
  return new Slice(Fragment.fromArray(out), 0, 0);
}

/** The entries' words in what a slice holds a marker of, by the identifier the marker holds. */
function wordsFor(slice: { content: Fragment }, view: EditorView, from: Map<string, Fragment>) {
  slice.content.descendants((node) => {
    if (node.type.name !== MARKER) return;
    const id: unknown = node.attrs.id;
    if (isFootnoteId(id)) {
      const entry = entryOf(view.state.doc, id);
      if (entry) remember(from, id, entry.node.content, KEPT_MOST);
    }
  });
}

/**
 * Whether a transaction is a change this writer made, and not what arrives or an
 * undo (the binding's), nor what a plugin appended to one of those.
 */
const own = (transactions: readonly Transaction[]) =>
  transactions.some(
    (each) =>
      each.docChanged && !each.getMeta(ySyncPluginKey) && each.getMeta('appendedTransaction') === undefined,
  );

/**
 * A line break where the cursor is in an entry, in place of what is selected, and never a second entry,
 * which would hold the same identifier. False where the cursor is not in an entry: the key is then
 * another's.
 */
export function lineBreakInEntry(editor: Editor): boolean {
  const { state } = editor;
  const lineBreak = state.schema.nodes.hardBreak;
  if (!lineBreak || state.selection.$from.parent.type.name !== ENTRY) return false;
  editor.view.dispatch(state.tr.replaceSelectionWith(lineBreak.create()).scrollIntoView());
  return true;
}

/** Whether a transaction is a change that arrives from the binding: another client's, or an undo. */
const arrived = (transactions: readonly Transaction[]) =>
  transactions.some((each) => each.docChanged && each.getMeta(ySyncPluginKey));

export const Footnotes = Extension.create({
  // Not `footnotes`, which is the name of the node that holds the list.
  name: 'footnoteBehaviour',
  addExtensions() {
    return [FootnoteDocument, FootnoteReference, FootnoteList, FootnoteEntry];
  },
  // The words kept from a copy or a cut, and those waiting for an entry, are of this document and of this
  // editor's schema: a page that opens another document in the same tab starts with none (S20-4).
  onDestroy() {
    KEPT.clear();
    PENDING.clear();
  },
  addKeyboardShortcuts() {
    return {
      // In an entry: a line break, and never a second entry, which would hold the same identifier.
      Enter: () => this.editor.isEditable && lineBreakInEntry(this.editor),
      // The library's own key for a line break does nothing in an entry, which is isolating (its command
      // refuses an isolating block), and the entry takes a line break all the same.
      'Shift-Enter': () => this.editor.isEditable && lineBreakInEntry(this.editor),
    };
  },
  addProseMirrorPlugins() {
    const { editor } = this;
    return [
      new Plugin({
        key: NUMBERS,
        props: {
          decorations: (state) => numbersOf(state.doc, editor.isEditable),
          // A copied marker pastes as a new footnote with a new identifier and the words of its entry.
          transformCopied(slice, view) {
            wordsFor(slice, view, KEPT);
            return slice;
          },
          transformPasted(slice, view) {
            const marker = view.state.schema.nodes[MARKER];
            if (!marker) return slice;
            // Into an entry, what is pasted is its words and line breaks and nothing else: a block that the
            // entry cannot hold would otherwise close the entry and the list and stand after it, where the
            // schema now takes a block (S20-5).
            if (view.state.selection.$from.parent.type.name === ENTRY) return inlineOnly(slice);
            try {
              // Most pastes hold no marker, and are handed back as they are, whatever their size.
              let holds = false;
              slice.content.descendants((node) => {
                if (node.type.name === MARKER) holds = true;
                return !holds;
              });
              if (!holds) return slice;
              const swap = (fragment: Fragment): Fragment => {
                const out: PMNode[] = [];
                fragment.forEach((node) => {
                  if (node.type.name === MARKER) {
                    const old: unknown = node.attrs.id;
                    const id = newFootnoteId();
                    const words = isFootnoteId(old)
                      ? (entryOf(view.state.doc, old)?.node.content ?? KEPT.get(old))
                      : undefined;
                    if (words) remember(PENDING, id, words, PENDING_MOST);
                    out.push(marker.create({ id }));
                  } else out.push(node.isLeaf ? node : node.copy(swap(node.content)));
                });
                return Fragment.fromArray(out);
              };
              return new Slice(swap(slice.content), slice.openStart, slice.openEnd);
            } catch {
              // Content nested past what the stack takes is the editor's to refuse (`holdBinding`, the limits),
              // and is not made a fault of the paste here: its markers stand as they were, and a marker whose
              // identifier an earlier one holds is taken out at the next change.
              return slice;
            }
          },
        },
        // After a change this writer made: the list is what it must be, in the same step of undo. After a
        // change that arrives, or an undo: what is not wanted is taken out, which every client does alike.
        appendTransaction: (transactions, _before, state) => {
          if (!editor.isEditable) return null;
          const local = own(transactions);
          if (!local && !arrived(transactions)) return null;
          const tr = state.tr;
          const { changed, made } = applyNotes(tr, !local);
          if (!changed) return null;
          for (const id of made) PENDING.delete(id);
          return tr;
        },
      }),
    ];
  },
});

/**
 * The paragraph that the starter kit keeps at the end of a document that does not end in one, so that the
 * cursor has a place after a table, goes before the list of footnotes where there is one: the kit's own is
 * turned off (./extensions.tsx) and this takes its place, **in the same place of the order of the editor's
 * extensions**, which is before the table's. The order is the order in which the plugins answer a change, and
 * a table that stands last in a document past a limit is mended differently if this answers after the table's
 * own repair: the repair was refused, and its refusal said aloud (tests/e2e/editor.spec.ts, "a table block
 * emptied by a client at 100 tables").
 */
export const TrailingParagraph = Extension.create({
  name: 'trailingParagraph',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction: (transactions, _before, state) => {
          if (!transactions.some((each) => each.docChanged)) return null;
          if (transactions.some((each) => each.getMeta('skipTrailingNode'))) return null;
          const { doc, schema } = state;
          const paragraph = schema.nodes.paragraph!;
          // The last block of the body: the one before the last run of lists, which is the last child where the
          // document ends in none.
          const end = bodyEnd(doc);
          const body = doc.resolve(end).nodeBefore;
          if (!body || body.type === paragraph) return null;
          return state.tr.insert(end, paragraph.create());
        },
      }),
    ];
  },
});
