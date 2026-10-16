// The shape the collaboration server holds a document to (src/lib/collab/shape.ts;
// register D170, D171, D172, D180): an update that creates an element without
// the content the schema requires of it is refused, and so is one that takes a
// table past a bound; what the editor writes is taken.
import { getSchema } from '@tiptap/core';
import { Node as PMNode } from '@tiptap/pm/model';
import { prosemirrorJSONToYDoc, updateYFragment } from '@tiptap/y-tiptap';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  NODES,
  TABLE_CELLS_MOST,
  TABLE_DEPTH_MOST,
  TABLE_MOST,
  shapeOf,
  withCopy,
  withoutCopy,
  type Shape,
} from '../../src/lib/collab/shape.ts';

const schema = getSchema(extensions(new Y.Doc()));

// What the editor writes, as JSON of its schema.
type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };
const p = (text = ''): Json => ({
  type: 'paragraph',
  ...(text ? { content: [{ type: 'text', text }] } : {}),
});
const td = (...content: Json[]): Json => ({ type: 'tableCell', content: content.length ? content : [p()] });
const tr = (cells: Json[]): Json => ({ type: 'tableRow', content: cells });
const table = (rows: Json[], caption = ''): Json => ({
  type: 'tableBlock',
  content: [
    { type: 'table', content: rows },
    { type: 'tableCaption', ...(caption ? { content: [{ type: 'text', text: caption }] } : {}) },
  ],
});
const grid = (
  rows: number,
  columns: number,
  cell = (row: number, column: number) => td(p(`${row}.${column}`)),
) =>
  table(
    Array.from({ length: rows }, (_, row) =>
      tr(Array.from({ length: columns }, (__, column) => cell(row, column))),
    ),
  );
const doc = (...content: Json[]): Json => ({ type: 'doc', content });

/** The server's copy of a document the editor wrote. */
const opened = (json: Json) => prosemirrorJSONToYDoc(schema, json, 'default');

/** A client of the document, as it stands on the server. */
function peerOf(server: Y.Doc) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
  return peer;
}
const sentBy = (peer: Y.Doc, server: Y.Doc) => Y.encodeStateAsUpdate(peer, Y.encodeStateVector(server));

/** What the editor's binding sends to bring the document to `json`. */
function edited(server: Y.Doc, json: Json): Uint8Array {
  const peer = peerOf(server);
  peer.transact(() =>
    updateYFragment(peer, peer.getXmlFragment('default'), PMNode.fromJSON(schema, json), {
      mapping: new Map(),
      isOMark: new Map(),
    }),
  );
  return sentBy(peer, server);
}

/** What a client that is no editor sends. */
function sent(server: Y.Doc, change: (fragment: Y.XmlFragment) => void): Uint8Array {
  const peer = peerOf(server);
  peer.transact(() => change(peer.getXmlFragment('default')));
  return sentBy(peer, server);
}

// Elements as a client of its own makes them, each whole in one change.
const element = (name: string, children: (Y.XmlElement | Y.XmlText)[] = []) => {
  const made = new Y.XmlElement(name);
  if (children.length) made.insert(0, children);
  return made;
};
const words = (written: string) => {
  const made = new Y.XmlText();
  made.insert(0, written);
  return made;
};
const para = (written = '') => element('paragraph', written ? [words(written)] : []);
const cell = (...children: (Y.XmlElement | Y.XmlText)[]) => element('tableCell', children);
const row = (cells: Y.XmlElement[]) => element('tableRow', cells);
const block = (rows: Y.XmlElement[]) =>
  element('tableBlock', [element('table', rows), element('tableCaption')]);
const blockOf = (rows: number, columns: number, make = () => cell(para())) =>
  block(Array.from({ length: rows }, () => row(Array.from({ length: columns }, make))));

/** The answer of the server for an update, and the answer of the copy, which must agree. */
function answer(server: Y.Doc, update: Uint8Array): Shape | null {
  const shape = shapeOf(server, update);
  expect(withCopy(server, update)).toBe(shape);
  return shape;
}
/** Whether the update is answered without the copy. */
const withoutTheCopy = (server: Y.Doc, update: Uint8Array) =>
  withoutCopy(server, Y.decodeUpdate(update)) !== undefined;

describe("the server's copy of the schema", () => {
  it('is the editor’s: every node, in its order, with its content and its groups', () => {
    const editor = Object.values(schema.nodes).map((type) => [
      type.name,
      type.spec.content ?? null,
      type.spec.group ?? null,
      type.isInline,
    ]);
    const server = Object.entries(NODES).map(([name, spec]) => [
      name,
      spec.content ?? null,
      spec.group ?? null,
      name === 'text' || spec.inline === true,
    ]);
    expect(server).toEqual(editor);
    expect(schema.topNodeType.name).toBe('doc');
  });

  it('holds the bounds of the browser', () => {
    expect([TABLE_MOST, TABLE_CELLS_MOST, TABLE_DEPTH_MOST]).toEqual([100, 10_000, 2]);
  });
});

describe('an update that creates an element without the content it must hold is refused (D170, D180)', () => {
  const server = () => opened(doc(p('Before.'), grid(2, 2), p('After.')));

  it.each([
    ['a table without a row', () => block([])],
    ['a row of cells that hold nothing', () => block([row([cell(), cell(), cell()])])],
    ['a cell that holds only text', () => block([row([cell(words('loose'))])])],
    [
      'a table block without its caption',
      () => element('tableBlock', [element('table', [row([cell(para())])])]),
    ],
    [
      'a caption before its table',
      () => element('tableBlock', [element('tableCaption'), element('table', [row([cell(para())])])]),
    ],
    ['a table block without its table', () => element('tableBlock', [element('tableCaption')])],
    ['a quotation without a block', () => element('blockquote')],
    ['a callout without a paragraph', () => element('callout')],
    ['a list without an item', () => element('bulletList')],
    [
      'a list item without a paragraph',
      () =>
        element('orderedList', [
          element('listItem', [element('bulletList', [element('listItem', [para('x')])])]),
        ]),
    ],
  ])('%s', (_, made) => {
    const document = server();
    const update = sent(document, (fragment) => fragment.insert(1, [made()]));
    expect(answer(document, update)).toBe('incomplete');
  });

  it('and so is one put into a document that holds nothing yet', () => {
    const document = new Y.Doc();
    document.getArray('other').push(['something']);
    const update = sent(document, (fragment) => fragment.push([block([])]));
    expect(withoutTheCopy(document, update)).toBe(true);
    expect(answer(document, update)).toBe('incomplete');
  });

  it('and so is a caption put before its table once the table was made, in the same change', () => {
    const document = server();
    const update = sent(document, (fragment) => {
      const made = element('tableBlock', [element('table', [row([cell(para())])])]);
      fragment.insert(1, [made]);
      made.insert(0, [element('tableCaption')]);
    });
    expect(answer(document, update)).toBe('incomplete');
  });

  it('and so is one whose content is deleted in the change that made it, by a client that keeps what it deletes', () => {
    const document = server();
    const peer = new Y.Doc({ gc: false });
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
    peer.transact(() => {
      const quote = element('blockquote', [para('gone at once')]);
      peer.getXmlFragment('default').insert(1, [quote]);
      quote.delete(0, 1);
    });
    expect(answer(document, sentBy(peer, document))).toBe('incomplete');
  });

  it('and so is a cell added without its paragraph to a table that is there', () => {
    const document = server();
    const update = sent(document, (fragment) => {
      const existing = (fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement;
      (existing.get(0) as Y.XmlElement).push([cell()]);
    });
    expect(answer(document, update)).toBe('incomplete');
  });

  it('but not one that empties a cell that is there: that cannot be told from an honest deletion (D180)', () => {
    const document = server();
    const update = sent(document, (fragment) => {
      const existing = (fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement;
      const first = (existing.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
      first.delete(0, first.length);
    });
    expect(answer(document, update)).toBeNull();
  });

  it('nor one whose element holds more than its content takes: the browser leaves that out and writes nothing', () => {
    const document = server();
    const update = sent(document, (fragment) =>
      fragment.insert(1, [block([row([cell(para('a'))]), para('stray under the table')])]),
    );
    expect(answer(document, update)).toBeNull();
  });
});

describe('an update that takes a table past a bound is refused (D171, D172)', () => {
  it(`a table of ${TABLE_MOST} rows of ${TABLE_MOST} cells is taken, and one more row or one more cell is not`, () => {
    const document = opened(doc(p('Before.')));
    expect(answer(document, edited(document, doc(p('Before.'), grid(100, 100))))).toBeNull();
    expect(
      answer(
        document,
        sent(document, (fragment) => fragment.push([blockOf(101, 1)])),
      ),
    ).toBe('table');
    expect(
      answer(
        document,
        sent(document, (fragment) => fragment.push([blockOf(1, 101)])),
      ),
    ).toBe('table');
  });

  it('a row deleted and a row added in one change to a table of 100 is taken', () => {
    const document = opened(doc(grid(100, 2)));
    const update = sent(document, (fragment) => {
      const rows = (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement;
      rows.delete(0, 1);
      rows.push([row([cell(para()), cell(para())])]);
    });
    expect(withoutTheCopy(document, update)).toBe(true);
    expect(answer(document, update)).toBeNull();
  });

  it('a row added to a table of 99 is taken, and to a table of 100 is not', () => {
    const at99 = opened(doc(grid(99, 2)));
    expect(answer(at99, edited(at99, doc(grid(100, 2))))).toBeNull();
    const at100 = opened(doc(grid(100, 2)));
    const more = sent(at100, (fragment) =>
      ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).push([row([cell(para()), cell(para())])]),
    );
    expect(answer(at100, more)).toBe('table');
  });

  it(`a table and the tables in its cells hold ${TABLE_CELLS_MOST.toLocaleString('en-GB')} cells together`, () => {
    const inner = table([tr([td(p('in'))]), tr([td(p('in'))])]);
    // 100 by 99, with a table of two cells in one cell: 9,902.
    const document = opened(doc(p('x')));
    const within = doc(grid(99, 100, (r, c) => (r === 0 && c === 0 ? td(inner, p()) : td())));
    expect(answer(document, edited(document, within))).toBeNull();
    // 100 by 100, with the same: 10,002.
    const past = doc(grid(100, 100, (r, c) => (r === 0 && c === 0 ? td(inner, p()) : td())));
    expect(answer(document, edited(document, past))).toBe('table');
  });

  it(`tables stand ${TABLE_DEPTH_MOST} levels deep and no deeper`, () => {
    const document = opened(doc(p('x')));
    const two = table([tr([td(table([tr([td()])]), p())])]);
    expect(answer(document, edited(document, doc(two)))).toBeNull();
    const three = sent(document, (fragment) =>
      fragment.push([
        block([row([cell(block([row([cell(block([row([cell(para())])]), para())])]), para())])]),
      ]),
    );
    expect(answer(document, three)).toBe('table');
  });

  it('a table put into a cell of a table that is there is counted with it', () => {
    const document = opened(doc(grid(100, 100, () => td())));
    const update = sent(document, (fragment) => {
      const first = ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement;
      (first.get(0) as Y.XmlElement).push([block([row([cell(para())])])]);
    });
    expect(answer(document, update)).toBe('table');
  });

  it('a table stored past a bound takes every change that does not take it further past', () => {
    // As a document stored before the server held the bounds could be.
    const stored = new Y.Doc();
    stored.getXmlFragment('default').push([blockOf(120, 1), para('After.')]);
    const typed = sent(stored, (fragment) => (fragment.get(1) as Y.XmlElement).push([para('More.')]));
    expect(answer(stored, typed)).toBeNull();
    const inCell = sent(stored, (fragment) => {
      const first = (((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(
        0,
      ) as Y.XmlElement;
      first.push([para('another paragraph in a cell')]);
    });
    expect(answer(stored, inCell)).toBeNull();
    // A cell more in a row of it: the table is measured, and is no further past.
    const wider = sent(stored, (fragment) =>
      (((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlElement).push([
        cell(para()),
      ]),
    );
    expect(answer(stored, wider)).toBeNull();
    const oneMore = sent(stored, (fragment) =>
      ((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).push([row([cell(para())])]),
    );
    expect(answer(stored, oneMore)).toBe('table');
  });
});

describe('what the editor writes is taken, and without the copy', () => {
  it('typing, a paragraph, a list item, a table, a row, a column, a paste of tables, and their undo and redo', () => {
    const steps: Json[] = [
      doc(p('One.')),
      doc(p('One, typed.')),
      doc(p('One, typed.'), p('Two.')),
      doc(p('One, typed.'), { type: 'bulletList', content: [{ type: 'listItem', content: [p('a')] }] }),
      doc(p('One, typed.'), {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [p('a')] },
          { type: 'listItem', content: [p('b')] },
        ],
      }),
      doc(p('One, typed.'), grid(2, 2)),
      doc(p('One, typed.'), grid(3, 2)),
      doc(p('One, typed.'), grid(3, 3)),
      doc(
        p('One, typed.'),
        grid(3, 3),
        grid(4, 4),
        table([tr([td(table([tr([td(p('in'))])], 'inner'), p())])], 'outer'),
      ),
      doc({ type: 'blockquote', content: [p('q')] }, { type: 'callout', content: [p('c')] }, grid(2, 2)),
    ];
    const server = opened(steps[0]!);
    const writer = peerOf(server);
    const undo = new Y.UndoManager(writer.getXmlFragment('default'), { captureTimeout: 0 });
    const sync = () => {
      const update = sentBy(writer, server);
      expect(withoutTheCopy(server, update)).toBe(true);
      expect(answer(server, update)).toBeNull();
      Y.applyUpdate(server, update);
    };
    for (const json of steps.slice(1)) {
      writer.transact(
        () =>
          updateYFragment(writer, writer.getXmlFragment('default'), PMNode.fromJSON(schema, json), {
            mapping: new Map(),
            isOMark: new Map(),
          }),
        undo.trackedOrigins.values().next().value,
      );
      sync();
    }
    // Undo all the way back and redo all the way forward, each step sent as it is made.
    const answers: (Shape | null)[] = [];
    while (undo.canUndo()) {
      undo.undo();
      const update = sentBy(writer, server);
      answers.push(answer(server, update));
      Y.applyUpdate(server, update);
    }
    while (undo.canRedo()) {
      undo.redo();
      const update = sentBy(writer, server);
      answers.push(answer(server, update));
      Y.applyUpdate(server, update);
    }
    expect(answers.length).toBeGreaterThan(10);
    expect(answers.every((each) => each === null)).toBe(true);
  });

  it('a key typed in a cell of a full table is answered from the update alone', () => {
    const server = opened(doc(grid(100, 100)));
    const update = sent(server, (fragment) => {
      const text = (
        (
          (((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(50) as Y.XmlElement).get(
            50,
          ) as Y.XmlElement
        ).get(0) as Y.XmlElement
      ).get(0) as Y.XmlText;
      text.insert(0, 'k');
    });
    expect(shapeOf(server, update)).toBeNull();
  });
});

describe('an update that sends again what the server holds in part (the review of pull request 39)', () => {
  /**
   * One member in two updates: a first piece is sent and taken; then a second
   * piece, merged by the member's document with the first into one struct,
   * and `made` after it, sent against the state from before the first.
   */
  function twice(
    server: Y.Doc,
    into: (fragment: Y.XmlFragment) => Y.XmlElement | Y.XmlFragment,
    made: () => Y.XmlElement,
  ) {
    const member = peerOf(server);
    const before = Y.encodeStateVector(member);
    const list = into(member.getXmlFragment('default')) as Y.XmlElement;
    list.insert(list.length, ['first piece'] as never);
    Y.applyUpdate(server, sentBy(member, server));
    member.transact(() => {
      list.insert(list.length, ['second piece'] as never);
      list.insert(list.length, [made()]);
    });
    const update = Y.encodeStateAsUpdate(member, before);
    // The first struct begins before the server's clock and ends past it.
    const [first] = Y.decodeUpdate(update).structs;
    const had = Y.getState(server.store, member.clientID);
    expect(first!.id.clock < had && first!.id.clock + first!.length > had).toBe(true);
    return update;
  }

  it('a 101st row is refused', () => {
    const server = opened(doc(grid(100, 2)));
    const update = twice(
      server,
      (fragment) => (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement,
      () => row([cell(para()), cell(para())]),
    );
    expect(withoutTheCopy(server, update)).toBe(false);
    expect(answer(server, update)).toBe('table');
  });

  it('an empty table block in the document itself is refused', () => {
    const server = opened(doc(p('x')));
    const update = twice(
      server,
      (fragment) => fragment,
      () => block([]),
    );
    expect(withoutTheCopy(server, update)).toBe(false);
    expect(answer(server, update)).toBe('incomplete');
  });
});

describe('an update that Yjs does not take in whole is answered on a copy', () => {
  it('the structs of two clients', () => {
    const server = opened(doc(p('x')));
    const one = peerOf(server);
    one.getXmlFragment('default').push([para('one')]);
    const two = peerOf(server);
    Y.applyUpdate(two, sentBy(one, server));
    two.getXmlFragment('default').push([block([])]);
    const update = sentBy(two, server);
    expect(withoutTheCopy(server, update)).toBe(false);
    expect(answer(server, update)).toBe('incomplete');
  });

  it('an element whose one child waits for a struct the server was never sent is created without it', () => {
    const server = opened(doc(p('x')));
    // B makes a quotation with a paragraph; A puts a second paragraph after it,
    // which the server is never sent; C deletes the first and writes after A's.
    const b = peerOf(server);
    b.getXmlFragment('default').push([element('blockquote', [para('first')])]);
    const made = sentBy(b, server);
    const a = peerOf(server);
    Y.applyUpdate(a, made);
    const quote = () => a.getXmlFragment('default').get(1) as Y.XmlElement;
    quote().push([para('withheld')]);
    const c = peerOf(server);
    Y.applyUpdate(c, Y.encodeStateAsUpdate(a));
    const theirs = c.getXmlFragment('default').get(1) as Y.XmlElement;
    c.transact(() => {
      theirs.delete(0, 1);
      theirs.push([para('after it')]);
    });
    // B's quotation and C's change, without A's: the quotation arrives, and holds nothing until A's does.
    const update = Y.mergeUpdates([made, Y.encodeStateAsUpdate(c, Y.encodeStateVector(a))]);
    expect(withoutTheCopy(server, update)).toBe(false);
    expect(answer(server, update)).toBe('incomplete');
  });

  it('what a document waits with, brought in by the update, is counted as created by it', () => {
    const server = opened(doc(p('x')));
    const writer = peerOf(server);
    writer.getXmlFragment('default').push([para('first')]);
    const first = sentBy(writer, server);
    const known = Y.encodeStateVector(writer);
    const nested = peerOf(server);
    Y.applyUpdate(nested, first);
    // A row of empty cells, put in a table after `first`: it waits on the server for `first`.
    nested.getXmlFragment('default').push([block([row([cell(para())])])]);
    const waiting = Y.encodeStateAsUpdate(nested, known);
    expect(answer(server, waiting)).toBeNull();
    Y.applyUpdate(server, waiting);
    expect(server.store.pendingStructs).not.toBeNull();
    // `first` wakes it, and it is whole: taken.
    expect(answer(server, first)).toBeNull();
  });
});
