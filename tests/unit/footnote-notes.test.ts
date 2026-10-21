// Footnotes in the editor (FR-ED-05, FR-ED-02, FR-ED-12; docs/plan/slice-20.md): the
// numbering, the list of entries that is what the markers say it is, what a copied
// marker becomes, the palette's row, and the limits. The editor here is the page's own
// schema and extensions with no page to stand in; the collaboration of two writers is
// tests/unit/footnote-collab.test.ts, and the keys and the view are
// tests/e2e/footnotes.spec.ts, where there is a browser.
import { Editor, type JSONContent } from '@tiptap/core';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { countsOf, limitRefusal } from '../../src/app/(app)/documents/[id]/block-limits.ts';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  ENTRY,
  LIST,
  MARKER,
  applyNotes,
  entryOf,
  insertingFootnote,
  numbering,
  lineBreakInEntry,
} from '../../src/app/(app)/documents/[id]/footnotes.ts';
import { chooseSlashCommand, slashPalette } from '../../src/app/(app)/documents/[id]/slash-palette.tsx';
import { LIMITS } from '../../src/lib/collab/shape.ts';

type Json = JSONContent;
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);
const D = 'd'.repeat(24);
const text = (words: string, ...marks: string[]): Json => ({
  type: 'text',
  text: words,
  ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}),
});
const p = (...content: Json[]): Json => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const marker = (id: string): Json => ({ type: MARKER, attrs: { id } });
const entry = (id: string, ...content: Json[]): Json => ({
  type: ENTRY,
  attrs: { id },
  ...(content.length ? { content } : {}),
});
const list = (...entries: Json[]): Json => ({ type: LIST, content: entries });

function editorOf(...content: Json[]) {
  const made = new Editor({
    element: null,
    content: { type: 'doc', content },
    extensions: extensions(new Y.Doc()),
  });
  made.view.updateState(made.state.reconfigure({ plugins: made.extensionManager.plugins }));
  made.commands.setTextSelection(1);
  return made;
}

/** The document as plain data: a marker is `[id]`, an entry `<id: words>`, the list `{…}`. */
function shape(node: PMNode): string {
  if (node.isText) return node.text!;
  if (node.type.name === 'hardBreak') return '⏎';
  if (node.type.name === MARKER) return `[${String(node.attrs.id).slice(0, 1)}]`;
  const inside = node.children.map(shape).join(node.type.name === LIST ? ' ' : '');
  if (node.type.name === ENTRY) return `<${String(node.attrs.id).slice(0, 1)}: ${inside}>`;
  if (node.type.name === LIST) return `{${inside}}`;
  if (node.type.name === 'doc') return node.children.map(shape).join(' | ');
  return inside;
}
const now = (editor: Editor) => shape(editor.state.doc);

/** A change of this writer's own, as a key or a command makes it. */
const dispatch = (editor: Editor, make: (tr: Transaction) => Transaction) =>
  editor.view.dispatch(make(editor.state.tr));
/** What the binding does with a change of another client: the whole document in one step, with its mark. */
function peer(editor: Editor, content: Json[]) {
  const next = editor.schema.nodeFromJSON({ type: 'doc', content });
  const tr = editor.state.tr.replace(0, editor.state.doc.content.size, new Slice(next.content, 0, 0));
  editor.view.dispatch(tr.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false }));
}

/** The position of the first node of a type. */
function at(editor: Editor, type: string, nth = 0): number {
  let found = -1;
  let seen = 0;
  editor.state.doc.descendants((node, pos) => {
    if (found < 0 && node.type.name === type && seen++ === nth) found = pos;
    return found < 0;
  });
  return found;
}
/** Types words into the entry of a footnote. */
function say(editor: Editor, id: string, words: string) {
  const held = entryOf(editor.state.doc, id)!;
  dispatch(editor, (tr) => tr.insertText(words, held.pos + held.node.nodeSize - 1));
}

const plugin = (editor: Editor) =>
  editor.state.plugins.find((each) =>
    (each as unknown as { key: string }).key.startsWith('footnoteNumbers$'),
  )!;
/** The numbers the editor draws: for each marker and each entry, in the order of the document. */
function drawn(editor: Editor) {
  const set = plugin(editor).props.decorations!.call(plugin(editor), editor.state)!;
  return (
    set as unknown as {
      find(): { from: number; spec: { footnoteNumber?: number }; type: { attrs: Record<string, string> } }[];
    }
  )
    .find()
    .map((each) => ({
      at: editor.state.doc.nodeAt(each.from)!.type.name,
      number: each.spec.footnoteNumber,
      value: each.type.attrs.value,
      tabindex: each.type.attrs.tabindex,
    }));
}

describe('a footnote is put in (FR-ED-05, FR-ED-12)', () => {
  it('makes the marker where the cursor is, and its entry at the end, and puts the cursor in the entry', () => {
    const editor = editorOf(p(text('Before after')), p(text('Next')));
    editor.commands.setTextSelection(8);
    const tr = insertingFootnote(editor.state, undefined, A)!;
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr);
    expect(now(editor)).toBe('Before [a]after | Next | {<a: >}');
    const { $from, empty } = editor.state.selection;
    expect(empty).toBe(true);
    expect($from.parent.type.name).toBe(ENTRY);
    expect($from.parent.attrs.id).toBe(A);
    editor.state.doc.check();
  });

  it('makes one change, which is one step of the document and nothing more is appended', () => {
    const editor = editorOf(p(text('One')));
    editor.commands.setTextSelection(3);
    const before = editor.state.doc;
    const seen: Transaction[] = [];
    const { state } = editor.view;
    const applied = state.applyTransaction(insertingFootnote(state, undefined, A)!);
    seen.push(...applied.transactions);
    // The root and no appended one: the entry was made with the marker.
    expect(seen).toHaveLength(1);
    expect(shape(applied.state.doc)).toBe('On[a]e | {<a: >}');
    expect(shape(before)).toBe('One');
  });

  it('numbers from 1 in the order of the markers, and writes the number nowhere in the document', () => {
    const editor = editorOf(
      p(text('x'), marker(B)),
      p(marker(A), marker(C)),
      list(entry(A), entry(B), entry(C)),
    );
    expect([...numbering(editor.state.doc)]).toEqual([
      [B, 1],
      [A, 2],
      [C, 3],
    ]);
    expect(JSON.stringify(editor.getJSON())).not.toMatch(/"number"|"value"/);
  });

  it('draws the number of each marker, and of each entry as the ordinal of its list item', () => {
    // Stored out of order, as two writers can leave it: each entry still shows its own number.
    const editor = editorOf(p(marker(B), marker(A)), list(entry(A), entry(B)));
    expect(drawn(editor)).toEqual([
      { at: MARKER, number: 1, value: undefined, tabindex: undefined },
      { at: MARKER, number: 2, value: undefined, tabindex: undefined },
      { at: ENTRY, number: undefined, value: '2', tabindex: undefined },
      { at: ENTRY, number: undefined, value: '1', tabindex: undefined },
    ]);
  });

  it('makes an entry focusable only where the document cannot be edited, which is where a marker leads to it', () => {
    const editor = editorOf(p(marker(A)), list(entry(A)));
    editor.setEditable(false);
    const entries = drawn(editor).filter((each) => each.at === ENTRY);
    expect(entries).toEqual([{ at: ENTRY, number: undefined, value: '1', tabindex: '-1' }]);
    editor.setEditable(true);
    expect(drawn(editor).filter((each) => each.at === ENTRY)[0]!.tabindex).toBeUndefined();
  });

  it('is put in a marker at a time: before the first, between, and after, the list following the markers', () => {
    const editor = editorOf(p(text('one two three')));
    editor.commands.setTextSelection(14);
    editor.view.dispatch(insertingFootnote(editor.state, undefined, A)!);
    editor.commands.setTextSelection(1);
    editor.view.dispatch(insertingFootnote(editor.state, undefined, B)!);
    editor.commands.setTextSelection(6);
    editor.view.dispatch(insertingFootnote(editor.state, undefined, C)!);
    expect(now(editor)).toBe('[b]one [c]two three[a] | {<b: > <c: > <a: >}');
    expect([...numbering(editor.state.doc).keys()]).toEqual([B, C, A]);
  });

  it('keeps the words of an entry when a footnote is put in before it', () => {
    const editor = editorOf(p(text('one two')));
    editor.commands.setTextSelection(8);
    editor.view.dispatch(insertingFootnote(editor.state, undefined, A)!);
    say(editor, A, 'First words');
    const held = entryOf(editor.state.doc, A)!.node;
    editor.commands.setTextSelection(1);
    editor.view.dispatch(insertingFootnote(editor.state, undefined, B)!);
    expect(now(editor)).toBe('[b]one two[a] | {<b: > <a: First words>}');
    // The very node, not a copy of it.
    expect(entryOf(editor.state.doc, A)!.node).toBe(held);
  });

  it('is not put where a marker cannot stand: in a code block, a table caption, or an entry', () => {
    const code = editorOf({ type: 'codeBlock', attrs: { language: 'plaintext' }, content: [text('x')] });
    code.commands.setTextSelection(2);
    expect(insertingFootnote(code.state)).toBeNull();
    const table = editorOf({
      type: 'tableBlock',
      content: [
        { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p()] }] }] },
        { type: 'tableCaption', content: [text('Caption')] },
      ],
    });
    table.commands.setTextSelection(at(table, 'tableCaption') + 2);
    expect(insertingFootnote(table.state)).toBeNull();
    const inEntry = editorOf(p(marker(A)), list(entry(A, text('words'))));
    inEntry.commands.setTextSelection(entryOf(inEntry.state.doc, A)!.pos + 2);
    expect(insertingFootnote(inEntry.state)).toBeNull();
  });

  it('stands in a heading, a cell, a quote, a callout and a list item, as a paragraph does', () => {
    for (const block of [
      { type: 'heading', attrs: { level: 2 }, content: [text('H')] },
      { type: 'blockquote', content: [p(text('Q'))] },
      { type: 'callout', attrs: { type: 'note' }, content: [p(text('C'))] },
      { type: 'bulletList', content: [{ type: 'listItem', content: [p(text('L'))] }] },
      {
        type: 'tableBlock',
        content: [
          {
            type: 'table',
            content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p(text('T'))] }] }],
          },
          { type: 'tableCaption' },
        ],
      },
    ] as Json[]) {
      const editor = editorOf(block);
      editor.commands.setTextSelection(at(editor, 'paragraph') >= 0 ? at(editor, 'paragraph') + 2 : 2);
      const tr = insertingFootnote(editor.state, undefined, A);
      expect(tr, block.type).not.toBeNull();
      editor.view.dispatch(tr!);
      expect(editor.state.doc.lastChild!.type.name, block.type).toBe(LIST);
      editor.state.doc.check();
    }
  });
});

describe('the list is what the markers say it is (FR-ED-05: inserted, deleted, reordered)', () => {
  const base = () =>
    editorOf(
      p(marker(A), text(' one ')),
      p(marker(B), text(' two')),
      list(entry(A, text('Aa')), entry(B, text('Bb'))),
    );

  it('takes an entry out with its marker, and the list with the last of them', () => {
    const editor = base();
    dispatch(editor, (tr) => tr.delete(at(editor, MARKER), at(editor, MARKER) + 1));
    expect(now(editor)).toBe(' one  | [b] two | {<b: Bb>}');
    dispatch(editor, (tr) => tr.delete(at(editor, MARKER), at(editor, MARKER) + 1));
    expect(now(editor)).toBe(' one  |  two');
    editor.state.doc.check();
  });

  it('takes an entry out where the text that holds its marker is deleted', () => {
    const editor = base();
    // The whole of the second paragraph.
    const from = at(editor, 'paragraph', 1);
    dispatch(editor, (tr) => tr.delete(from, from + editor.state.doc.child(1).nodeSize));
    expect(now(editor)).toBe('[a] one  | {<a: Aa>}');
  });

  it('renumbers where text that holds a marker is moved, and writes no entry again to do it', () => {
    const editor = base();
    const entries = [...editor.state.doc.lastChild!.children];
    const second = editor.state.doc.child(1);
    const from = editor.state.doc.child(0).nodeSize;
    dispatch(editor, (tr) => tr.delete(from, from + second.nodeSize).insert(0, second));
    // The markers moved and their entries did not: the numbers are those of the markers, whatever the list's order.
    expect(now(editor)).toBe('[b] two | [a] one  | {<a: Aa> <b: Bb>}');
    expect([...numbering(editor.state.doc).keys()]).toEqual([B, A]);
    expect([...editor.state.doc.lastChild!.children]).toEqual(entries);
    // Each entry is drawn with the number of its own marker, so the list reads 2 and then 1 and is not wrong.
    expect(
      drawn(editor)
        .filter((each) => each.at === ENTRY)
        .map((each) => each.value),
    ).toEqual(['2', '1']);
    editor.state.doc.check();
  });

  it('puts an entry in at its place and takes another out in one change, and leaves those between as they were', () => {
    const editor = editorOf(
      p(marker(A), marker(B), marker(C)),
      list(entry(A, text('Aa')), entry(B, text('Bb')), entry(C, text('Cc'))),
    );
    const [, b, c] = [...editor.state.doc.lastChild!.children];
    dispatch(editor, (tr) =>
      tr
        .delete(1, 2)
        .insert(tr.doc.child(0).nodeSize - 1, tr.doc.type.schema.nodes[MARKER]!.create({ id: D })),
    );
    expect(now(editor)).toBe('[b][c][d] | {<b: Bb> <c: Cc> <d: >}');
    expect(entryOf(editor.state.doc, B)!.node).toBe(b);
    expect(entryOf(editor.state.doc, C)!.node).toBe(c);
  });

  it('puts back the entries that the writer deleted, empty: to remove a footnote is to remove its marker', () => {
    const editor = base();
    const listAt = editor.state.doc.content.size - editor.state.doc.lastChild!.nodeSize;
    // Everything in the list, which leaves what the schema requires of it.
    dispatch(editor, (tr) => tr.delete(listAt + 1, tr.doc.content.size - 1));
    expect(now(editor)).toBe('[a] one  | [b] two | {<a: > <b: >}');
    editor.state.doc.check();
  });

  it('puts back one entry that is deleted, empty, beside the one that stays', () => {
    const editor = base();
    const first = entryOf(editor.state.doc, A)!;
    dispatch(editor, (tr) => tr.delete(first.pos, first.pos + first.node.nodeSize));
    expect(now(editor)).toBe('[a] one  | [b] two | {<a: > <b: Bb>}');
  });

  it('changes nothing else where words are typed in an entry', () => {
    const editor = base();
    const entries = [...entryOf(editor.state.doc, B)!.node.children];
    say(editor, A, '!');
    expect(now(editor)).toBe('[a] one  | [b] two | {<a: Aa!> <b: Bb>}');
    expect(entryOf(editor.state.doc, B)!.node.children).toEqual(entries);
    // Each of the two entries is the node it was, apart from the one that was typed in.
    expect(entryOf(editor.state.doc, B)!.node).toBe(entryOf(editor.state.doc, B)!.node);
  });

  it('holds the nine marks in an entry (FR-ED-02)', () => {
    const marks = ['bold', 'italic', 'underline', 'strike', 'code', 'superscript', 'subscript', 'highlight'];
    const editor = editorOf(
      p(marker(A)),
      list(
        entry(A, ...marks.map((mark) => text(mark, mark)), {
          type: 'text',
          text: 'link',
          marks: [{ type: 'link', attrs: { href: 'https://example.org' } }],
        }),
      ),
    );
    const held = entryOf(editor.state.doc, A)!.node;
    expect(held.children.flatMap((child) => child.marks.map((mark) => mark.type.name)).sort()).toEqual(
      [...marks, 'link'].sort(),
    );
  });

  it('keeps no footnote that nothing links to: an entry with no marker goes at the next change', () => {
    const editor = editorOf(p(text('words')), list(entry(A, text('orphan'))));
    expect(now(editor)).toBe('words | {<a: orphan>}');
    dispatch(editor, (tr) => tr.insertText('!', 6));
    expect(now(editor)).toBe('words!');
  });

  it('makes the entry of a marker that has none, empty, at the next change', () => {
    const editor = editorOf(p(marker(A), text('words')));
    expect(now(editor)).toBe('[a]words');
    dispatch(editor, (tr) => tr.insertText('!', 3));
    expect(now(editor)).toBe('[a]w!ords | {<a: >}');
  });

  it('takes out a marker that holds an identifier an earlier marker holds, and one that holds none', () => {
    const editor = editorOf(
      p(marker(A), text(' x '), marker(A), text(' y '), marker('zz')),
      list(entry(A, text('Aa'))),
    );
    // The attribute rule of the schema turned the last one's identifier into null.
    expect(now(editor)).toBe('[a] x [a] y [?] | {<a: Aa>}'.replace('[?]', '[n]'));
    dispatch(editor, (tr) => tr.insertText('.', 1));
    expect(now(editor)).toBe('.[a] x  y  | {<a: Aa>}');
  });

  it('has the list at the end only, once, after the blocks: no other order is a document', () => {
    const { schema } = editorOf(p());
    const para = schema.nodes.paragraph!.create();
    const notes = schema.nodes[LIST]!.create(null, [schema.nodes[ENTRY]!.create({ id: A })]);
    schema.topNodeType.createChecked(null, [para, notes]);
    expect(() => schema.topNodeType.createChecked(null, [notes])).toThrow();
    expect(() => schema.topNodeType.createChecked(null, [notes, para])).toThrow();
    expect(() => schema.topNodeType.createChecked(null, [para, notes, notes])).toThrow();
    expect(() => schema.nodes[LIST]!.createChecked(null, [])).toThrow();
    // No block in the list, and no list in a block.
    expect(() => schema.nodes[LIST]!.createChecked(null, [para])).toThrow();
    expect(schema.nodes.blockquote!.contentMatch.matchType(schema.nodes[LIST]!)).toBeNull();
    // A marker stands in a paragraph and not in an entry.
    expect(schema.nodes.paragraph!.contentMatch.matchType(schema.nodes[MARKER]!)).not.toBeNull();
    expect(schema.nodes[ENTRY]!.contentMatch.matchType(schema.nodes[MARKER]!)).toBeNull();
    expect(schema.nodes[MARKER]!.spec.marks).toBe('');
  });
});

describe('what arrives from another client: taken out alike by every client, never made (FR-ED-16)', () => {
  it('does not make the entry of a marker that arrives with none', () => {
    const editor = editorOf(p(text('x')));
    peer(editor, [p(text('x'), marker(A))]);
    expect(now(editor)).toBe('x[a]');
  });

  it('takes out, as every client does, an entry that arrives with no marker, and a second of one identifier', () => {
    const editor = editorOf(p(text('x'), marker(A)), list(entry(A, text('kept'))));
    peer(editor, [
      p(text('x'), marker(A)),
      list(entry(A, text('kept')), entry(A, text('again')), entry(B, text('orphan'))),
    ]);
    expect(now(editor)).toBe('x[a] | {<a: kept>}');
    // And a second marker of one identifier, which nothing links to: the later is taken out.
    peer(editor, [p(text('x'), marker(A), text('y'), marker(A)), list(entry(A, text('kept')))]);
    expect(now(editor)).toBe('x[a]y | {<a: kept>}');
  });

  it('takes out the list whole where every entry of it is wanted by no marker', () => {
    const editor = editorOf(p(text('x')));
    peer(editor, [p(text('x')), list(entry(A, text('left')))]);
    expect(now(editor)).toBe('x');
  });

  it('puts in what is missing at this writer’s next change, and not before', () => {
    const editor = editorOf(p(text('x')));
    peer(editor, [p(text('x'), marker(A)), list(entry(B, text('left')))]);
    expect(now(editor)).toBe('x[a]');
    dispatch(editor, (tr) => tr.insertText('!', 2));
    expect(now(editor)).toBe('x![a] | {<a: >}');
  });

  it('writes nothing in answer to a change that leaves the document as it must be', () => {
    const editor = editorOf(p(text('x'), marker(A)), list(entry(A, text('kept'))));
    const transactions: Transaction[] = [];
    editor.on('transaction', ({ transaction }) => transactions.push(transaction));
    peer(editor, [p(text('xy'), marker(A)), list(entry(A, text('kept')))]);
    expect(transactions.filter((each) => each.docChanged)).toHaveLength(1);
  });

  it('is not run where the document cannot be edited', () => {
    const editor = editorOf(p(marker(A), text('w')));
    editor.setEditable(false);
    const tr = editor.state.tr.insertText('!', 3);
    // The rule of FR-ED-18 refuses the change; nothing else is made either.
    editor.view.dispatch(tr);
    expect(now(editor)).toBe('[a]w');
  });
});

describe('the paragraph kept at the end of the document goes before the list', () => {
  const table = (): Json => ({
    type: 'tableBlock',
    content: [
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content: [p()] }] }] },
      { type: 'tableCaption' },
    ],
  });

  it('puts an empty paragraph after a last block that is not one, before the list of footnotes', () => {
    const editor = editorOf(p(marker(A)), table(), list(entry(A)));
    dispatch(editor, (tr) => tr.insertText('x', 1));
    const names = editor.state.doc.children.map((child) => child.type.name);
    expect(names).toEqual(['paragraph', 'tableBlock', 'paragraph', LIST]);
    editor.state.doc.check();
  });

  it('keeps the library’s own behaviour where there is no list: a paragraph at the end', () => {
    const editor = editorOf(p(text('x')), table());
    dispatch(editor, (tr) => tr.insertText('y', 2));
    expect(editor.state.doc.children.map((child) => child.type.name)).toEqual([
      'paragraph',
      'tableBlock',
      'paragraph',
    ]);
  });

  it('adds nothing where the body already ends in a paragraph', () => {
    const editor = editorOf(table(), p(marker(A)), list(entry(A)));
    dispatch(editor, (tr) => tr.insertText('y', at(editor, 'paragraph', 1) + 1));
    expect(editor.state.doc.children.map((child) => child.type.name)).toEqual([
      'tableBlock',
      'paragraph',
      LIST,
    ]);
  });
});

describe('a copied marker (S20-4)', () => {
  const props = (editor: Editor) => plugin(editor).props;
  const view = (editor: Editor) => ({ state: editor.state }) as never;
  /** The slice of the first paragraph's content, as a copy makes it. */
  const copy = (editor: Editor, paragraph = 0) => {
    const from = paragraph === 0 ? 1 : editor.state.doc.child(0).nodeSize + 1;
    const to = from + editor.state.doc.child(paragraph).content.size;
    const slice = editor.state.doc.slice(from, to);
    return props(editor).transformCopied!.call(plugin(editor), slice, view(editor));
  };
  const paste = (editor: Editor, slice: Slice) => {
    const pasted = props(editor).transformPasted!.call(plugin(editor), slice, view(editor), false);
    dispatch(editor, (tr) => tr.replaceSelection(pasted).setMeta('paste', true));
    return pasted;
  };
  const ids = (editor: Editor) => {
    const found: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.type.name === MARKER) found.push(node.attrs.id as string);
    });
    return found;
  };

  it('pastes as a new footnote with a new identifier, holding the words of the entry it was copied from', () => {
    const editor = editorOf(p(text('Word'), marker(A)), p(text('Next')), list(entry(A, text('The note'))));
    const slice = copy(editor);
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 5);
    const pasted = paste(editor, slice);
    const [first, second] = ids(editor);
    expect(first).toBe(A);
    expect(second).not.toBe(A);
    expect(second).toMatch(/^[0-9a-f]{24}$/);
    // The slice that was pasted is not the one that was copied: its marker has the new identifier.
    expect(JSON.stringify(pasted.content.toJSON())).not.toContain(A);
    // Pasted after "Next", with its entry after the first, which is where its marker stands in the order.
    const short = second!.slice(0, 1);
    expect(now(editor)).toBe(`Word[a] | NextWord[${short}] | {<a: The note> <${short}: The note>}`);
    expect(editor.state.doc.lastChild!.childCount).toBe(2);
    editor.state.doc.check();
  });

  it('pastes the words of an entry that a cut took out with its marker', () => {
    const editor = editorOf(p(text('Word'), marker(A)), p(text('Next')), list(entry(A, text('Kept words'))));
    const slice = copy(editor);
    dispatch(editor, (tr) => tr.delete(1, 1 + editor.state.doc.child(0).content.size));
    expect(now(editor)).toBe(' | Next');
    editor.commands.setTextSelection(editor.state.doc.child(0).nodeSize + 5);
    paste(editor, slice);
    expect(editor.state.doc.lastChild!.type.name).toBe(LIST);
    expect(editor.state.doc.lastChild!.textContent).toBe('Kept words');
  });

  it('pastes an empty entry where the entry is nowhere: another tab, another document', () => {
    const editor = editorOf(p(text('Next')));
    // A marker of an identifier that no entry of this document holds and this tab has not kept.
    const elsewhere = editor.schema.nodeFromJSON(p(marker('9'.repeat(24))));
    editor.commands.setTextSelection(3);
    paste(editor, new Slice(elsewhere.content, 0, 0));
    expect(editor.state.doc.lastChild!.type.name).toBe(LIST);
    expect(editor.state.doc.lastChild!.textContent).toBe('');
    expect(editor.state.doc.lastChild!.childCount).toBe(1);
    expect(ids(editor)).toHaveLength(1);
    expect(ids(editor)).not.toContain('9'.repeat(24));
  });

  it('gives a marker that arrives in a paste an identifier of its own even when the page supplies one', () => {
    const editor = editorOf(p(text('Next')));
    const hostile = editor.schema.nodeFromJSON({
      type: 'doc',
      content: [p(marker('0123456789abcdef01234567'))],
    });
    editor.commands.setTextSelection(3);
    paste(editor, new Slice(hostile.content, 0, 0));
    expect(ids(editor)).toHaveLength(1);
    expect(ids(editor)[0]).not.toBe('0123456789abcdef01234567');
    expect(editor.state.doc.lastChild!.childCount).toBe(1);
  });
});

describe('the limits of a document count footnotes (D184, D192; S20-2)', () => {
  const countOf = (editor: Editor) => countsOf(editor.state.doc);

  it('counts an entry as one block, the list and the marker as none', () => {
    const editor = editorOf(p(marker(A), text(' x')), p(marker(B)), list(entry(A, text('a')), entry(B)));
    expect(countOf(editor).blocks).toBe(4);
    const without = editorOf(p(text(' x')), p());
    expect(countOf(without).blocks).toBe(2);
    expect(countOf(editorOf(p(), list(entry(A)))).blocks).toBe(2);
  });

  it('takes the document to 5,000 blocks with the entry, and refuses the footnote that would make 5,001', () => {
    const paragraphs = (count: number) => Array.from({ length: count }, () => p());
    const under = editorOf(p(text('x')), ...paragraphs(LIMITS.blocks - 2));
    expect(countOf(under).blocks).toBe(LIMITS.blocks - 1);
    under.commands.setTextSelection(2);
    const fits = insertingFootnote(under.state, undefined, A)!;
    expect(countsOf(fits.doc).blocks).toBe(LIMITS.blocks);
    expect(limitRefusal(fits, under.state.doc)).toBeNull();

    const full = editorOf(p(text('x')), ...paragraphs(LIMITS.blocks - 1));
    expect(countOf(full).blocks).toBe(LIMITS.blocks);
    full.commands.setTextSelection(2);
    const over = insertingFootnote(full.state, undefined, A)!;
    expect(countsOf(over.doc).blocks).toBe(LIMITS.blocks + 1);
    expect(limitRefusal(over, full.state.doc)).toBe(
      `We cannot add this block. Our current limit per document is 5,000 blocks.`,
    );
  });
});

describe('Enter in an entry (S20-5)', () => {
  const inEntry = () => {
    const editor = editorOf(p(marker(A), text(' w')), list(entry(A, text('note'))));
    editor.commands.setTextSelection(entryOf(editor.state.doc, A)!.pos + 3);
    return editor;
  };

  it('is a line break, and never a second entry: the library’s own command refuses an isolating block', () => {
    const editor = inEntry();
    // What the library offers does nothing here, which is why the entry has a key of its own.
    expect(editor.commands.setHardBreak()).toBe(false);
    expect(lineBreakInEntry(editor)).toBe(true);
    expect(now(editor)).toBe('[a] w | {<a: no⏎te>}');
    expect(editor.state.doc.lastChild!.childCount).toBe(1);
    editor.state.doc.check();
  });

  it('replaces what is selected', () => {
    const editor = inEntry();
    const held = entryOf(editor.state.doc, A)!;
    editor.commands.setTextSelection({ from: held.pos + 2, to: held.pos + 4 });
    expect(lineBreakInEntry(editor)).toBe(true);
    expect(entryOf(editor.state.doc, A)!.node.textContent).toBe('ne');
    expect(entryOf(editor.state.doc, A)!.node.child(1).type.name).toBe('hardBreak');
  });

  it('is not the key where the cursor is not in an entry', () => {
    const editor = editorOf(p(text('words')));
    editor.commands.setTextSelection(3);
    expect(lineBreakInEntry(editor)).toBe(false);
    expect(now(editor)).toBe('words');
  });
});

describe('the row of the palette (FR-ED-10, FR-ED-12)', () => {
  const type = (editor: Editor, words: string) => {
    for (const character of words) editor.view.dispatch(editor.state.tr.insertText(character));
  };
  const listed = (editor: Editor) => slashPalette(editor.state).options.map(({ id }) => id);

  it('lists /footnote and /fn, and puts the marker where the command stood, the entry made, the cursor in it', () => {
    for (const typed of ['/footnote', '/fn', '/foot']) {
      const editor = editorOf(p(text('See ')), p(text('Next')));
      editor.commands.setTextSelection(5);
      type(editor, typed);
      expect(listed(editor), typed).toEqual(['footnote']);
      expect(slashPalette(editor.state).options[0]).toMatchObject({ label: 'Footnote', detail: '/footnote' });
      chooseSlashCommand(editor, 'footnote');
      expect(editor.state.doc.firstChild!.textContent, typed).toBe('See ');
      expect(editor.state.doc.firstChild!.lastChild!.type.name, typed).toBe(MARKER);
      expect(editor.state.doc.lastChild!.type.name, typed).toBe(LIST);
      expect(editor.state.selection.$from.parent.type.name, typed).toBe(ENTRY);
      expect(slashPalette(editor.state).open, typed).toBe(false);
      editor.state.doc.check();
    }
  });

  it('keeps what follows the command, and makes nothing but the marker in its place', () => {
    const editor = editorOf(p(text('Before ')));
    editor.commands.setTextSelection(8);
    type(editor, '/fn');
    editor.commands.setTextSelection(editor.state.doc.firstChild!.content.size + 1);
    chooseSlashCommand(editor, 'footnote');
    expect(editor.state.doc.firstChild!.textContent).toBe('Before ');
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('is not listed where a marker cannot stand, and not where the entry would pass the limit', () => {
    const editor = editorOf(p(marker(A)), list(entry(A, text('words'))));
    editor.commands.setTextSelection(entryOf(editor.state.doc, A)!.pos + 3);
    type(editor, ' /');
    expect(slashPalette(editor.state).open).toBe(false);

    const code = editorOf({ type: 'codeBlock', attrs: { language: 'plaintext' } });
    type(code, '/');
    expect(slashPalette(code.state).open).toBe(false);

    const full = editorOf(p(text('x')), ...Array.from({ length: LIMITS.blocks - 1 }, () => p()));
    full.commands.setTextSelection(2);
    type(full, ' /fn');
    expect(listed(full)).toEqual([]);
  });

  it('is one step of undo with the marker and the entry together: both are in the one change', () => {
    const editor = editorOf(p(text('x')));
    editor.commands.setTextSelection(2);
    type(editor, ' /fn');
    // Every transaction the editor applied, an appended one included: one changes the document.
    const applied: Transaction[] = [];
    editor.on('transaction', ({ transaction }) => applied.push(transaction));
    chooseSlashCommand(editor, 'footnote');
    expect(applied.filter((each) => each.docChanged)).toHaveLength(1);
    expect(editor.state.doc.lastChild!.type.name).toBe(LIST);
  });
});

describe('applyNotes', () => {
  const run = (editor: Editor) => {
    const tr = editor.state.tr;
    const applied = applyNotes(tr);
    return { tr, applied };
  };

  it('changes nothing in a document that is as it must be, and says so', () => {
    const editor = editorOf(p(marker(A)), p(marker(B)), list(entry(A), entry(B)));
    const { tr, applied } = run(editor);
    expect(applied).toEqual({ changed: false, made: [] });
    expect(tr.docChanged).toBe(false);
  });

  it('is idempotent: applied to what it made it makes nothing more', () => {
    const editor = editorOf(p(marker(A), marker(B)), list(entry(C, text('x'))));
    const first = run(editor);
    expect(first.applied.changed).toBe(true);
    expect(first.applied.made.sort()).toEqual([A, B]);
    const next = editor.state.apply(first.tr);
    const again = next.tr;
    expect(applyNotes(again).changed).toBe(false);
  });

  it('is cheap in a document of 5,000 blocks and 500 footnotes: a key reads the nodes that changed', () => {
    const body: Json[] = [];
    const entries: Json[] = [];
    for (let at = 0; at < 4500; at += 1) body.push(p(text(`line ${at}`)));
    for (let at = 0; at < 500; at += 1) {
      const id = at.toString(16).padStart(24, '0');
      body.push(p(text(`note ${at}`), marker(id)));
      entries.push(entry(id, text(`words ${at}`)));
    }
    const editor = editorOf(...body, list(...entries));
    const spent: number[] = [];
    for (let key = 0; key < 20; key += 1) {
      const began = performance.now();
      editor.view.dispatch(editor.state.tr.insertText('x', 3));
      spent.push(performance.now() - began);
    }
    spent.sort((a, b) => a - b);
    // A generous bound, fifty times what the median key took (a millisecond). It fails where every key reads every node.
    expect(spent[10]!).toBeLessThan(50);
    expect(editor.state.doc.lastChild!.childCount).toBe(500);

    // What follows a change that arrives, which deletes and makes nothing, reads as little.
    const arriving: number[] = [];
    for (let key = 0; key < 20; key += 1) {
      const began = performance.now();
      const next = editor.state.tr.insertText('y', 5);
      applyNotes(next, true);
      editor.view.dispatch(
        next.setMeta(ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false }),
      );
      arriving.push(performance.now() - began);
    }
    arriving.sort((a, b) => a - b);
    expect(arriving[10]!).toBeLessThan(50);
  });
});
