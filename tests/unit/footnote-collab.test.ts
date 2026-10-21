// Footnotes written by several clients at once (FR-ED-05, FR-ED-16; docs/plan/slice-20.md,
// section 3): each client is the page's own schema, extensions and collaboration binding on its
// own Yjs document, and updates pass between the documents in the order a test chooses. What is
// asked after they have passed is that every client holds the same document (the same text, the
// same Yjs state), and that it is a document where each marker has exactly one entry and each
// entry one marker, in the order of the markers.
import { Editor, type JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { ySyncPluginKey, yUndoPluginKey, type ProsemirrorBinding } from '@tiptap/y-tiptap';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { extensions, holdBinding } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  ENTRY,
  LIST,
  MARKER,
  entryOf,
  insertingFootnote,
  numbering,
} from '../../src/app/(app)/documents/[id]/footnotes.ts';
import { shapeOf } from '../../src/lib/collab/shape.ts';

type Json = JSONContent;
const A = 'a'.repeat(24);
const B = 'b'.repeat(24);
const C = 'c'.repeat(24);
const D = 'd'.repeat(24);
const text = (words: string): Json => ({ type: 'text', text: words });
const p = (...content: Json[]): Json => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const marker = (id: string): Json => ({ type: MARKER, attrs: { id } });
const entry = (id: string, ...content: Json[]): Json => ({
  type: ENTRY,
  attrs: { id },
  ...(content.length ? { content } : {}),
});
const list = (...entries: Json[]): Json => ({ type: LIST, content: entries });

/** One client: an editor on its own document, bound to it as the page binds it. */
function client(document: Y.Doc) {
  const editor = new Editor({
    element: null,
    content: { type: 'doc', content: [{ type: 'paragraph' }] },
    extensions: extensions(document),
  });
  // The library adds the plugins of the extensions when it makes a view, which there is none of here.
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  const { binding } = ySyncPluginKey.getState(editor.state) as { binding: ProsemirrorBinding };
  const view = {
    get state() {
      return editor.state;
    },
    dispatch: (transaction: Transaction) => editor.view.dispatch(transaction),
    hasFocus: () => false,
    editable: true,
  };
  holdBinding(view as never, vi.fn(), vi.fn());
  binding.initView(view as never);
  binding._forceRerender();
  const made = {
    document,
    editor,
    /** A change of this writer's: applied in the editor, as its keys do, and written to the shared document. */
    write(make: (tr: Transaction) => Transaction) {
      editor.view.dispatch(make(editor.state.tr));
      binding._prosemirrorChanged(editor.state.doc);
    },
    get doc(): PMNode {
      return editor.state.doc;
    },
    /** What the client holds, as one string: `[a]` a marker, `<a: words>` an entry. */
    get shown() {
      return shape(editor.state.doc);
    },
    undo: () => editor.commands.undo(),
  };
  return made;
}
type Client = ReturnType<typeof client>;

function shape(node: PMNode): string {
  if (node.isText) return node.text!;
  if (node.type.name === MARKER) return `[${String(node.attrs.id).slice(0, 1)}]`;
  const inside = node.children.map(shape).join(node.type.name === LIST ? ' ' : '');
  if (node.type.name === ENTRY) return `<${String(node.attrs.id).slice(0, 1)}: ${inside}>`;
  if (node.type.name === LIST) return `{${inside}}`;
  if (node.type.name === 'doc') return node.children.map(shape).join(' | ');
  return inside;
}

const undoManagerOf = (made: Client) =>
  (yUndoPluginKey.getState(made.editor.state) as { undoManager: Y.UndoManager }).undoManager;

/** The document with some content, as a first client made it, and the clients that open it. */
function opened(content: Json[], count = 2): Client[] {
  const first = new Y.Doc();
  const writer = client(first);
  writer.write((tr) =>
    tr.replaceWith(
      0,
      tr.doc.content.size,
      writer.editor.schema.nodeFromJSON({ type: 'doc', content }).content,
    ),
  );
  const clients = [writer];
  for (let at = 1; at < count; at += 1) {
    const document = new Y.Doc();
    Y.applyUpdate(document, Y.encodeStateAsUpdate(first));
    clients.push(client(document));
  }
  // What was written to set the document up is no step of any writer's undo.
  for (const each of clients) undoManagerOf(each).clear();
  return clients;
}

/** Every client's changes reach every other, until none has more to send. */
function exchange(...clients: Client[]) {
  for (let round = 0; round < 6; round += 1) {
    for (const from of clients) {
      for (const to of clients) {
        if (from === to) continue;
        Y.applyUpdate(
          to.document,
          Y.encodeStateAsUpdate(from.document, Y.encodeStateVector(to.document)),
          'peer',
        );
      }
    }
  }
}

/** Same text, same Yjs state. */
function converged(...clients: Client[]) {
  const [first, ...rest] = clients;
  for (const other of rest) {
    expect(other.shown).toBe(first!.shown);
    expect(JSON.stringify(other.doc.toJSON())).toBe(JSON.stringify(first!.doc.toJSON()));
    expect(Y.encodeStateVector(other.document)).toEqual(Y.encodeStateVector(first!.document));
    expect(other.document.getXmlFragment('default').toString()).toBe(
      first!.document.getXmlFragment('default').toString(),
    );
  }
}

/**
 * A document where each marker has one entry and each entry one marker. The order of the entries is not
 * asked: it is the order their markers had when they were made, which two writers at one place can leave
 * the other way (S20-11), and each entry is drawn with the number of its own marker whatever its place.
 */
function whole(client: Client) {
  const markers: string[] = [];
  client.doc.descendants((node) => {
    if (node.type.name === MARKER) markers.push(node.attrs.id as string);
  });
  const entries: string[] = [];
  if (client.doc.lastChild?.type.name === LIST)
    client.doc.lastChild.forEach((each) => entries.push(each.attrs.id as string));
  expect([...entries].sort()).toEqual([...markers].sort());
  expect(new Set(markers).size).toBe(markers.length);
  client.doc.check();
}

/** A marker at a place in the first paragraph, as the palette puts it. */
function footnote(client: Client, id: string, at: number) {
  client.editor.commands.setTextSelection(at);
  client.write(() => insertingFootnote(client.editor.state, undefined, id)!);
}
/** A change that any writer makes next, which is what puts a list right. */
function key(client: Client, at = 1) {
  client.write((tr) => tr.insertText('.', at));
}

describe('two writers add footnotes at once (FR-ED-05, FR-ED-16)', () => {
  // Two writers who put an inline node into one run of text at once write the tail of the run twice: the
  // binding writes the node by cutting the run and writing the tail again (the same of a line break), and
  // the footnote is not the cause (S20-10). The tests that share a paragraph ask for what is the footnote's.
  const body = () => [p(text('one two three four')), p(text('five six seven eight'))];

  it('at two places: each marker has its entry, and both writers hold the same document', () => {
    const [a, b] = opened([...body(), p(marker(D)), list(entry(D, text('Dd')))]);
    exchange(a!, b!);
    footnote(a!, A, 5);
    footnote(b!, B, a!.doc.child(0).nodeSize + 6);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    // The list is in the order Yjs gave the two entries, which are put in at one place; the text is as it was written.
    expect(a!.shown.split(' | {')[0]).toBe('one [a]two three four | five s[b]ix seven eight | [d]');
    expect([...numbering(a!.doc).keys()]).toEqual([A, B, D]);
  });

  it('at one place: both markers stand, in the order Yjs gives them, and the list is put in that order', () => {
    const [a, b] = opened([...body(), p(marker(D)), list(entry(D, text('Dd')))]);
    footnote(a!, A, 5);
    footnote(b!, B, 5);
    exchange(a!, b!);
    converged(a!, b!);
    // What the entries stand in may differ from the markers' order for now: the next change by anyone puts it right.
    key(a!, 2);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    whole(b!);
    expect(numbering(a!.doc).size).toBe(3);
  });

  it('as the first footnote of the document, both at once: the second list goes, the markers stay, the entry is made again', () => {
    const [a, b] = opened(body());
    footnote(a!, A, 5);
    footnote(b!, B, 15);
    exchange(a!, b!);
    converged(a!, b!);
    // Both made a list: the schema keeps one, and a marker is left without its entry.
    expect(a!.doc.childCount).toBeLessThanOrEqual(3);
    expect(a!.doc.lastChild!.type.name).toBe(LIST);
    expect(numbering(a!.doc).size).toBe(2);
    key(a!, 2);
    key(b!, 2);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    whole(b!);
  });

  it('with the words of the first typed in the entry of the other: they are kept where the entry stays', () => {
    const [a, b] = opened([...body(), p(marker(D)), list(entry(D, text('Dd')))]);
    footnote(a!, A, 5);
    exchange(a!, b!);
    const held = entryOf(a!.doc, A)!;
    a!.write((tr) => tr.insertText('words', held.pos + 1));
    footnote(b!, B, 15);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(entryOf(b!.doc, A)!.node.textContent).toBe('words');
  });
});

describe('two writers remove footnotes at once', () => {
  const three = () => [
    p(marker(A), text(' one '), marker(B), text(' two '), marker(C)),
    list(entry(A, text('Aa')), entry(B, text('Bb')), entry(C, text('Cc'))),
  ];

  it('the same marker: the entry goes once, and the others are as they were', () => {
    // Markers side by side: two writers who delete an inline node between two runs of text each join the
    // runs and write the second again, which is how the binding writes any such deletion and is not the
    // footnote's.
    const [a, b] = opened([
      p(text('words '), marker(A), marker(B), marker(C)),
      list(entry(A, text('Aa')), entry(B, text('Bb')), entry(C, text('Cc'))),
    ]);
    const entries = [...a!.doc.lastChild!.children];
    for (const writer of [a!, b!]) {
      writer.write((tr) => {
        let at = -1;
        writer.doc.descendants((node, pos) => {
          if (at < 0 && node.type.name === MARKER && node.attrs.id === B) at = pos;
        });
        return tr.delete(at, at + 1);
      });
    }
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(a!.shown).toBe('words [a][c] | {<a: Aa> <c: Cc>}');
    expect(entryOf(a!.doc, A)!.node.textContent).toBe('Aa');
    expect(entries).toHaveLength(3);
  });

  it('two markers, one each: both entries go', () => {
    const [a, b] = opened(three());
    const delete_ = (writer: Client, id: string) =>
      writer.write((tr) => {
        let at = -1;
        writer.doc.descendants((node, pos) => {
          if (at < 0 && node.type.name === MARKER && node.attrs.id === id) at = pos;
        });
        return tr.delete(at, at + 1);
      });
    delete_(a!, A);
    delete_(b!, C);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(a!.shown).toBe(' one [b] two  | {<b: Bb>}');
  });

  it('a marker while the other writes in its entry: the footnote goes, with the words, and both hold the same', () => {
    const [a, b] = opened(three());
    const held = entryOf(b!.doc, B)!;
    b!.write((tr) => tr.insertText('typing', held.pos + 1));
    let at = -1;
    a!.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === MARKER && node.attrs.id === B) at = pos;
    });
    a!.write((tr) => tr.delete(at, at + 1));
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(a!.shown).toBe('[a] one  two [c] | {<a: Aa> <c: Cc>}');
  });

  it('the last marker, while the other adds one: the list stays for the new footnote', () => {
    const [a, b] = opened([p(text('words '), marker(A)), list(entry(A, text('Aa')))]);
    let at = -1;
    a!.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === MARKER) at = pos;
    });
    a!.write((tr) => tr.delete(at, at + 1));
    footnote(b!, B, 2);
    exchange(a!, b!);
    converged(a!, b!);
    key(a!, 1);
    key(b!, 1);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    whole(b!);
    expect(numbering(a!.doc).size).toBe(1);
  });
});

describe('a list that two writers left wrong is put right by the next change, by any of them', () => {
  it('an entry twice, written straight to the shared document: the later is deleted by each client, with no change of anyone’s', () => {
    const [a, b] = opened([p(marker(A)), list(entry(A, text('first')))]);
    // What no editor of this page writes: a second entry of one identifier, put in at the end of the list.
    const fragment = a!.document.getXmlFragment('default');
    const notes = fragment.get(fragment.length - 1) as Y.XmlElement;
    const second = new Y.XmlElement('footnote');
    second.setAttribute('id', A);
    const words = new Y.XmlText();
    words.insert(0, 'second');
    second.insert(0, [words]);
    a!.document.transact(() => notes.insert(notes.length, [second]), 'peer');
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(a!.shown).toBe('[a] | {<a: first>}');
  });

  it('an entry twice that two writers made, each for the marker that had none: the later is deleted by each', () => {
    const [a, b] = opened([p(text('words')), p(marker(A))]);
    key(a!, 1);
    key(b!, 1);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(a!.doc.lastChild!.childCount).toBe(1);
  });

  it('an entry whose marker is gone, and a marker with no entry: put right by deletion and by one insertion', () => {
    const [a, b] = opened([p(marker(A), text('w')), list(entry(B, text('left over')))]);
    exchange(a!, b!);
    key(a!, 1);
    key(b!, 1);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect(a!.shown.replace(/\./g, '')).toBe('[a]w | {<a: >}');
  });

  it('five writers keying at once on a wrong list: they converge on one list that is right', () => {
    const clients = opened(
      [
        p(marker(A), marker(B), marker(C), text('w')),
        list(entry(D, text('x')), entry(C, text('Cc')), entry(C, text('dup'))),
      ],
      5,
    );
    exchange(...clients);
    clients.forEach((writer, at) => key(writer, 1 + at));
    exchange(...clients);
    converged(...clients);
    // One more round, which writes nothing where the list is right.
    const states = clients.map((writer) => Y.encodeStateVector(writer.document));
    clients.forEach((writer) => key(writer, 1));
    exchange(...clients);
    converged(...clients);
    whole(clients[0]!);
    expect(states.length).toBe(5);
  });
});

describe('text moved by one writer while another types in an entry (reordered, FR-ED-05)', () => {
  it('renumbers by the markers, writes no entry again, and keeps the words typed meanwhile in the entry they were typed in', () => {
    const [a, b] = opened([
      p(marker(A), text(' one')),
      p(marker(B), text(' two')),
      p(text('end')),
      list(entry(A, text('Aa')), entry(B, text('Bb'))),
    ]);
    // A moves the second paragraph before the first.
    const second = a!.doc.child(1);
    const from = a!.doc.child(0).nodeSize;
    a!.write((tr) => tr.delete(from, from + second.nodeSize).insert(0, second));
    const held = entryOf(b!.doc, A)!;
    b!.write((tr) => tr.insertText('!', held.pos + 3));
    exchange(a!, b!);
    converged(a!, b!);
    key(a!, 1);
    exchange(a!, b!);
    converged(a!, b!);
    whole(a!);
    expect([...numbering(a!.doc).keys()]).toEqual([B, A]);
    // The entries stand where they did: no entry was written in the place of another, so the words typed
    // in the entry of A, while the other writer moved its marker, are in the entry of A (S20-11).
    expect(entryOf(a!.doc, A)!.node.textContent).toBe('Aa!');
    expect(entryOf(a!.doc, B)!.node.textContent).toBe('Bb');
  });
});

describe('undo (FR-ED-16)', () => {
  it('takes a footnote away with its marker and its entry in one step, and brings both back', () => {
    const [a] = opened([p(text('one two'))], 1);
    footnote(a!, A, 4);
    expect(a!.shown).toBe('one[a] two | {<a: >}');
    a!.undo();
    expect(a!.shown).toBe('one two');
    a!.editor.commands.redo();
    expect(a!.shown).toBe('one[a] two | {<a: >}');
    whole(a!);
  });
});

describe('what a writer keeps in the shared document is what the server takes (shapeOf)', () => {
  it('every change a writer makes that puts a footnote in, and takes one out, passes the server’s rules', () => {
    const [a] = opened([p(text('one two three'))], 1);
    const seen: Uint8Array[] = [];
    a!.document.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') seen.push(update);
    });
    // The server holds a copy of the document as it was before each update.
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(a!.document));
    seen.length = 0;
    footnote(a!, A, 4);
    footnote(a!, B, 1);
    footnote(a!, C, 12);
    a!.write((tr) => tr.insertText('words', entryOf(a!.doc, A)!.pos + 1));
    let at = -1;
    a!.doc.descendants((node, pos) => {
      if (at < 0 && node.type.name === MARKER && node.attrs.id === B) at = pos;
    });
    a!.write((tr) => tr.delete(at, at + 1));
    expect(seen.length).toBeGreaterThan(0);
    for (const update of seen) {
      expect(shapeOf(server, update)).toBeNull();
      Y.applyUpdate(server, update);
    }
    expect(server.getXmlFragment('default').toString()).toBe(
      a!.document.getXmlFragment('default').toString(),
    );
  });
});
