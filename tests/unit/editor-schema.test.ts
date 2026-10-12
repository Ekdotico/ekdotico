// The schema of a document as the sanitiser of what arrives (NFR-SE-06, A03):
// every attribute of every node and mark has one rule, and the schema applies
// it wherever a node or a mark is made, so that no plugin, node view or
// rendering is handed a value another client chose freely.
import { getSchema } from '@tiptap/core';
import { DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { EditorState, type Plugin, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import {
  prosemirrorJSONToYDoc,
  ySyncPlugin,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
  type ProsemirrorBinding,
} from '@tiptap/y-tiptap';
import { describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  ATTRIBUTE_RULES,
  CODE_COLOURS_MOST,
  TABLE_MOST,
  closeSchema,
  codeColours,
  extensions,
  holdBinding,
  mayApply,
} from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { holdsTables } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  TABLE_CELLS_MOST,
  TABLE_DEPTH_MOST,
  closeNested,
  tableRoom,
  tablesIn,
} from '../../src/app/(app)/documents/[id]/table-bounds.ts';

import { MAX_ELEMENT_DEPTH, MAX_STATE_BYTES, elementDepth, pastLimits } from '../../src/lib/collab/state.ts';

const all = extensions(new Y.Doc());
const schema: Schema = closeSchema(getSchema(all));

/** What no editor writes: every type a peer can put into a Yjs attribute, and the edges of each range. */
const HOSTILE: unknown[] = [
  5,
  0,
  -1,
  -3,
  1.5,
  101,
  300000,
  20000000,
  Number.MAX_SAFE_INTEGER,
  Infinity,
  NaN,
  '2',
  '',
  'html',
  'no-such-language',
  '"><script>alert(1)</script>',
  'javascript:alert(1)',
  '﻿https://a/../../../../api/health',
  true,
  null,
  undefined,
  {},
  { a: 1 },
  { toLowerCase: 1, length: 3 },
  [],
  ['https://example.com/'],
  [1e9],
  ['100px;background:url(/api/health)'],
  new Array(1000).fill(25),
];

const ALLOWED: Record<string, Record<string, (value: unknown) => boolean>> = {
  heading: { level: (value) => [1, 2, 3].includes(value as number) },
  orderedList: {
    start: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 9999,
    type: (value) => [null, '1', 'a', 'A', 'i', 'I'].includes(value as string),
  },
  codeBlock: {
    language: (value) => typeof value === 'string' && /^[a-z-]+$/.test(value) && value !== 'html',
  },
  callout: { type: (value) => ['note', 'warning', 'tip'].includes(value as string) },
  tableOfContents: { depth: (value) => [1, 2, 3].includes(value as number) },
  tableCell: {
    colspan: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100,
    rowspan: (value) => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 100,
    colwidth: (value) =>
      value === null ||
      (Array.isArray(value) &&
        value.length <= 100 &&
        value.every((width) => Number.isInteger(width) && width >= 0 && width <= 2000)),
    align: (value) => [null, 'left', 'center', 'right'].includes(value as string),
  },
  link: { href: (value) => value === null || (typeof value === 'string' && /^https:\/\/\S+$/.test(value)) },
};
ALLOWED.tableHeader = ALLOWED.tableCell!;

const types = [
  ...Object.values(schema.nodes).map((type) => ({
    name: type.name,
    attrs: type.spec.attrs ?? {},
    node: true,
  })),
  ...Object.values(schema.marks).map((type) => ({
    name: type.name,
    attrs: type.spec.attrs ?? {},
    node: false,
  })),
];
const attributes = types.flatMap(({ name, attrs, node }) =>
  Object.keys(attrs).map((key) => ({ name, key, node })),
);

/** The attributes the schema gives a node or a mark that is made with these. */
const made = (name: string, node: boolean, given: Record<string, unknown>) =>
  node ? schema.nodes[name]!.create(given).attrs : schema.marks[name]!.create(given).attrs;

describe('the attributes of the schema', () => {
  it('are the ones this test knows, each with a rule', () => {
    expect(attributes.map(({ name, key }) => `${name}.${key}`).sort()).toEqual(
      Object.entries(ALLOWED)
        .flatMap(([name, keys]) => Object.keys(keys).map((key) => `${name}.${key}`))
        .sort(),
    );
    for (const { name, key } of attributes)
      expect(ATTRIBUTE_RULES[name]?.[key], `${name}.${key}`).toBeTypeOf('function');
  });

  it.each(attributes)(
    'the attribute $key of $name holds one of its list, whatever arrives',
    ({ name, key, node }) => {
      for (const value of HOSTILE) {
        const got = made(name, node, { [key]: value, onclick: 'alert(1)', style: 'position:fixed' });
        expect(ALLOWED[name]![key]!(got[key]), `${name}.${key} from ${JSON.stringify(value)}`).toBe(true);
        expect(Object.keys(got).sort()).toEqual(
          Object.keys(schema[node ? 'nodes' : 'marks'][name]!.spec.attrs!).sort(),
        );
      }
    },
  );

  it('gives a value outside its rule the default, and keeps one inside it', () => {
    expect(made('codeBlock', true, { language: 5 }).language).toBe('plaintext');
    expect(made('codeBlock', true, { language: { a: 1 } }).language).toBe('plaintext');
    // An alias of the highlighter is not a language of the selector.
    expect(made('codeBlock', true, { language: 'html' }).language).toBe('plaintext');
    expect(made('codeBlock', true, { language: 'typescript' }).language).toBe('typescript');
    expect(made('tableCell', true, { colspan: 20000000 }).colspan).toBe(1);
    expect(made('tableCell', true, { colspan: 101, rowspan: 0 })).toMatchObject({ colspan: 1, rowspan: 1 });
    expect(made('tableHeader', true, { colspan: 100, rowspan: 2 })).toMatchObject({
      colspan: 100,
      rowspan: 2,
    });
    expect(made('tableCell', true, { colspan: 2, colwidth: [50, 0] }).colwidth).toEqual([50, 0]);
    // One width for each column, or none at all.
    expect(made('tableCell', true, { colspan: 2, colwidth: [50] }).colwidth).toBeNull();
    expect(made('tableCell', true, { colspan: 300000, colwidth: [50, 60] }).colwidth).toBeNull();
    expect(made('tableCell', true, { colwidth: [9999999] }).colwidth).toBeNull();
    expect(made('tableCell', true, { align: 'left;background:url(/x)' }).align).toBeNull();
    expect(made('orderedList', true, { start: 7, type: 'a' })).toMatchObject({ start: 7, type: 'a' });
    expect(made('orderedList', true, { start: 1e9, type: 'z" style="x' })).toMatchObject({
      start: 1,
      type: null,
    });
    expect(made('heading', true, { level: 9 }).level).toBe(1);
    expect(made('heading', true, { level: 3 }).level).toBe(3);
    expect(made('tableOfContents', true, { depth: 99 }).depth).toBe(3);
    expect(made('link', false, { href: 'https://example.com/a' }).href).toBe('https://example.com/a');
    expect(made('link', false, { href: ' https://example.com/a' }).href).toBeNull();
  });

  it('are closed for a node read from JSON, and for one made with content', () => {
    const block = schema.nodeFromJSON({
      type: 'codeBlock',
      attrs: { language: 5 },
      content: [{ type: 'text', text: 'code' }],
    });
    expect(block.attrs.language).toBe('plaintext');
    const cell = schema.node('tableCell', { colspan: 300000 }, [schema.node('paragraph')]);
    expect(cell.attrs.colspan).toBe(1);
    const linked = schema.text('words', [schema.mark('link', { href: 'javascript:alert(1)', onclick: 'x' })]);
    expect(linked.marks[0]!.attrs).toEqual({ href: null });
  });

  it('reach the markup closed too', () => {
    const paragraph = schema.node('paragraph', null, [
      schema.text('words', [schema.mark('link', { href: '﻿https://a/../../../../api/health?x' })]),
    ]);
    const list = schema.node('orderedList', { start: '1" onmouseover="x', type: 'z' }, [
      schema.node('listItem', null, [schema.node('paragraph')]),
    ]);
    const spec = DOMSerializer.fromSchema(schema);
    // No document here: the specification of each element is read as it is.
    expect(JSON.stringify(spec.marks.link!(paragraph.firstChild!.marks[0]!, true))).toContain('"href":""');
    expect(JSON.stringify(spec.nodes.orderedList!(list))).not.toMatch(/onmouseover|"type"|"start"/);
  });

  it('are applied by the editor itself: the extension that closes them is among its extensions', () => {
    expect(all.map((each) => each.name)).toContain('closed');
  });
});

describe('the size of a table', () => {
  const cell = () => schema.node('tableCell', null, [schema.node('paragraph')]);
  const row = (cells: number) => schema.node('tableRow', null, Array.from({ length: cells }, cell));

  const rows = (count: number) => Array.from({ length: count }, () => row(1));

  it('is bounded each way: the type refuses more, and what another client sent is made with the bound', () => {
    expect(TABLE_MOST).toBe(100);
    const { table, tableRow } = schema.nodes;
    expect(() => table!.createChecked(null, rows(TABLE_MOST))).not.toThrow();
    expect(() => table!.createChecked(null, rows(TABLE_MOST + 1))).toThrow();
    expect(() => tableRow!.createChecked(null, Array.from({ length: TABLE_MOST + 1 }, cell))).toThrow();
    // `Schema.node` is how the collaboration binding makes a node (`closeSchema`).
    expect(schema.node('table', null, rows(TABLE_MOST)).childCount).toBe(TABLE_MOST);
    expect(schema.node('table', null, rows(TABLE_MOST + 1)).childCount).toBe(TABLE_MOST);
    expect(row(TABLE_MOST).childCount).toBe(TABLE_MOST);
    expect(row(TABLE_MOST + 1).childCount).toBe(TABLE_MOST);
  });
});

// The second review of pull request 20, finding A: every rule of a cell held,
// and the grid the cells made together was ten thousand columns wide.
describe('the grid of a table', () => {
  type Spans = { colspan?: number; rowspan?: number; colwidth?: number[] };
  const cell = (spans: Spans = {}) => schema.node('tableCell', spans, [schema.node('paragraph')]);
  const tableOf = (grid: Spans[][]) =>
    schema.node(
      'table',
      null,
      grid.map((cells) => schema.node('tableRow', null, cells.map(cell))),
    );
  const spans = (table: PMNode) => {
    const found: [number, number][][] = [];
    table.forEach((each) => {
      const cells: [number, number][] = [];
      each.forEach(({ attrs }) => cells.push([attrs.colspan, attrs.rowspan]));
      found.push(cells);
    });
    return found;
  };
  const every = (rows: number, cells: number, each: Spans) =>
    Array.from({ length: rows }, () => Array.from({ length: cells }, () => each));

  it('keeps the spans of a table that is inside the bound', () => {
    const merged = [
      [{ colspan: 2 }, { rowspan: 2 }],
      [{}, {}],
    ];
    expect(spans(tableOf(merged))).toEqual([
      [
        [2, 1],
        [1, 2],
      ],
      [
        [1, 1],
        [1, 1],
      ],
    ]);
    const map = TableMap.get(tableOf(merged));
    expect([map.width, map.height]).toEqual([3, 2]);
    // The widest there is: one cell across all hundred columns, and down every row.
    expect(spans(tableOf([[{ colspan: 100, rowspan: 2 }], []]))[0]).toEqual([[100, 2]]);
  });

  it('gives a cell that reaches below the last row one row, and leaves the others', () => {
    expect(
      spans(
        tableOf([
          [{ rowspan: 2 }, { rowspan: 3 }, { colspan: 2 }],
          [{ rowspan: 2 }, {}],
        ]),
      ),
    ).toEqual([
      [
        [1, 2],
        [1, 1],
        [2, 1],
      ],
      [
        [1, 1],
        [1, 1],
      ],
    ]);
  });

  it.each([
    [
      'a hundred rows of a hundred cells, each a hundred columns and a hundred rows',
      every(100, 100, { colspan: 100, rowspan: 100 }),
    ],
    ['thirty such rows', every(30, 100, { colspan: 100, rowspan: 100 })],
    ['one row of two cells that are 101 columns between them', [[{ colspan: 100 }, {}]]],
    // No row is too wide by its own cells: the cells above reach down into the second.
    [
      'a row made too wide by the cells that reach down into it',
      [every(1, 60, { rowspan: 2 })[0]!, every(1, 41, {})[0]!],
    ],
  ])('gives every cell one row and one column where the grid is past the bound: %s', (_, grid) => {
    const started = performance.now();
    const table = tableOf(grid);
    expect(new Set(spans(table).flat().map(String))).toEqual(new Set(['1,1']));
    // The table library lays it out: no square is claimed twice, and it is done at once.
    const map = TableMap.get(table);
    expect(map.width).toBeLessThanOrEqual(TABLE_MOST);
    expect(map.height).toBeLessThanOrEqual(TABLE_MOST);
    expect((map as unknown as { problems: unknown[] | null }).problems?.filter(Boolean) ?? []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ type: 'collision' })]),
    );
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('holds wherever a table is made: from JSON and from markup as well', () => {
    const wide = {
      type: 'tableCell',
      attrs: { colspan: 100, rowspan: 100 },
      content: [{ type: 'paragraph' }],
    };
    const json = schema.nodeFromJSON({
      type: 'table',
      content: Array.from({ length: 100 }, () => ({
        type: 'tableRow',
        content: Array.from({ length: 100 }, () => wide),
      })),
    });
    expect(new Set(spans(json).flat().map(String))).toEqual(new Set(['1,1']));
    const { table, tableRow } = schema.nodes;
    const sent = [tableRow!.create(null, [cell({ colspan: 100 }), cell({ colspan: 100 })])];
    for (const made of [
      table!.create(null, sent),
      table!.createChecked(null, sent),
      table!.createAndFill(null, sent)!,
    ]) {
      expect(spans(made)).toEqual([
        [
          [1, 1],
          [1, 1],
        ],
      ]);
    }
  });

  it('takes the widths of a cell whose span was changed, and keeps those of one that was not', () => {
    const table = tableOf([[{ colspan: 100, colwidth: new Array(100).fill(20) }, { colwidth: [30] }]]);
    expect(table.firstChild!.child(0).attrs).toMatchObject({ colspan: 1, colwidth: null });
    expect(table.firstChild!.child(1).attrs).toMatchObject({ colspan: 1, colwidth: [30] });
  });
});

// The owner's decision R32 of 12 October 2026: a cell may hold a table. The
// bounds that the tables then share (table-bounds.ts), wherever one is made.
describe('the tables in the cells of a table (R32)', () => {
  const p = (written = '') => schema.node('paragraph', null, written ? [schema.text(written)] : []);
  const cellOf = (...content: PMNode[]) => schema.node('tableCell', null, content.length ? content : [p()]);
  const rowsOf = (
    rows: number,
    cells: number,
    cell: (row: number, column: number) => PMNode = () => cellOf(),
  ) =>
    Array.from({ length: rows }, (_, row) =>
      schema.node(
        'tableRow',
        null,
        Array.from({ length: cells }, (_, column) => cell(row, column)),
      ),
    );
  const blockOfRows = (rows: PMNode[]) =>
    schema.node('tableBlock', null, [schema.node('table', null, rows), schema.node('tableCaption')]);
  /** The tables of a node, outermost first: the cells each holds itself. */
  const tables = (node: PMNode) => {
    const found: number[] = [];
    node.descendants((each) => {
      if (each.type.name !== 'table') return;
      let cells = 0;
      each.forEach((row) => (cells += row.childCount));
      found.push(cells);
    });
    return found;
  };

  it('are bounded together: ten thousand cells, and two levels', () => {
    expect(TABLE_CELLS_MOST).toBe(10_000);
    expect(TABLE_CELLS_MOST).toBe(TABLE_MOST * TABLE_MOST);
    expect(TABLE_DEPTH_MOST).toBe(2);
  });

  it('keeps a table that is at the bound: a hundred cells, each holding ninety-nine', () => {
    const inner = () => blockOfRows(rowsOf(9, 11));
    const block = blockOfRows(rowsOf(10, 10, () => cellOf(inner())));
    expect(tablesIn(block)).toEqual({ cells: 10_000, levels: 2, past: false });
    expect(tables(block)).toEqual([100, ...Array(100).fill(99)]);
    // And made again from what it holds, it is the same: nothing is left out twice.
    const rows = block.firstChild!.content;
    expect(closeNested(rows)).toBe(rows);
  });

  it('leaves out, one cell past the bound, the row that passes it: the last in the order of the document, whole', () => {
    // The hundredth table has a tenth row, of one cell: 10,001.
    const block = blockOfRows(
      rowsOf(10, 10, (row, column) =>
        cellOf(
          p(`outer ${row}.${column}`),
          blockOfRows(
            row + column === 18
              ? [...rowsOf(9, 11, () => cellOf(p('kept'))), ...rowsOf(1, 1, () => cellOf(p('ONE-PAST')))]
              : rowsOf(9, 11),
          ),
        ),
      ),
    );
    expect(tablesIn(block)).toEqual({ cells: 10_000, levels: 2, past: false });
    expect(tables(block)).toEqual([100, ...Array(100).fill(99)]);
    expect(block.textContent).not.toContain('ONE-PAST');
    expect(block.textContent).toContain('outer 9.9');
    expect(block.textContent.split('kept')).toHaveLength(100);
    block.check();

    // Put in the first table instead, it is counted before the others: the row
    // that passes the bound is the last row of the last table, of eleven cells.
    const first = blockOfRows(
      rowsOf(10, 10, (row, column) =>
        cellOf(
          blockOfRows(
            row + column === 0
              ? [...rowsOf(9, 11), ...rowsOf(1, 1, () => cellOf(p('PUT-FIRST')))]
              : rowsOf(9, 11, (inner) => cellOf(p(row + column === 18 && inner === 8 ? 'LAST-ROW' : ''))),
          ),
        ),
      ),
    );
    expect(first.textContent).toContain('PUT-FIRST');
    expect(first.textContent).not.toContain('LAST-ROW');
    expect(tables(first)).toEqual([100, 100, ...Array(98).fill(99), 88]);
    expect(tablesIn(first).cells).toBe(9_990);
  });

  it('never leaves out a cell of the table itself, and keeps the text of every one', () => {
    // A hundred by a hundred in each cell of a hundred by a hundred: 10^8 cells.
    const hostile = blockOfRows(rowsOf(100, 100));
    const started = performance.now();
    const block = blockOfRows(rowsOf(100, 100, (row, column) => cellOf(p(`o${row}.${column}`), hostile)));
    expect(performance.now() - started).toBeLessThan(2000);
    expect(tables(block)).toEqual([10_000]);
    expect(block.textContent).toContain('o0.0');
    expect(block.textContent).toContain('o99.99');
    block.check();
    // Sixty by sixty with four by four in each: room for four hundred of them, the first in the document.
    const some = blockOfRows(
      rowsOf(60, 60, (row, column) => cellOf(p(`o${row}.${column}`), blockOfRows(rowsOf(4, 4)))),
    );
    expect(tables(some)).toEqual([3600, ...Array(400).fill(16)]);
    expect(some.textContent).toContain('o59.59');
    // The four hundredth is the fortieth of the seventh row, and the next cell holds none.
    expect(tablesIn(some.firstChild!.child(6).child(39)).levels).toBe(1);
    expect(tablesIn(some.firstChild!.child(6).child(40)).levels).toBe(0);
  });

  it('leaves out a table that would stand a level too deep, with its block, and nothing round it', () => {
    const three = blockOfRows(
      rowsOf(1, 2, (_, column) =>
        column === 0
          ? cellOf(p('one'))
          : cellOf(
              blockOfRows(
                rowsOf(1, 2, (_, inner) =>
                  inner === 0
                    ? cellOf(p('two'), blockOfRows(rowsOf(1, 1, () => cellOf(p('THREE')))))
                    : // A cell that held a table and nothing else holds an empty paragraph.
                      cellOf(blockOfRows(rowsOf(2, 2, () => cellOf(p('THREE'))))),
                ),
              ),
            ),
      ),
    );
    expect(tablesIn(three)).toEqual({ cells: 4, levels: 2, past: false });
    expect(three.textContent).toBe('onetwo');
    three.check();
    const emptied = three.firstChild!.firstChild!.child(1).firstChild!.firstChild!.firstChild!.child(1);
    expect(emptied.toString()).toBe('tableCell(paragraph)');

    // Twelve levels, which the limit of the collaboration server alone lets through.
    let deep = blockOfRows(rowsOf(1, 1, () => cellOf(p('level 12'))));
    for (let level = 11; level >= 1; level -= 1) {
      const inner = deep;
      deep = blockOfRows(rowsOf(1, 1, () => cellOf(p(`level ${level}`), inner)));
    }
    expect(tablesIn(deep).levels).toBe(2);
    expect(deep.textContent).toBe('level 1level 2');
  });

  it('counts a table that stands in a quotation or a list in a cell', () => {
    const hidden = (levels: number): PMNode =>
      blockOfRows(
        rowsOf(1, 1, () =>
          levels > 1
            ? cellOf(
                p(`level ${levels}`),
                schema.node('blockquote', null, [
                  schema.node('bulletList', null, [
                    schema.node('listItem', null, [p('item'), hidden(levels - 1)]),
                  ]),
                ]),
              )
            : cellOf(p('level 1')),
        ),
      );
    expect(tablesIn(hidden(2))).toEqual({ cells: 2, levels: 2, past: false });
    const three = hidden(3);
    expect(tablesIn(three).levels).toBe(2);
    // The quotation and the item stay, without the table that was a level too deep.
    expect(three.textContent).toBe('level 3itemlevel 2item');
    three.check();
  });

  it('holds wherever a table is made: by the type, by the schema, and from JSON', () => {
    const { table } = schema.nodes;
    const rows = () => rowsOf(100, 100, () => cellOf(blockOfRows(rowsOf(1, 1))));
    for (const made of [
      table!.create(null, rows()),
      table!.createChecked(null, rows()),
      table!.createAndFill(null, rows())!,
      schema.node('table', null, rows()),
    ]) {
      expect(tablesIn(made)).toEqual({ cells: 10_000, levels: 1, past: false });
    }
    const cell = (content: object[]) => ({ type: 'tableCell', content });
    const nest = (content: object[]) => ({
      type: 'tableBlock',
      content: [
        { type: 'table', content: [{ type: 'tableRow', content: [cell(content)] }] },
        { type: 'tableCaption' },
      ],
    });
    const json = schema.nodeFromJSON(nest([nest([{ type: 'paragraph' }, nest([{ type: 'paragraph' }])])]));
    expect(tables(json)).toEqual([1, 1]);
  });

  it('says what room a place has: the levels left, and the cells left to the outermost table', () => {
    const doc = schema.node('doc', null, [
      p('outside'),
      blockOfRows(
        rowsOf(2, 2, (row, column) => cellOf(p('x'), ...(row + column ? [] : [blockOfRows(rowsOf(3, 3))]))),
      ),
    ]);
    const at = (find: (node: PMNode, pos: number) => boolean) => {
      let found = -1;
      doc.descendants((node, pos) => {
        if (found < 0 && find(node, pos)) found = pos + 1;
      });
      return tableRoom(doc.resolve(found));
    };
    expect(at((node) => node.textContent === 'outside')).toEqual({ cells: 10_000, levels: 2 });
    expect(at((node) => node.type.name === 'paragraph' && node.textContent === 'x')).toEqual({
      cells: 10_000 - 13,
      levels: 1,
    });
    expect(at((node) => node.type.name === 'paragraph' && node.textContent === '')).toEqual({
      cells: 10_000 - 13,
      levels: 0,
    });
  });

  // A step of a transaction copies the nodes round a change and asks the schema nothing.
  describe('and a change of this writer’s', () => {
    const state = (...content: PMNode[]) =>
      EditorState.create({ schema, doc: schema.node('doc', null, content) });
    /** The place inside the first paragraph that holds this text. */
    const inside = (doc: PMNode, written: string) => {
      let found = -1;
      doc.descendants((node, pos) => {
        if (found < 0 && node.type.name === 'paragraph' && node.textContent === written) found = pos + 1;
      });
      return found;
    };

    it('is not applied where it takes a table past the cells, and is applied at the bound', () => {
      // 9,900 cells and a table of 91 in one of them: nine more, and no more.
      const full = state(
        blockOfRows(
          rowsOf(99, 100, (row, column) =>
            row + column === 0 ? cellOf(p('here'), blockOfRows(rowsOf(7, 13))) : cellOf(),
          ),
        ),
      );
      expect(tablesIn(full.doc).cells).toBe(9_991);
      const put = (rows: number, cells: number) =>
        full.tr.insert(inside(full.doc, 'here') + 5, blockOfRows(rowsOf(rows, cells)));
      expect(tablesIn(put(3, 3).doc)).toMatchObject({ cells: 10_000, past: false });
      expect(holdsTables(put(3, 3), full.doc)).toBe(true);
      expect(tablesIn(put(2, 5).doc)).toMatchObject({ cells: 10_001, past: true });
      expect(holdsTables(put(2, 5), full.doc)).toBe(false);
      // What changes no document, and what another client or an undo made, passes.
      expect(holdsTables(full.tr.setMeta('x', 1), full.doc)).toBe(true);
      expect(holdsTables(put(2, 5).setMeta(ySyncPluginKey, { isChangeOrigin: true }), full.doc)).toBe(true);
      expect(holdsTables(put(2, 5).setMeta(ySyncPluginKey, { isChangeOrigin: false }), full.doc)).toBe(false);
    });

    it('is not applied where it puts a table a level too deep', () => {
      const two = state(
        blockOfRows(rowsOf(1, 1, () => cellOf(blockOfRows(rowsOf(1, 1, () => cellOf(p('deep'))))))),
      );
      const third = two.tr.insert(inside(two.doc, 'deep') + 5, blockOfRows(rowsOf(1, 1)));
      expect(tablesIn(third.doc)).toMatchObject({ levels: 3, past: true });
      expect(holdsTables(third, two.doc)).toBe(false);
      expect(holdsTables(two.tr.insertText('typed', inside(two.doc, 'deep')), two.doc)).toBe(true);
    });

    it('is applied in a document that is past a bound already, which can so be written in and deleted from', () => {
      const third = state(
        blockOfRows(rowsOf(1, 1, () => cellOf(blockOfRows(rowsOf(1, 1, () => cellOf(p('deep'))))))),
      ).tr;
      third.insert(inside(third.doc, 'deep') + 5, blockOfRows(rowsOf(1, 1)));
      const past = third.doc;
      expect(tablesIn(past).past).toBe(true);
      const typed = EditorState.create({ schema, doc: past }).tr.insertText('typed', inside(past, 'deep'));
      expect(holdsTables(typed, past)).toBe(true);
    });

    it('is held by the editor itself: the plugin that refuses is among its plugins', () => {
      const two = state(
        blockOfRows(rowsOf(1, 1, () => cellOf(blockOfRows(rowsOf(1, 1, () => cellOf(p('deep'))))))),
      );
      const closed = all.find((each) => each.name === 'closed') as unknown as {
        config: { addProseMirrorPlugins(this: { editor: { isEditable: boolean } }): Plugin[] };
      };
      const [plugin] = closed.config.addProseMirrorPlugins.call({ editor: { isEditable: true } });
      const held = EditorState.create({ schema, doc: two.doc, plugins: [plugin!] });
      const third = held.tr.insert(inside(held.doc, 'deep') + 5, blockOfRows(rowsOf(1, 1)));
      expect(held.applyTransaction(third).transactions).toEqual([]);
      const typed = held.tr.insertText('typed', inside(held.doc, 'deep'));
      expect(held.applyTransaction(typed).state.doc.textContent).toBe('typeddeep');
    });
  });

  // What another client sends, and what a stored document holds.
  describe('and what another client sent', () => {
    const yCell = (...children: (Y.XmlElement | Y.XmlText)[]) => element('tableCell', {}, children);
    const yGrid = (rows: number, cells: number, cell: (row: number, column: number) => Y.XmlElement) =>
      Array.from({ length: rows }, (_, row) =>
        element(
          'tableRow',
          {},
          Array.from({ length: cells }, (_, column) => cell(row, column)),
        ),
      );
    const yCells = (fragment: Y.XmlFragment) => fragment.toString().split('<tablecell').length - 1;
    const writers = () => {
      const document = new Y.Doc();
      document
        .getXmlFragment('default')
        .push([
          blockOf(
            yGrid(60, 60, (row, column) =>
              yCell(paragraph(row + column === 0 ? 'KEEP-THIS' : `w${row}.${column}`)),
            ),
          ),
          paragraph('after'),
        ]);
      return document;
    };
    const cellAt = (fragment: Y.XmlFragment, row: number, column: number) =>
      (((fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement).get(row) as Y.XmlElement).get(
        column,
      ) as Y.XmlElement;

    it('is made inside the bounds, and what is past them is taken out of the shared document: the writer’s text stays', () => {
      const editor = open(writers());
      const peer = peerOf(editor.fragment.doc!);
      // Four by four in each cell of the writer's sixty by sixty: 3,600 + 57,600.
      peer.fragment.doc!.transact(() => {
        for (let row = 0; row < 60; row += 1)
          for (let column = 0; column < 60; column += 1)
            cellAt(peer.fragment, row, column).push([
              blockOf(
                yGrid(4, 4, () => yCell(paragraph('x'))),
                words(''),
              ),
            ]);
      });
      expect(yCells(peer.fragment)).toBe(61_200);
      peer.send();

      expect(editor.unshown).not.toHaveBeenCalled();
      expect(tablesIn(editor.text())).toEqual({ cells: 10_000, levels: 2, past: false });
      expect(yCells(editor.fragment)).toBe(10_000);
      // Every word the writer wrote, in the text and in the shared document.
      for (const written of ['KEEP-THIS', 'w0.1', 'w30.30', 'w59.59', 'after']) {
        expect(editor.text().textContent).toContain(written);
        expect(editor.fragment.toString()).toContain(written);
      }
      expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
      editor.text().check();
      // Not this member's change.
      expect(editor.undo.undoStack).toEqual([]);
    });

    it('is taken out the same by every client, of a document that is opened with it', () => {
      const document = writers();
      const fragment = document.getXmlFragment('default');
      cellAt(fragment, 0, 0).push([
        blockOf([
          element('tableRow', {}, [
            yCell(paragraph('two'), blockOf([element('tableRow', {}, [yCell(paragraph('THREE'))])])),
          ]),
        ]),
      ]);
      const second = new Y.Doc();
      Y.applyUpdate(second, Y.encodeStateAsUpdate(document));
      const [one, two] = [open(document), open(second)];
      Y.applyUpdate(document, Y.encodeStateAsUpdate(second));
      Y.applyUpdate(second, Y.encodeStateAsUpdate(document));
      for (const editor of [one, two]) {
        expect(editor.unshown).not.toHaveBeenCalled();
        expect(tablesIn(editor.text())).toMatchObject({ levels: 2, past: false });
        expect(editor.text().textContent).toContain('KEEP-THIStwo');
        expect(editor.fragment.toString()).not.toContain('THREE');
        expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
      }
      expect(one.fragment.toString()).toBe(two.fragment.toString());
    });
  });
});

// What a client that is no editor puts into a shared document.
const element = (
  name: string,
  attributes: Record<string, unknown> = {},
  children: (Y.XmlElement | Y.XmlText)[] = [],
) => {
  const made = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) made.setAttribute(key, value as string);
  if (children.length > 0) made.insert(0, children);
  return made;
};
const words = (written: string, marks?: Record<string, unknown>) => {
  const made = new Y.XmlText();
  made.insert(0, written, marks);
  return made;
};
const paragraph = (written: string, marks?: Record<string, unknown>) =>
  element('paragraph', {}, [words(written, marks)]);
const rowOf = (...cells: string[]) =>
  element(
    'tableRow',
    {},
    cells.map((written) => element('tableCell', {}, [paragraph(written)])),
  );
const blockOf = (rows: Y.XmlElement[], caption = words('caption')) =>
  element('tableBlock', {}, [element('table', {}, rows), element('tableCaption', {}, [caption])]);

/**
 * The collaboration binding on a shared document, held as the editor holds it
 * (`holdBinding`), with what stands in for the view: the state, and the way a
 * transaction reaches it. No page is needed for what is tested here.
 */
function open(document: Y.Doc) {
  const fragment = document.getXmlFragment('default');
  let state = EditorState.create({ schema, plugins: [ySyncPlugin(fragment)] });
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      state = state.apply(transaction);
    },
    hasFocus: () => false,
  };
  const unshown = vi.fn();
  const { binding } = ySyncPluginKey.getState(state) as { binding: ProsemirrorBinding };
  holdBinding(view as never, unshown);
  // As the plugin of the binding starts it (@tiptap/y-tiptap, `ySyncPlugin`, `view`).
  binding.initView(view);
  binding._forceRerender();
  // The history of undo, as the editor's plugin makes it: what the binding writes is tracked.
  const undo = new Y.UndoManager(fragment, { trackedOrigins: new Set([ySyncPluginKey]) });
  return { fragment, binding, unshown, undo, text: () => state.doc, typed: () => view };
}

/** Another client of the same document, and the way its changes arrive. */
function peerOf(document: Y.Doc) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
  return {
    fragment: peer.getXmlFragment('default'),
    send: () => Y.applyUpdate(document, Y.encodeStateAsUpdate(peer), 'peer'),
  };
}
const names = (parent: Y.XmlFragment) =>
  parent.toArray().map((each) => (each as Y.XmlElement).nodeName ?? 'text');

// Finding C of the second review: one paragraph put under a member's table by
// another client, and every client that opened the document deleted the table.
describe('what another client sent that the schema cannot hold', () => {
  function tableAndAfter() {
    const document = new Y.Doc();
    document
      .getXmlFragment('default')
      .push([blockOf([rowOf('one', 'two'), rowOf('three', 'KEEP-THIS')]), paragraph('after')]);
    return document;
  }
  const tableIn = (fragment: Y.XmlFragment) => (fragment.get(0) as Y.XmlElement).get(0) as Y.XmlElement;

  it('is taken out alone: the node it was put in stays, in the text and in the shared document', () => {
    const editor = open(tableAndAfter());
    const peer = peerOf(editor.fragment.doc!);
    const table = tableIn(peer.fragment);
    table.insert(table.length, [paragraph('not a row')]);
    peer.send();

    expect(names(editor.fragment)).toEqual(['tableBlock', 'paragraph']);
    expect(names(tableIn(editor.fragment))).toEqual(['tableRow', 'tableRow']);
    expect(editor.fragment.toString()).toContain('KEEP-THIS');
    expect(editor.fragment.toString()).not.toContain('not a row');
    expect(editor.text().firstChild!.type.name).toBe('tableBlock');
    expect(editor.text().textContent).toBe('onetwothreeKEEP-THIScaptionafter');
    // The text and the shared document hold the same again, which the binding counts places by.
    expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
    expect(editor.unshown).not.toHaveBeenCalled();
  });

  it('is not this member’s change: nothing of it is in the history of undo', () => {
    const editor = open(tableAndAfter());
    const peer = peerOf(editor.fragment.doc!);
    tableIn(peer.fragment).insert(0, [paragraph('not a row'), element('noSuchNode', {}, [words('x')])]);
    peer.send();
    expect(names(tableIn(editor.fragment))).toEqual(['tableRow', 'tableRow']);
    expect(editor.undo.undoStack).toEqual([]);
    editor.undo.undo();
    expect(editor.fragment.toString()).toContain('KEEP-THIS');
  });

  it('is taken out of a document that is opened with it, and the same by every client', () => {
    const document = tableAndAfter();
    const table = tableIn(document.getXmlFragment('default'));
    table.insert(1, [paragraph('not a row')]);
    const second = new Y.Doc();
    Y.applyUpdate(second, Y.encodeStateAsUpdate(document));
    const [one, two] = [open(document), open(second)];
    Y.applyUpdate(document, Y.encodeStateAsUpdate(second));
    Y.applyUpdate(second, Y.encodeStateAsUpdate(document));
    for (const editor of [one, two]) {
      expect(names(tableIn(editor.fragment))).toEqual(['tableRow', 'tableRow']);
      expect(editor.text().textContent).toBe('onetwothreeKEEP-THIScaptionafter');
    }
  });

  it.each<[string, (fragment: Y.XmlFragment) => void, string]>([
    [
      'a node of no type',
      (fragment) => fragment.insert(1, [element('noSuchNode', {}, [words('gone')])]),
      'onetwothreeKEEP-THIScaptionafter',
    ],
    [
      'a mark of no type, on text that stays',
      (fragment) => (fragment.get(1) as Y.XmlElement).insert(1, [words(' marked', { noSuchMark: { a: 1 } })]),
      'onetwothreeKEEP-THIScaptionafter marked',
    ],
    [
      'a mark where none is taken: the caption stays, and so does its table',
      (fragment) =>
        ((fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement).insert(1, [
          words(' bold', { bold: true }),
        ]),
      'onetwothreeKEEP-THIScaption boldafter',
    ],
    [
      'what is no text, in a text',
      (fragment) => ((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText).insertEmbed(0, { a: 1 }),
      'onetwothreeKEEP-THIScaptionafter',
    ],
    [
      'a second caption',
      (fragment) => (fragment.get(0) as Y.XmlElement).push([element('tableCaption', {}, [words('second')])]),
      'onetwothreeKEEP-THIScaptionafter',
    ],
  ])('holds for %s', (_, change, text) => {
    const editor = open(tableAndAfter());
    const peer = peerOf(editor.fragment.doc!);
    change(peer.fragment);
    peer.send();
    expect(names(editor.fragment)).toEqual(['tableBlock', 'paragraph']);
    expect(editor.text().textContent).toBe(text);
    expect(editor.text().check()).toBeUndefined();
    expect(editor.undo.undoStack).toEqual([]);
    expect(editor.unshown).not.toHaveBeenCalled();
  });

  // Two members each add a row to a table of 99 at once: neither did anything wrong.
  it('keeps a table that two honest changes took one row past the bound, without the last row', () => {
    const document = new Y.Doc();
    document
      .getXmlFragment('default')
      .push([blockOf(Array.from({ length: 99 }, (_, at) => rowOf(`r${at}`)))]);
    const editor = open(document);
    const [first, second] = [peerOf(document), peerOf(document)];
    tableIn(first.fragment).push([rowOf('first')]);
    tableIn(second.fragment).push([rowOf('second')]);
    first.send();
    second.send();
    expect(names(editor.fragment)).toEqual(['tableBlock']);
    expect(tableIn(editor.fragment).length).toBe(TABLE_MOST);
    expect(editor.text().firstChild!.firstChild!.childCount).toBe(TABLE_MOST);
    expect(editor.text().textContent).toContain('r98');
    expect(editor.undo.undoStack).toEqual([]);
  });

  // WHICH child goes (the third review, 12 October 2026): the one that is past
  // the bound in the order of the document, which every client holds alike.
  // Not the newest: a shared document holds no time (`closeSchema` says why).
  describe('and where there is one too many, the last in the order of the document', () => {
    const full = (rows: number) => {
      const document = new Y.Doc();
      document.clientID = 50;
      document
        .getXmlFragment('default')
        .push([blockOf(Array.from({ length: rows }, (_, at) => rowOf(`r${at}`)))]);
      return document;
    };
    /** A member of the document under a client number of its own, with an editor open. */
    const member = (document: Y.Doc, client: number) => {
      const copy = new Y.Doc();
      copy.clientID = client;
      Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
      return open(copy);
    };
    const exchange = (...editors: ReturnType<typeof open>[]) => {
      // Twice round: what one mends reaches the others.
      for (let round = 0; round < 2; round += 1)
        for (const from of editors)
          for (const to of editors)
            if (from !== to)
              Y.applyUpdate(to.fragment.doc!, Y.encodeStateAsUpdate(from.fragment.doc!), 'peer');
    };
    const rows = (editor: ReturnType<typeof open>) =>
      tableIn(editor.fragment)
        .toArray()
        .map((row) => row.toString().replace(/<[^>]+>/g, ''));

    it('of two honest members who each add a row to 99 at once, the row of the higher client number goes, in every browser', () => {
      const document = full(99);
      const [low, high, watching] = [member(document, 7), member(document, 9), member(document, 8)];
      tableIn(low.fragment).push([rowOf('of-seven')]);
      tableIn(high.fragment).push([rowOf('of-nine')]);
      exchange(low, high, watching);
      // Yjs puts two things written at one place in the order of their clients'
      // numbers, so the row of 9 stands after the row of 7, and is the 101st.
      for (const editor of [low, high, watching]) {
        expect(rows(editor)).toHaveLength(TABLE_MOST);
        expect(rows(editor).slice(-2)).toEqual(['r98', 'of-seven']);
        expect(editor.text().textContent).not.toContain('of-nine');
        expect(editor.unshown).not.toHaveBeenCalled();
      }
      // The three shared documents are one document.
      expect(new Set([low, high, watching].map((editor) => editor.fragment.toString())).size).toBe(1);
      // Whichever way the two arrive.
      const [first, second] = [member(document, 9), member(document, 7)];
      tableIn(first.fragment).push([rowOf('of-nine')]);
      tableIn(second.fragment).push([rowOf('of-seven')]);
      exchange(second, first);
      expect(rows(first)).toEqual(rows(low));
      expect(rows(second)).toEqual(rows(low));
    });

    // Known, and left: what is past the bound is what stands last, whoever put what where.
    it('a row put at the top of a full table costs the row at the bottom, and a table put before the table costs the table', () => {
      const editor = open(full(100));
      const peer = peerOf(editor.fragment.doc!);
      tableIn(peer.fragment).insert(0, [rowOf('put-at-the-top')]);
      peer.send();
      expect(rows(editor)).toHaveLength(TABLE_MOST);
      expect(rows(editor)[0]).toBe('put-at-the-top');
      expect(rows(editor).at(-1)).toBe('r98');
      expect(editor.undo.undoStack).toEqual([]);

      const two = open(tableAndAfter());
      const other = peerOf(two.fragment.doc!);
      (other.fragment.get(0) as Y.XmlElement).insert(0, [element('table', {}, [rowOf('put-before')])]);
      other.send();
      expect(names(two.fragment.get(0) as Y.XmlElement)).toEqual(['table', 'tableCaption']);
      expect(two.text().textContent).toBe('put-beforecaptionafter');
    });
  });

  // What stands directly in the document where it cannot (the third review):
  // the library makes the document itself without asking the schema.
  describe('directly in the document', () => {
    const twoParagraphs = () => {
      const document = new Y.Doc();
      document.getXmlFragment('default').push([paragraph('before'), paragraph('KEEP-THIS')]);
      return document;
    };
    const STRAYS: [string, () => Y.XmlElement | Y.XmlText][] = [
      ['a row without a table', () => rowOf('stray')],
      ['a cell without a row', () => element('tableCell', {}, [paragraph('stray')])],
      ['a table without its block', () => element('table', {}, [rowOf('stray')])],
      ['a caption without a table', () => element('tableCaption', {}, [words('stray')])],
      ['an item without a list', () => element('listItem', {}, [paragraph('stray')])],
      ['text', () => words('stray')],
      ['a node of no type', () => element('noSuchNode', {}, [words('stray')])],
    ];

    it.each(STRAYS)('%s is taken out alone, and the page stays', (_, stray) => {
      const editor = open(twoParagraphs());
      const peer = peerOf(editor.fragment.doc!);
      peer.fragment.insert(1, [stray()]);
      expect(() => peer.send()).not.toThrow();
      expect(editor.unshown).not.toHaveBeenCalled();
      // The neighbours stand, and the shared document and the text hold the same.
      expect(names(editor.fragment)).toEqual(['paragraph', 'paragraph']);
      expect(editor.text().textContent).toBe('beforeKEEP-THIS');
      expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);

      // It is not this member's change. What the member types next is, and
      // undoing that brings nothing of the stray back.
      expect(editor.undo.undoStack).toEqual([]);
      const view = editor.typed();
      view.dispatch(view.state.tr.insertText('typed ', 1));
      editor.binding._prosemirrorChanged(view.state.doc);
      expect(editor.fragment.toString()).toContain('typed before');
      expect(editor.undo.undoStack).toHaveLength(1);
      editor.undo.undo();
      expect(names(editor.fragment)).toEqual(['paragraph', 'paragraph']);
      expect(editor.fragment.toString()).not.toContain('stray');
      expect(editor.fragment.toString()).toContain('KEEP-THIS');
    });

    it.each(STRAYS)(
      '%s is taken out of a document that is opened with it, the same by every client',
      (_, stray) => {
        const document = twoParagraphs();
        document.getXmlFragment('default').insert(0, [stray()]);
        document.getXmlFragment('default').push([stray()]);
        const second = new Y.Doc();
        Y.applyUpdate(second, Y.encodeStateAsUpdate(document));
        const [one, two] = [open(document), open(second)];
        Y.applyUpdate(document, Y.encodeStateAsUpdate(second));
        Y.applyUpdate(second, Y.encodeStateAsUpdate(document));
        for (const editor of [one, two]) {
          expect(editor.unshown).not.toHaveBeenCalled();
          expect(names(editor.fragment)).toEqual(['paragraph', 'paragraph']);
          expect(editor.text().textContent).toBe('beforeKEEP-THIS');
        }
      },
    );

    it('nothing but strays leaves a document that can be written in', () => {
      const document = new Y.Doc();
      document.getXmlFragment('default').push([words('stray'), rowOf('stray')]);
      const editor = open(document);
      expect(editor.unshown).not.toHaveBeenCalled();
      expect(names(editor.fragment)).toEqual([]);
      expect(editor.text().toString()).toBe('doc(paragraph)');
    });
  });
});

// Finding B of the second review, in the browser's half: quotes nested ten
// thousand deep were a fault of every page that opened the document.
describe('a shared document that cannot be built', () => {
  const DEPTH = 10_000;
  const nest = (fragment: Y.XmlFragment) =>
    fragment.doc!.transact(() => {
      let parent: Y.XmlFragment = fragment;
      for (let level = 0; level < DEPTH; level += 1) {
        const quote = new Y.XmlElement('blockquote');
        parent.insert(parent === fragment ? fragment.length : 0, [quote]);
        parent = quote;
      }
      parent.insert(0, [paragraph('deep')]);
    });
  const held = (document: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');

  it('is said once where the document is opened, and nothing is written to it', () => {
    const document = new Y.Doc();
    document.getXmlFragment('default').push([paragraph('written before')]);
    nest(document.getXmlFragment('default'));
    const before = held(document);
    let editor!: ReturnType<typeof open>;
    expect(() => (editor = open(document))).not.toThrow();
    expect(editor.unshown).toHaveBeenCalledTimes(1);
    expect(held(document)).toBe(before);
  });

  it('is said once where it arrives in an open document, and the text that is left is never written back', () => {
    const document = new Y.Doc();
    document.getXmlFragment('default').push([paragraph('written before')]);
    const editor = open(document);
    expect(editor.text().textContent).toBe('written before');
    const peer = peerOf(document);
    nest(peer.fragment);
    peer.fragment.push([paragraph('written by another')]);
    expect(() => peer.send()).not.toThrow();
    expect(editor.unshown).toHaveBeenCalledTimes(1);

    // The text is the one from before, and is no longer the document's: what
    // the binding would write of it is the deletion of everything that arrived.
    const before = held(document);
    expect(editor.text().textContent).toBe('written before');
    editor.binding._prosemirrorChanged(editor.text());
    editor.binding._forceRerender();
    expect(held(document)).toBe(before);
    // What arrives afterwards arrives, and is no second fault.
    peer.fragment.push([paragraph('and again')]);
    expect(() => peer.send()).not.toThrow();
    expect(names(editor.fragment)).toEqual(['paragraph', 'blockquote', 'paragraph', 'paragraph']);
    expect(editor.unshown).toHaveBeenCalledTimes(1);
    expect(editor.undo.undoStack).toEqual([]);
  });
});

// The limits of a document that the collaboration server holds an update to
// (src/lib/collab/state.ts), measured on what this schema writes.
describe('the limits of a document', () => {
  type Json = { type: string; content?: Json[]; text?: string };
  const p: Json = { type: 'paragraph', content: [{ type: 'text', text: 'words' }] };
  /** A list `levels` deep: each item a paragraph and the next list. */
  const list = (levels: number, type = 'bulletList'): Json => ({
    type,
    content: [{ type: 'listItem', content: levels > 1 ? [p, list(levels - 1, type)] : [p] }],
  });
  const quote = (...content: Json[]): Json => ({ type: 'blockquote', content });
  const inCell = (...content: Json[]): Json => ({
    type: 'tableBlock',
    content: [
      { type: 'table', content: [{ type: 'tableRow', content: [{ type: 'tableCell', content }] }] },
      { type: 'tableCaption' },
    ],
  });
  const depthOf = (...content: Json[]) =>
    elementDepth(prosemirrorJSONToYDoc(schema, { type: 'doc', content }, 'default'));

  it('are 5 MB and 50 levels', () => {
    expect(MAX_STATE_BYTES).toBe(5 * 1024 * 1024);
    expect(MAX_ELEMENT_DEPTH).toBe(50);
  });

  // How deep honest writing is, so that the margin can be seen.
  it.each<[string, Json, number]>([
    ['a paragraph', p, 1],
    ['a paragraph in a quote', quote(p), 2],
    ['a callout', { type: 'callout', content: [p] }, 2],
    ['a list of one level', list(1), 3],
    ['a list of ten levels', list(10), 21],
    ['a numbered list of ten levels in a quote', quote(list(10, 'orderedList')), 22],
    ['a table', inCell(p), 5],
    // R32: each level of table is four elements.
    ['a table in a cell of a table', inCell(inCell(p)), 9],
    ['the deepest list in a cell of a table in a cell of a table', inCell(inCell(list(20))), 49],
    ['a list of ten levels in a quote in a cell of a table', inCell(quote(list(10))), 26],
    ['the deepest list there is room for', list(24), 49],
    ['the deepest list in a cell of a table', inCell(list(22)), 49],
  ])('counts the real depth of %s', (_, block, depth) => {
    expect(depthOf(block)).toBe(depth);
    expect(depth).toBeLessThanOrEqual(MAX_ELEMENT_DEPTH);
  });

  it('counts a list of 25 levels as past the limit, and is the depth of the deepest block', () => {
    expect(depthOf(list(25))).toBe(51);
    expect(depthOf(p, list(3), quote(p))).toBe(7);
    expect(elementDepth(new Y.Doc())).toBe(0);
  });

  it('counts without calling itself, however deep, and counts what hangs from an attribute', () => {
    const document = new Y.Doc();
    document.transact(() => {
      let parent: Y.XmlFragment = document.getXmlFragment('default');
      for (let level = 0; level < 100_000; level += 1) {
        const quoted = new Y.XmlElement('blockquote');
        parent.insert(0, [quoted]);
        parent = quoted;
      }
    });
    expect(elementDepth(document)).toBe(100_000);

    const hidden = new Y.Doc();
    const held = new Y.XmlElement('paragraph');
    hidden.getXmlFragment('default').insert(0, [held]);
    let map = new Y.Map();
    held.setAttribute('x', map as never);
    for (let level = 0; level < 60; level += 1) {
      const next = new Y.Map();
      map.set('x', next);
      map = next;
    }
    expect(elementDepth(hidden)).toBe(62);
    // What was deleted is no longer a level.
    hidden.getXmlFragment('default').delete(0, 1);
    expect(elementDepth(hidden)).toBe(0);
  });

  it('refuses the update that takes a document past a limit, and no other', () => {
    const made = (...content: Json[]) => prosemirrorJSONToYDoc(schema, { type: 'doc', content }, 'default');
    const update = (document: Y.Doc) => Y.encodeStateAsUpdate(document);
    expect(pastLimits(new Y.Doc(), update(made(list(24))))).toBe(false);
    expect(pastLimits(new Y.Doc(), update(made(list(25))))).toBe(true);
    expect(pastLimits(made(p), update(made(list(25))))).toBe(true);

    const text = (bytes: number) => {
      const document = new Y.Doc();
      // One client always: the identifier is written into the state, in as many bytes as it needs.
      document.clientID = 1;
      document.getText('t').insert(0, 'x'.repeat(bytes));
      return document;
    };
    const room = MAX_STATE_BYTES - update(text(0)).byteLength;
    // To the byte: the largest state there is, and one byte more.
    let most = room;
    while (update(text(most)).byteLength > MAX_STATE_BYTES) most -= 1;
    expect(update(text(most)).byteLength).toBe(MAX_STATE_BYTES);
    expect(pastLimits(new Y.Doc(), update(text(most)))).toBe(false);
    expect(pastLimits(new Y.Doc(), update(text(most + 1)))).toBe(true);
    // On top of what is there.
    expect(pastLimits(text(3 * 1024 * 1024), update(made(p)))).toBe(false);
    const three = new Y.Doc();
    three.getText('other').insert(0, 'y'.repeat(3 * 1024 * 1024));
    expect(pastLimits(text(3 * 1024 * 1024), update(three))).toBe(true);
  });

  it('takes, of a document that is past a limit already, what does not take it further', () => {
    const deep = prosemirrorJSONToYDoc(schema, { type: 'doc', content: [list(30), p] }, 'default');
    expect(elementDepth(deep)).toBe(61);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(deep));
    const before = Y.encodeStateVector(peer);
    const fragment = peer.getXmlFragment('default');
    ((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlText).insert(0, 'more ');
    expect(pastLimits(deep, Y.encodeStateAsUpdate(peer, before))).toBe(false);
    fragment.delete(0, 1);
    expect(pastLimits(deep, Y.encodeStateAsUpdate(peer, before))).toBe(false);
    // And one level more, in the same place, is refused.
    const deeper = new Y.Doc();
    Y.applyUpdate(deeper, Y.encodeStateAsUpdate(deep));
    let innermost = deeper.getXmlFragment('default').get(0) as Y.XmlElement;
    for (;;) {
      const last = innermost.get(innermost.length - 1);
      if (!(last instanceof Y.XmlElement)) break;
      innermost = last;
    }
    innermost.insert(innermost.length, [new Y.XmlElement('hardBreak')]);
    expect(pastLimits(deep, Y.encodeStateAsUpdate(deeper, before))).toBe(true);
  });
});

describe('a change to a document that cannot be edited now (FR-ED-18)', () => {
  const state = EditorState.create({ schema });
  const typed = () => state.tr.insertText('typed');

  it('is not applied, whichever control or command made it', () => {
    expect(mayApply(typed(), false)).toBe(false);
    expect(mayApply(typed().setMeta(ySyncPluginKey, { isChangeOrigin: false }), false)).toBe(false);
  });

  it('is applied while the document can be edited', () => {
    expect(mayApply(typed(), true)).toBe(true);
  });

  it('is applied where it is another client’s, and a transaction that changes nothing always is', () => {
    expect(mayApply(typed().setMeta(ySyncPluginKey, { isChangeOrigin: true }), false)).toBe(true);
    expect(mayApply(state.tr, false)).toBe(true);
  });
});

// The third review: a megabyte of code was a second and a half at each
// keystroke, every block of the document being coloured again each time.
describe('the colours of a code block', () => {
  const code = 'const a = "b" + 1; // c\n'.repeat(3000).slice(0, CODE_COLOURS_MOST);

  it('are given to a block of 50,000 characters, and to none that is longer', () => {
    expect(CODE_COLOURS_MOST).toBe(50_000);
    expect(code).toHaveLength(CODE_COLOURS_MOST);
    expect(codeColours.highlight('javascript', code).children.length).toBeGreaterThan(5000);
    expect(codeColours.highlight('javascript', `${code}x`).children).toEqual([]);
    // And where the block names no language the library knows.
    expect(codeColours.highlightAuto(code).children.length).toBeGreaterThan(1000);
    expect(codeColours.highlightAuto(`${code}x`).children).toEqual([]);
  });

  it('are asked of the bounded colourer by the editor’s own code block, which lists the languages as before', () => {
    const block = all.find((each) => each.name === 'codeBlock') as {
      options: { lowlight: typeof codeColours };
    };
    // The library copies its options: the two functions are the ones it was given.
    expect(block.options.lowlight.highlight).toBe(codeColours.highlight);
    expect(block.options.lowlight.highlightAuto).toBe(codeColours.highlightAuto);
    expect(codeColours.listLanguages()).toContain('typescript');
    expect(codeColours.registered('javascript')).toBe(true);
  });
});
