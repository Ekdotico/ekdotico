// The schema of a document as the sanitiser of what arrives (NFR-SE-06, A03):
// every attribute of every node and mark has one rule, and the schema applies
// it wherever a node or a mark is made, so that no plugin, node view or
// rendering is handed a value another client chose freely.
import { getSchema } from '@tiptap/core';
import { DOMSerializer, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection, type Plugin, type Transaction } from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import {
  prosemirrorJSONToYDoc,
  ySyncPlugin,
  ySyncPluginKey,
  yXmlFragmentToProseMirrorRootNode,
  type ProsemirrorBinding,
} from '@tiptap/y-tiptap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  ATTRIBUTE_RULES,
  TABLE_MOST,
  closeSchema,
  arrives,
  extensions,
  followShared,
  holdBinding,
  mayApply,
  shownCopy,
  shownOf,
} from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { DOCUMENT_BYTES_MOST } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import {
  TABLE_NO_ROOM,
  TABLE_PASTE_NO_ROOM,
  countsOf,
  limitRefusal,
  overLimits,
} from '../../src/app/(app)/documents/[id]/block-limits.ts';
import { LIMITS, shapeOf } from '../../src/lib/collab/shape.ts';
import {
  TABLE_CELLS_MOST,
  TABLE_COUNT_MOST,
  tableCount,
  TABLE_DEPTH_MOST,
  closeNested,
  tableRoom,
  tablesIn,
} from '../../src/app/(app)/documents/[id]/table-bounds.ts';

import { MAX_ELEMENT_DEPTH, MAX_STATE_BYTES, elementDepth, pastLimits } from '../../src/lib/collab/state.ts';

const all = extensions(new Y.Doc());
const schema: Schema = closeSchema(getSchema(all));
/** Whether a transaction is applied for the bounds of tables and the limits of a document (./block-limits.ts). */
const holdsTables = (transaction: Transaction, before: PMNode) => limitRefusal(transaction, before) === null;

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
  // FR-ED-08: written out here and not taken from src/lib/images/node.ts, so that a change to it is seen.
  image: {
    id: (value) => value === null || (typeof value === 'string' && /^c[a-z0-9]{24}$/.test(value)),
    alt: (value) => typeof value === 'string' && value.length <= 1000,
    caption: (value) => typeof value === 'string' && value.length <= 500,
    width: (value) => Number.isInteger(value) && (value as number) >= 10 && (value as number) <= 100,
  },
  // FR-ED-05: written out here and not taken from src/lib/footnotes/node.ts, so that a change to it is seen.
  footnoteReference: {
    id: (value) => value === null || (typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)),
  },
  footnote: {
    id: (value) => value === null || (typeof value === 'string' && /^[0-9a-f]{24}$/.test(value)),
  },
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
    // FR-ED-05: an identifier is 24 characters of 0-9a-f, and nothing else is one.
    const id = '0123456789abcdef01234567';
    for (const name of ['footnoteReference', 'footnote']) {
      expect(made(name, true, { id }).id).toBe(id);
      for (const bad of [
        id.toUpperCase(),
        id.slice(1),
        `${id}0`,
        `${id}\n`,
        'https://example.com/x',
        '../../api',
        7,
        {},
      ])
        expect(made(name, true, { id: bad }).id, JSON.stringify(bad)).toBeNull();
    }
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
    const table = tableOf(grid);
    expect(new Set(spans(table).flat().map(String))).toEqual(new Set(['1,1']));
    // The table library lays it out: no square is claimed twice.
    const map = TableMap.get(table);
    expect(map.width).toBeLessThanOrEqual(TABLE_MOST);
    expect(map.height).toBeLessThanOrEqual(TABLE_MOST);
    expect((map as unknown as { problems: unknown[] | null }).problems?.filter(Boolean) ?? []).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ type: 'collision' })]),
    );
    // The work is held, and not the time: the library keeps one square for each place of the grid, and no more.
    expect((map as unknown as { map: number[] }).map.length).toBe(map.width * map.height);
    expect(map.width * map.height).toBeLessThanOrEqual(TABLE_MOST * TABLE_MOST);
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
    // The work is held, and not the time: the tables are made once each, the
    // one that is in every cell and the one that holds them, and not once for each cell.
    const made = vi.spyOn(schema.nodes.table!, 'create');
    const block = blockOfRows(rowsOf(100, 100, (row, column) => cellOf(p(`o${row}.${column}`), hostile)));
    expect(made.mock.calls.length).toBeLessThanOrEqual(2);
    made.mockRestore();
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

  // The review of pull request 28, S1: a header cell is a cell of another type.
  it('counts a header cell as a cell, in a table and in the tables in its cells', () => {
    const head = (...content: PMNode[]) => schema.node('tableHeader', null, content.length ? content : [p()]);
    // Header cells throughout: a hundred, each holding ninety-nine; and one row more in the last.
    const block = (more: boolean) =>
      blockOfRows(
        rowsOf(10, 10, (row, column) =>
          head(
            blockOfRows([
              ...rowsOf(9, 11, () => head()),
              ...(more && row + column === 18 ? rowsOf(1, 1, () => head(p('ONE-PAST'))) : []),
            ]),
          ),
        ),
      );
    expect(tablesIn(block(false))).toEqual({ cells: 10_000, levels: 2, past: false });
    expect(tablesIn(block(true))).toEqual({ cells: 10_000, levels: 2, past: false });
    expect(block(true).textContent).toBe('');
    // And the room a place has is less by each of them.
    const doc = schema.node('doc', null, [blockOfRows(rowsOf(2, 3, () => head(p('x'))))]);
    expect(tableRoom(doc.resolve(6))).toEqual({ cells: 10_000 - 6, levels: 1 });
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
      const { plugin } = closedPlugin();
      const held = EditorState.create({ schema, doc: two.doc, plugins: [plugin] });
      const third = held.tr.insert(inside(held.doc, 'deep') + 5, blockOfRows(rowsOf(1, 1)));
      expect(held.applyTransaction(third).transactions).toEqual([]);
      const typed = held.tr.insertText('typed', inside(held.doc, 'deep'));
      expect(held.applyTransaction(typed).state.doc.textContent).toBe('typeddeep');
    });

    /** The plugin of the editor that refuses, as the editor makes it, and what it tells of a refusal. */
    function closedPlugin() {
      const closed = all.find((each) => each.name === 'closed') as unknown as {
        config: {
          addProseMirrorPlugins(this: {
            editor: { isEditable: boolean };
            options: { noRoom(words: string | null): void };
          }): Plugin[];
        };
      };
      const noRoom = vi.fn();
      const [plugin] = closed.config.addProseMirrorPlugins.call({
        editor: { isEditable: true },
        options: { noRoom },
      });
      return { plugin: plugin!, noRoom };
    }

    // The review of pull request 28, S5: a refusal said nothing (WCAG 3.3.1, 4.1.3).
    // And the re-review, finding d: the words outlived their cause, and a second refusal was not heard.
    it('is said to be refused each time it is, until the document next changes, whoever changes it; a repair and another client’s change say nothing', () => {
      const W = TABLE_NO_ROOM;
      const { plugin, noRoom } = closedPlugin();
      let held = EditorState.create({
        schema,
        doc: state(
          blockOfRows(rowsOf(1, 1, () => cellOf(blockOfRows(rowsOf(1, 1, () => cellOf(p('deep'))))))),
        ).doc,
        plugins: [plugin],
      });
      // After the one paragraph that holds text, whatever it holds by now.
      const third = () =>
        held.tr.insert(
          inside(held.doc, held.doc.textContent) + held.doc.textContent.length + 1,
          blockOfRows(rowsOf(1, 1)),
        );
      // What a plugin appends, as the table library's repair is, and what the binding brings.
      held.applyTransaction(third().setMeta('appendedTransaction', held.tr));
      held.applyTransaction(third().setMeta(ySyncPluginKey, { isChangeOrigin: false }));
      held = held.applyTransaction(third().setMeta(ySyncPluginKey, { isChangeOrigin: true })).state;
      expect(tablesIn(held.doc).past).toBe(true);
      expect(noRoom).not.toHaveBeenCalled();

      held = EditorState.create({
        schema,
        doc: state(
          blockOfRows(rowsOf(1, 1, () => cellOf(blockOfRows(rowsOf(1, 1, () => cellOf(p('deep'))))))),
        ).doc,
        plugins: [plugin],
      });
      // The writer's own: said at each refusal, so that the second is heard as the first was.
      for (let asked = 0; asked < 3; asked += 1) held.applyTransaction(third());
      expect(noRoom.mock.calls).toEqual([[W], [W], [W]]);
      // A move of the cursor is no change to the document, and the words stay.
      held = held.applyTransaction(held.tr.setSelection(TextSelection.create(held.doc, 1))).state;
      // A repair that is refused meanwhile says nothing, and takes nothing back.
      held.applyTransaction(third().setMeta('appendedTransaction', held.tr));
      expect(noRoom.mock.calls).toEqual([[W], [W], [W]]);
      // The next change the writer makes takes the words away, once.
      held = held.applyTransaction(held.tr.insertText('typed', inside(held.doc, 'deep'))).state;
      held = held.applyTransaction(held.tr.insertText('more', inside(held.doc, 'typeddeep'))).state;
      expect(noRoom.mock.calls).toEqual([[W], [W], [W], [null]]);

      // And so does a change that is not the writer's: another client's, or
      // the writer's own undo, both of which the binding brings; and one that
      // a plugin appends.
      for (const [meta, value] of [
        [ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: false }],
        [ySyncPluginKey, { isChangeOrigin: true, isUndoRedoOperation: true }],
        ['appendedTransaction', held.tr],
      ] as const) {
        noRoom.mockClear();
        held.applyTransaction(third());
        held = held.applyTransaction(
          held.tr.insertText('x', inside(held.doc, held.doc.textContent)).setMeta(meta, value),
        ).state;
        expect(noRoom.mock.calls).toEqual([[W], [null]]);
      }
    });

    it('says it in the owner’s words, with the two bounds as they are', () => {
      // Written out here, and not taken from the code under test.
      expect(TABLE_NO_ROOM).toBe(
        'We cannot add this. A table and the tables in its cells hold 10,000 cells, two levels deep, and this surpasses our current limits.',
      );
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
  // The owner's decisions of 18 October 2026 (D182, D184, D192, D193): one
  // number for tables, and a limit for each block with controls of its own,
  // refused at the change and never taken out later (Q45).
  describe('and the limits of one document (D182, D184, D192, D193)', () => {
    const small = (written: string) => blockOf([rowOf(written)], words(''));
    const holding = (tables: number) => {
      const document = new Y.Doc();
      document
        .getXmlFragment('default')
        .push([
          paragraph('KEEP-THIS'),
          ...Array.from({ length: tables }, (_, at) => small(`t${at}`)),
          paragraph('after'),
        ]);
      return document;
    };
    const bytes = (document: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
    const yTables = (fragment: Y.XmlFragment) => fragment.toString().split('<tableblock').length - 1;
    /** The words of the tables of the text, in their order. */
    const texts = (editor: ReturnType<typeof open>) =>
      editor
        .text()
        .textBetween(0, editor.text().content.size, ' ')
        .split(' ')
        .filter((word) => /^(t\d+|put-.*|in-.*)$/.test(word));
    const p = (written = '') => schema.node('paragraph', null, written ? [schema.text(written)] : []);
    const table = () =>
      schema.node('tableBlock', null, [
        schema.node('table', null, [schema.node('tableRow', null, [schema.node('tableCell', null, [p()])])]),
        schema.node('tableCaption'),
      ]);
    const docOf = (...blocks: PMNode[]) => schema.node('doc', null, [p('first'), ...blocks]);
    const state = (tables: number) =>
      EditorState.create({ schema, doc: docOf(...Array.from({ length: tables }, table)) });
    const pasted = (transaction: Transaction) =>
      transaction.setMeta('paste', true).setMeta('uiEvent', 'paste');
    const ADD_TABLE = 'We cannot add another table. Our current limit per document is 100 tables.';

    it('are the owner’s numbers, and tables are one number with no second', () => {
      expect(TABLE_COUNT_MOST).toBe(100);
      expect(LIMITS).toEqual({
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
        blocks: 5000,
      });
      expect(DOCUMENT_BYTES_MOST).toBe(MAX_STATE_BYTES);
    });

    it('a change that leaves the document with more than a hundred tables, and more than it had, is refused in the owner’s words', () => {
      const room = state(99);
      expect(limitRefusal(room.tr.insert(0, table()), room.doc)).toBeNull();
      const full = state(100);
      expect(limitRefusal(full.tr.insert(0, table()), full.doc)).toBe(ADD_TABLE);
      // In a cell of a table it is one more all the same: after the paragraph of the first cell.
      expect(full.doc.resolve(13).parent.type.name).toBe('tableCell');
      expect(limitRefusal(full.tr.insert(13, table()), full.doc)).toBe(ADD_TABLE);
      // A paste names the count it would bring the document to.
      expect(limitRefusal(pasted(full.tr.insert(0, [table(), table()])), full.doc)).toBe(
        'We could not paste this. It would bring the document to 102 tables, more than our current limit for tables (100).',
      );
      // What adds none is applied, and so is what takes one away, and what the binding brings.
      expect(limitRefusal(full.tr.insertText('typed', 1), full.doc)).toBeNull();
      expect(limitRefusal(full.tr.delete(7, 7 + table().nodeSize), full.doc)).toBeNull();
      expect(
        limitRefusal(full.tr.insert(0, table()).setMeta(ySyncPluginKey, { isChangeOrigin: true }), full.doc),
      ).toBeNull();
    });

    it('a paste that takes a table past its bounds is refused in the owner’s words of D178, and a command in his words of the same day', () => {
      // Written out here, and not taken from the code under test.
      expect(TABLE_PASTE_NO_ROOM).toBe(
        'We cannot paste this table. A table and the tables in its cell hold 10,000 cells, two levels deep and this surpasses our current limits.',
      );
      expect(TABLE_NO_ROOM).toBe(
        'We cannot add this. A table and the tables in its cells hold 10,000 cells, two levels deep, and this surpasses our current limits.',
      );
      const nested = (inner: PMNode) =>
        schema.node('tableBlock', null, [
          schema.node('table', null, [
            schema.node('tableRow', null, [schema.node('tableCell', null, [inner])]),
          ]),
          schema.node('tableCaption'),
        ]);
      const two = EditorState.create({ schema, doc: docOf(nested(nested(p('deep')))) });
      let at = 0;
      two.doc.descendants((node, pos) => {
        if (node.textContent === 'deep' && node.isTextblock) at = pos + 1;
      });
      const third = () => two.tr.insert(at - 1, table());
      expect(limitRefusal(pasted(third()), two.doc)).toBe(TABLE_PASTE_NO_ROOM);
      expect(limitRefusal(third(), two.doc)).toBe(TABLE_NO_ROOM);
    });

    describe('every block with a limit of its own', () => {
      const node = (name: string) =>
        name === 'callout' || name === 'blockquote'
          ? schema.node(name, null, [p()])
          : name === 'codeBlock'
            ? schema.node(name, null, [schema.text('x')])
            : schema.node(name);
      const CASES = [
        ['codeBlock', 200, 'code block', 'code blocks'],
        ['callout', 200, 'callout', 'callouts'],
        ['tableOfContents', 5, 'table of contents', 'tables of contents'],
        ['pageBreak', 500, 'page break', 'page breaks'],
        ['horizontalRule', 500, 'divider', 'dividers'],
        ['blockquote', 500, 'quote', 'quotes'],
      ] as const;
      it.each(CASES)('%s: %i, and one more is refused, added or pasted', (name, most, one, many) => {
        const at = EditorState.create({
          schema,
          doc: docOf(...Array.from({ length: most }, () => node(name))),
        });
        const under = EditorState.create({
          schema,
          doc: docOf(...Array.from({ length: most - 1 }, () => node(name))),
        });
        expect(limitRefusal(under.tr.insert(0, node(name)), under.doc)).toBeNull();
        expect(limitRefusal(at.tr.insert(0, node(name)), at.doc)).toBe(
          `We cannot add this ${one}. Our current limit per document is ${most} ${many}.`,
        );
        expect(limitRefusal(pasted(at.tr.insert(0, [node(name), node(name)])), at.doc)).toBe(
          `We cannot paste this. It holds 2 ${many}, and our current limit per document is ${most}.`,
        );
        // Counted wherever it stands: in a cell of a table.
        const inCell = EditorState.create({
          schema,
          doc: docOf(...Array.from({ length: most - 1 }, () => node(name)), table()),
        });
        let cell = 0;
        inCell.doc.descendants((child, pos) => {
          if (child.type.name === 'tableCell') cell = pos + 1;
        });
        expect(limitRefusal(inCell.tr.insert(cell, [node(name), node(name)]), inCell.doc)).not.toBeNull();
        // Typing and deleting are applied at the limit.
        expect(limitRefusal(at.tr.insertText('typed', 1), at.doc)).toBeNull();
      });

      const item = (written = '') => schema.node('listItem', null, [p(written)]);
      const list = (...items: PMNode[]) => schema.node('bulletList', null, items);
      it('a list holds 1,000 items, and the 1,001st is refused', () => {
        const full = EditorState.create({
          schema,
          doc: docOf(list(...Array.from({ length: 1000 }, () => item()))),
        });
        expect(limitRefusal(full.tr.insert(full.doc.child(0).nodeSize + 1, item()), full.doc)).toBe(
          'We cannot add this list item. Our current limit per list is 1,000 items.',
        );
        // Another list of its own is not that list.
        expect(limitRefusal(full.tr.insert(0, list(item())), full.doc)).toBeNull();
      });

      it('lists nest 10 deep, and the eleventh level is refused', () => {
        const nest = (levels: number): PMNode =>
          levels === 1 ? list(item('deepest')) : list(schema.node('listItem', null, [p(), nest(levels - 1)]));
        const ten = EditorState.create({ schema, doc: docOf(nest(10)) });
        let end = 0;
        ten.doc.descendants((child, pos) => {
          if (child.type.name === 'paragraph' && child.textContent === 'deepest') end = pos + child.nodeSize;
        });
        expect(limitRefusal(ten.tr.insert(end, list(item())), ten.doc)).toBe(
          'We cannot nest this list further. Our current limit is 10 levels of nesting.',
        );
        const nine = EditorState.create({ schema, doc: docOf(nest(9)) });
        nine.doc.descendants((child, pos) => {
          if (child.type.name === 'paragraph' && child.textContent === 'deepest') end = pos + child.nodeSize;
        });
        expect(limitRefusal(nine.tr.insert(end, list(item())), nine.doc)).toBeNull();
      });

      it('a code block holds 500 KB: text past it is refused, and so is a code block past it', () => {
        const KB500 = 500 * 1024;
        const code = (text: string) => schema.node('codeBlock', null, text ? [schema.text(text)] : []);
        // 500 KB to the byte, two of them in a character of three bytes.
        const full = EditorState.create({
          schema,
          doc: docOf(code(`${'€'.repeat(2)}${'a'.repeat(KB500 - 6)}`)),
        });
        expect(limitRefusal(full.tr.insertText('b', 9), full.doc)).toBe(
          'We cannot add this text. Our current limit per code block is 500 KB.',
        );
        expect(limitRefusal(full.tr.delete(8, 9), full.doc)).toBeNull();
        const room = EditorState.create({ schema, doc: docOf(code('a'.repeat(KB500 - 1))) });
        expect(limitRefusal(room.tr.insertText('b', 9), room.doc)).toBeNull();
        expect(limitRefusal(room.tr.insertText('€', 9), room.doc)).not.toBeNull();
        expect(limitRefusal(pasted(room.tr.insert(0, code('c'.repeat(KB500 + 1)))), room.doc)).toBe(
          'We cannot add this code block. Our current limit per code block is 500 KB.',
        );
      });
    });

    // The owner's decision of 18 October 2026 (D192): every block outside the cells of tables, a table one.
    describe('the total of 5,000 blocks', () => {
      const ADD = 'We cannot add this block. Our current limit per document is 5,000 blocks.';
      const paragraphs = (count: number) => Array.from({ length: count }, () => p());
      /** A document of `count` blocks: the first paragraph and paragraphs after it. */
      const blocks = (count: number, ...more: PMNode[]) =>
        EditorState.create({ schema, doc: docOf(...more, ...paragraphs(count - 1 - more.length)) });
      const item = (...content: PMNode[]) => schema.node('listItem', null, content.length ? content : [p()]);
      const list = (...items: PMNode[]) => schema.node('bulletList', null, items);
      /** A table of `rows` rows of `columns` cells, each holding what `cell` makes. */
      const grid = (rows: number, columns: number, cell = () => [p('a'), p('b')]) =>
        schema.node('tableBlock', null, [
          schema.node(
            'table',
            null,
            Array.from({ length: rows }, () =>
              schema.node(
                'tableRow',
                null,
                Array.from({ length: columns }, () => schema.node('tableCell', null, cell())),
              ),
            ),
          ),
          schema.node('tableCaption'),
        ]);

      it('counts each block written in or put down once: an item, a quote and a callout by what they hold, a table as one', () => {
        const total = (...content: PMNode[]) => countsOf(schema.node('doc', null, content)).blocks;
        expect(total(p(), schema.node('heading', { level: 2 }))).toBe(2);
        // Three items, one with a second paragraph and a list of two in it: six lines, six blocks.
        expect(total(list(item(), item(p(), p(), list(item(), item())), item()))).toBe(6);
        expect(total(schema.node('blockquote', null, [p(), p()]))).toBe(2);
        expect(total(schema.node('callout', null, [p()]))).toBe(1);
        expect(
          total(
            schema.node('codeBlock', null, [schema.text('x')]),
            schema.node('horizontalRule'),
            schema.node('pageBreak'),
            schema.node('tableOfContents'),
          ),
        ).toBe(4);
        // A table of 30 cells of two paragraphs each, a table in one of them: one block.
        expect(total(grid(5, 6, () => [p(), grid(1, 1)]))).toBe(1);
      });

      it('a document of 5,000 takes every change that adds no block, and refuses one more, added or pasted, in the owner’s words', () => {
        const at = blocks(5000);
        expect(countsOf(at.doc).blocks).toBe(5000);
        expect(overLimits(at.doc)).toEqual([]);
        expect(limitRefusal(at.tr.insertText('typed', 1), at.doc)).toBeNull();
        expect(limitRefusal(at.tr.delete(1, 3), at.doc)).toBeNull();
        // Two paragraphs joined, and a paragraph replaced by a table, a list or a quote: no block more.
        expect(limitRefusal(at.tr.join(7), at.doc)).toBeNull();
        expect(limitRefusal(at.tr.replaceWith(7, 9, table()), at.doc)).toBeNull();
        expect(limitRefusal(at.tr.replaceWith(7, 9, list(item())), at.doc)).toBeNull();
        expect(
          limitRefusal(at.tr.replaceWith(7, 9, schema.node('blockquote', null, [p()])), at.doc),
        ).toBeNull();
        // Enter, a divider, and an item added to a list are one block more.
        expect(limitRefusal(at.tr.split(3), at.doc)).toBe(ADD);
        expect(limitRefusal(at.tr.insert(7, schema.node('horizontalRule')), at.doc)).toBe(ADD);
        const listed = blocks(5000, list(item()));
        expect(limitRefusal(listed.tr.insert(listed.doc.child(0).nodeSize + 1, item()), listed.doc)).toBe(
          ADD,
        );
        expect(limitRefusal(pasted(at.tr.insert(7, [p(), p(), p()])), at.doc)).toBe(
          'We cannot paste this. It holds 3 blocks, and our current limit per document is 5,000.',
        );
        // At 4,999 the 5,000th is taken; and what another client sends, or an undo, is the server's to hold.
        const under = blocks(4999);
        expect(limitRefusal(under.tr.split(3), under.doc)).toBeNull();
        expect(
          limitRefusal(at.tr.split(3).setMeta(ySyncPluginKey, { isChangeOrigin: true }), at.doc),
        ).toBeNull();
      });

      it('a table with thousands of paragraphs in its cells counts as one: its cells take paragraphs, the document does not', () => {
        // 1,000 cells of two paragraphs, and 4,999 blocks besides: 5,000.
        const full = blocks(5000, grid(50, 20));
        expect(countsOf(full.doc).blocks).toBe(5000);
        expect(overLimits(full.doc)).toEqual([]);
        let cell = 0;
        full.doc.descendants((node, pos) => {
          if (!cell && node.type.name === 'tableCell') cell = pos + 1;
        });
        expect(limitRefusal(full.tr.insert(cell, [p(), p(), p()]), full.doc)).toBeNull();
        expect(limitRefusal(full.tr.split(cell + 2), full.doc)).toBeNull();
        expect(limitRefusal(full.tr.insert(0, p()), full.doc)).toBe(ADD);
      });

      it('a document past it opens to deletions alone, told so in the owner’s words, until it is back at 5,000', () => {
        const more = blocks(5010);
        const [statement] = overLimits(more.doc);
        expect(statement).toBe(
          'This document holds 5,010 blocks, more than our current limit per document (5,000). It is read-only until it is back under the limit. You can still delete blocks.',
        );
        expect(limitRefusal(more.tr.delete(1, 3), more.doc)).toBeNull();
        expect(limitRefusal(more.tr.insertText('typed', 1), more.doc)).toBe(statement);
        const back = more.apply(more.tr.delete(7, 7 + 10 * 2));
        expect(countsOf(back.doc).blocks).toBe(5000);
        expect(limitRefusal(back.tr.insertText('typed', 1), back.doc)).toBeNull();
      });

      it('is cheap at each key in a document of 5,000 blocks and a full table', () => {
        let at = blocks(
          5000,
          grid(100, 100, () => [p('a')]),
        );
        const keys = 300;
        const started = performance.now();
        for (let key = 0; key < keys; key += 1) {
          const typed = at.tr.insertText('k', 2);
          expect(limitRefusal(typed, at.doc)).toBeNull();
          at = at.apply(typed);
        }
        const each = (performance.now() - started) / keys;
        // Measured for the report of the commit; the bound allows a loaded machine.
        console.info(`the limits at each key: ${each.toFixed(3)} ms`);
        expect(each).toBeLessThan(25);
      });
    });

    describe('a document past a limit already (D184)', () => {
      it('is told so, in a statement that names the count and the limit, for each limit it is past', () => {
        expect(overLimits(state(100).doc)).toEqual([]);
        expect(overLimits(state(150).doc)).toEqual([
          'This document holds 150 tables, more than our current limit per document (100). It is read-only until it is back under the limit. You can still delete tables.',
        ]);
        const tocs = EditorState.create({
          schema,
          doc: docOf(
            ...Array.from({ length: 101 }, table),
            ...Array.from({ length: 6 }, () => schema.node('tableOfContents')),
          ),
        });
        expect(overLimits(tocs.doc)).toEqual([
          'This document holds 101 tables, more than our current limit per document (100). It is read-only until it is back under the limit. You can still delete tables.',
          'This document holds 6 tables of contents, more than our current limit per document (5). It is read-only until it is back under the limit. You can still delete tables of contents.',
        ]);
      });

      it('takes deletions alone: typing, a table, and a deletion with something put in are refused, with the statement', () => {
        const more = state(150);
        const [statement] = overLimits(more.doc);
        expect(limitRefusal(more.tr.delete(7, 7 + table().nodeSize), more.doc)).toBeNull();
        expect(limitRefusal(more.tr.delete(2, 4), more.doc)).toBeNull();
        // Everything selected and deleted: the schema puts in the empty paragraph a document must hold.
        const all = more.tr.delete(0, more.doc.content.size);
        expect(all.doc.childCount).toBe(1);
        expect(limitRefusal(all, more.doc)).toBeNull();
        // A paragraph split in two, by Enter, puts a paragraph in.
        expect(limitRefusal(more.tr.split(3), more.doc)).toBe(statement);
        // The empty paragraph the editor keeps at the end of a document is put in; elsewhere it is not.
        expect(limitRefusal(more.tr.insert(more.doc.content.size, p()), more.doc)).toBeNull();
        expect(limitRefusal(more.tr.insert(0, p()), more.doc)).toBe(statement);
        // Blank lines pasted over a selection put paragraphs in (the review of pull request 41).
        expect(limitRefusal(more.tr.replaceWith(2, 4, [p(), p(), p()]), more.doc)).toBe(statement);
        expect(limitRefusal(more.tr.replaceWith(1, 6, p()), more.doc)).toBe(statement);
        expect(limitRefusal(more.tr.insertText('typed', 1), more.doc)).toBe(statement);
        expect(limitRefusal(more.tr.delete(7, 7 + table().nodeSize).insert(0, table()), more.doc)).toBe(
          statement,
        );
        expect(limitRefusal(more.tr.insert(0, table()), more.doc)).toBe(ADD_TABLE);
        // What another client sends, and an undo, are not this writer's.
        expect(
          limitRefusal(
            more.tr.insertText('typed', 1).setMeta(ySyncPluginKey, { isChangeOrigin: true }),
            more.doc,
          ),
        ).toBeNull();
        // Back at the limit, it is written in again.
        const back = more.apply(more.tr.delete(7, 7 + 50 * table().nodeSize));
        expect(overLimits(back.doc)).toEqual([]);
        expect(limitRefusal(back.tr.insertText('typed', 1), back.doc)).toBeNull();
      });

      it('is said by the editor’s own plugin, which applies nothing it refuses', () => {
        const closed = all.find((each) => each.name === 'closed') as unknown as {
          config: {
            addProseMirrorPlugins(this: {
              editor: { isEditable: boolean };
              options: { noRoom(words: string | null): void };
            }): Plugin[];
          };
        };
        const noRoom = vi.fn();
        const [plugin] = closed.config.addProseMirrorPlugins.call({
          editor: { isEditable: true },
          options: { noRoom },
        });
        const full = EditorState.create({ schema, doc: state(100).doc, plugins: [plugin!] });
        expect(full.applyTransaction(full.tr.insert(0, table())).transactions).toEqual([]);
        expect(noRoom.mock.calls).toEqual([[ADD_TABLE]]);
      });

      it('a stored document of a hundred and fifty opens with a hundred and fifty, and nothing is written to it', () => {
        const document = holding(150);
        const before = bytes(document);
        const editor = open(document);
        expect(tableCount(editor.text())).toBe(150);
        expect(texts(editor)).toHaveLength(150);
        expect(bytes(document)).toBe(before);
        expect(editor.mended()).toBe(0);
        expect(editor.unshown).not.toHaveBeenCalled();
        expect(overLimits(editor.text())).toHaveLength(1);
      });

      it('what other clients put past a hundred is shown, every table of it, and nothing is taken out', () => {
        const editor = open(holding(99));
        const [one, two] = [peerOf(editor.fragment.doc!), peerOf(editor.fragment.doc!)];
        one.fragment.insert(1, [small('put-by-one')]);
        two.fragment.insert(
          1,
          Array.from({ length: 400 }, (_, at) => small(`put-${at}`)),
        );
        one.send();
        two.send();
        expect(tableCount(editor.text())).toBe(500);
        expect(yTables(editor.fragment)).toBe(500);
        expect(texts(editor)).toHaveLength(500);
        expect(editor.mended()).toBe(0);
        expect(editor.undo.undoStack).toEqual([]);
      });
    });

    describe('the mending touches nothing else', () => {
      const copyOf = (document: Y.Doc, client?: number) => {
        const copy = new Y.Doc();
        if (client !== undefined) copy.clientID = client;
        Y.applyUpdate(copy, Y.encodeStateAsUpdate(document));
        return copy;
      };
      /** Every document hears every other, until none has anything new. */
      const exchange = (...documents: Y.Doc[]) => {
        for (let round = 0; round < 10; round += 1) {
          const before = documents.map((each) => bytes(each));
          for (const from of documents)
            for (const to of documents)
              if (from !== to) Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)), 'net');
          if (documents.every((each, at) => bytes(each) === before[at])) return;
        }
        throw new Error('the documents did not settle');
      };
      const times = (text: string, word: string) => text.split(word).length - 1;
      const item = (type: { _item: Y.Item | null }) => `${type._item!.id.client}:${type._item!.id.clock}`;
      const type = (editor: ReturnType<typeof open>, inWords: string, typed: string) => {
        const view = editor.typed();
        let at = -1;
        view.state.doc.descendants((node, pos) => {
          if (at < 0 && node.type.name === 'paragraph' && node.textContent === inWords) at = pos + 1;
        });
        view.dispatch(view.state.tr.insertText(typed, at));
        editor.binding._prosemirrorChanged(view.state.doc);
      };
      const deletionsOnly = (editor: ReturnType<typeof open>) => {
        expect(editor.mends().length).toBeGreaterThan(0);
        for (const update of editor.mends()) expect(Y.decodeUpdate(update).structs).toEqual([]);
      };

      // Measured for the re-review of pull request 35, 13 October 2026, and
      // mended by the owner's decision of that day. The ordinary mending, of
      // what the schema leaves out of a node that stays, was written by the
      // same comparison of the library, and did what the flood's did: where
      // the children that go stand BETWEEN children that stay, those between
      // the first and the last that go were deleted and put in again by each
      // browser that mended. Ten paragraphs of a quotation with a row between
      // each two, two browsers at once, a third writer typing in one of them:
      // of the ten, four were there twice and four were gone; six of ten were
      // the items they were; the third writer's words were lost. The numbers
      // in the test are those. It was marked as one that fails until the
      // mending took the children out as the elements they are (`leftOut`).
      it('the ordinary mending of children the schema leaves out, between children that stay, keeps each of those once', () => {
        const origin = new Y.Doc();
        origin.getXmlFragment('default').push([
          paragraph('top'),
          element(
            'blockquote',
            {},
            Array.from({ length: 10 }, (_, at) => paragraph(`honest ${at}.`)),
          ),
          paragraph('end'),
        ]);
        const [da, db, dc] = [copyOf(origin), copyOf(origin), copyOf(origin)];
        const [a, b, c] = [open(da), open(db), open(dc)];
        const quoted = (fragment: Y.XmlFragment) => fragment.get(1) as Y.XmlElement;
        const before = (quoted(a.fragment).toArray() as Y.XmlElement[]).map(item);
        // A client that is no editor puts a row, which no quotation holds, between each two.
        const hostile = copyOf(origin, 1);
        hostile.transact(() => {
          for (let at = 9; at >= 1; at -= 1)
            quoted(hostile.getXmlFragment('default')).insert(at, [rowOf('stray')]);
        });
        const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
        Y.applyUpdate(da, update, 'net');
        Y.applyUpdate(db, update, 'net');
        type(c, 'honest 5.', 'C-TYPED ');
        exchange(da, db, dc, hostile);
        const text = a.text().textContent;
        expect(new Set([a, b, c].map((editor) => editor.fragment.toString())).size).toBe(1);
        expect(text).not.toContain('stray');
        // Measured: 1,2,0,2,0,2,0,2,0,1.
        expect(Array.from({ length: 10 }, (_, at) => times(text, `honest ${at}.`))).toEqual(
          Array(10).fill(1),
        );
        // Measured: 0.
        expect(times(text, 'C-TYPED')).toBe(1);
        // Measured: six of the ten, among fourteen.
        expect((quoted(a.fragment).toArray() as Y.XmlElement[]).map(item)).toEqual(before);
      });

      describe('and so does the ordinary mending, of what the schema leaves out of a node that stays', () => {
        type YNode = Y.XmlElement | Y.XmlText;
        /** An element with everything in it, each as the item it is. */
        const deep = (type: YNode): string[] => [
          item(type),
          ...(type instanceof Y.XmlElement ? (type.toArray() as YNode[]).flatMap(deep) : []),
        ];
        /** What a mending put into the shared document, each thing by its name. */
        const put = (editor: ReturnType<typeof open>) =>
          editor
            .mends()
            .flatMap((update) => Y.decodeUpdate(update).structs)
            .map((struct) => {
              const { content, parentSub } = struct as Y.Item;
              const held = content as unknown as {
                type?: { nodeName?: string };
                str?: string;
                arr?: unknown[];
              };
              if (parentSub) return `@${parentSub}`;
              if (held.str !== undefined) return `"${held.str}"`;
              // A value written over an attribute's earlier one, which does not name the attribute again.
              if (held.arr) return `=${held.arr.join()}`;
              return held.type?.nodeName ?? held.type?.constructor.name ?? struct.constructor.name;
            });
        const honest = (count: number) => Array.from({ length: count }, (_, at) => `honest ${at}.`);
        // A cell as an editor writes it, with its spans: one without them is given them (below).
        const cell = (held: Y.XmlElement[]) => element('tableCell', { colspan: 1, rowspan: 1 }, held);
        const row = (...written: string[]) =>
          element(
            'tableRow',
            {},
            written.map((each) => cell([paragraph(each)])),
          );
        const full = (first: Y.XmlElement[]) =>
          blockOf([
            element('tableRow', {}, [
              cell(first),
              ...Array.from({ length: 99 }, () => cell([paragraph('')])),
            ]),
            ...Array.from({ length: 99 }, () => row(...Array.from({ length: 100 }, () => ''))),
          ]);
        const child = (of: YNode, ...path: number[]) =>
          path.reduce((at, index) => (at as Y.XmlElement).get(index) as YNode, of) as Y.XmlElement;

        // The node that holds what stays, where it is in a document, and what is put between.
        const SHAPES: [
          name: string,
          kept: number,
          make: (kept: string[]) => Y.XmlElement,
          path: number[],
          stray: () => YNode,
        ][] = [
          [
            'a quotation, and rows between its paragraphs',
            10,
            (kept) =>
              element(
                'blockquote',
                {},
                kept.map((each) => paragraph(each)),
              ),
            [],
            () => rowOf('stray'),
          ],
          [
            'a list, and paragraphs between its items',
            10,
            (kept) =>
              element(
                'bulletList',
                {},
                kept.map((each) => element('listItem', {}, [paragraph(each)])),
              ),
            [],
            () => paragraph('stray'),
          ],
          [
            'a table, and paragraphs between its rows',
            10,
            (kept) => blockOf(kept.map((each) => row(each))),
            [0],
            () => paragraph('stray'),
          ],
          [
            'a quotation, and text between its paragraphs',
            10,
            (kept) =>
              element(
                'blockquote',
                {},
                kept.map((each) => paragraph(each)),
              ),
            [],
            () => words('stray'),
          ],
          // The route the review named and did not try: both are left out by the bound on cells.
          [
            'a cell of a table that has no room, and tables between its paragraphs',
            3,
            (kept) => full(kept.map((each) => paragraph(each))),
            [0, 0, 0],
            () => blockOf([rowOf('stray')], words('stray')),
          ],
        ];
        const BETWEEN: [name: string, side: number, alone: boolean][] = [
          ['one between each two', 1, false],
          ['two side by side between each two', 2, false],
          ['one, between two', 1, true],
        ];
        const CASES = SHAPES.flatMap(([name, ...shape]) =>
          BETWEEN.map(([between, ...put]) => [`${name}: ${between}`, ...shape, ...put] as const),
        );

        const made = (make: (kept: string[]) => Y.XmlElement, kept: number) => {
          const origin = new Y.Doc();
          origin.getXmlFragment('default').push([paragraph('top'), make(honest(kept)), paragraph('end')]);
          return origin;
        };
        /** What a client that is no editor sends: the document with what does not belong between what does. */
        const strayed = (
          from: Y.Doc,
          path: number[],
          kept: number,
          stray: () => YNode,
          side: number,
          alone: boolean,
        ) => {
          const hostile = copyOf(from, 1);
          const holds = child(hostile.getXmlFragment('default').get(1) as Y.XmlElement, ...path);
          hostile.transact(() => {
            for (let at = kept - 1; at >= 1; at -= 1)
              if (!alone || at === 1)
                holds.insert(
                  at,
                  Array.from({ length: side }, () => stray()),
                );
          });
          return hostile;
        };

        it.each(CASES)('%s', (_name, kept, make, path, stray, side, alone) => {
          const origin = made(make, kept);
          const [da, db, dc] = [copyOf(origin), copyOf(origin), copyOf(origin)];
          const [a, b, c] = [open(da), open(db), open(dc)];
          const holds = (editor: ReturnType<typeof open>) =>
            child(editor.fragment.get(1) as Y.XmlElement, ...path);
          const before = (holds(a).toArray() as YNode[]).map(deep);
          expect(before).toHaveLength(kept);
          // The writer has typed in one of the children, and can undo it.
          type(a, `honest ${kept - 1}.`, 'A-TYPED ');
          exchange(da, db, dc);

          // It reaches two browsers at once, and each mends before it hears the other.
          const hostile = strayed(da, path, kept, stray, side, alone);
          const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
          const [builtA, builtB] = [a.dispatched(), b.dispatched()];
          Y.applyUpdate(da, update, 'net');
          Y.applyUpdate(db, update, 'net');
          expect([a.mended(), b.mended()]).toEqual([1, 1]);
          // Meanwhile a third writer, who has heard nothing of it, types in a child that stays.
          type(c, 'honest 1.', 'C-TYPED ');
          exchange(da, db, dc, hostile);

          for (const editor of [a, b, c]) {
            const text = editor.text().textContent;
            expect(editor.unshown).not.toHaveBeenCalled();
            expect(text).not.toContain('stray');
            expect(honest(kept).map((each) => times(text, each))).toEqual(Array(kept).fill(1));
            expect([times(text, 'A-TYPED'), times(text, 'C-TYPED')]).toEqual([1, 1]);
            // Every child that stays is the item it was, and so is everything in it.
            expect((holds(editor).toArray() as YNode[]).map(deep)).toEqual(before);
            expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
          }
          expect(new Set([a, b, c].map((editor) => editor.fragment.toString())).size).toBe(1);
          // What each wrote holds deletions and nothing that was put in; and hearing the other, neither writes again.
          deletionsOnly(a);
          deletionsOnly(b);
          expect([a.mended(), b.mended(), c.mended()]).toEqual([1, 1, 0]);
          // The work: the text is made once for what arrived and once for the mending, whatever the size.
          expect(a.dispatched() - builtA).toBeLessThanOrEqual(4);
          expect(b.dispatched() - builtB).toBeLessThanOrEqual(4);

          // The writer's undo takes back what the writer typed, and nothing else.
          expect(a.undo.undoStack).toHaveLength(1);
          a.undo.undo();
          exchange(da, db, dc, hostile);
          for (const editor of [a, b, c]) {
            const text = editor.text().textContent;
            expect(text).not.toContain('stray');
            expect([times(text, 'A-TYPED'), times(text, 'C-TYPED')]).toEqual([0, 1]);
            expect(honest(kept).map((each) => times(text, each))).toEqual(Array(kept).fill(1));
            expect((holds(editor).toArray() as YNode[]).map(deep)).toEqual(before);
          }
          // A browser that opens the document later writes nothing.
          const later = open(copyOf(da));
          expect(later.mended()).toBe(0);
          expect(later.text().eq(a.text())).toBe(true);
        });

        it('a browser that cannot edit writes nothing, and mends once when it can: deletions, and every child as it was', async () => {
          const [, kept, make, path, stray] = SHAPES[0]!;
          const origin = made(make, kept);
          const document = copyOf(origin);
          const editor = open(document, false);
          const holds = () => child(editor.fragment.get(1) as Y.XmlElement, ...path);
          const before = (holds().toArray() as YNode[]).map(deep);
          const hostile = strayed(document, path, kept, stray, 1, false);
          Y.applyUpdate(document, Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(document)), 'net');
          const arrived = bytes(document);
          expect(editor.mended()).toBe(0);
          expect(bytes(document)).toBe(arrived);
          expect(editor.text().textContent).not.toContain('stray');
          expect(honest(kept).map((each) => times(editor.text().textContent, each))).toEqual(
            Array(kept).fill(1),
          );
          editor.setEditable(true);
          await new Promise((done) => setTimeout(done, 0));
          expect(editor.mended()).toBe(1);
          deletionsOnly(editor);
          expect(editor.fragment.toString()).not.toContain('stray');
          expect((holds().toArray() as YNode[]).map(deep)).toEqual(before);
        });

        // The comparison that follows the deletion: what it may put in.
        describe('puts in what the schema requires and nothing else', () => {
          it('the paragraph of a cell that held only what goes, beside rows that stay', () => {
            const origin = new Y.Doc();
            origin
              .getXmlFragment('default')
              .push([paragraph('top'), blockOf(honest(4).map((each) => row(each, `${each} second`)))]);
            const document = copyOf(origin);
            const editor = open(document);
            const table = () => child(editor.fragment.get(1) as Y.XmlElement, 0);
            const before = (table().toArray() as YNode[]).map(deep);
            const hostile = copyOf(document, 1);
            const rows = child(hostile.getXmlFragment('default').get(1) as Y.XmlElement, 0);
            hostile.transact(() => {
              // A row whose one cell holds a row, which no cell holds: the cell is left with nothing.
              rows.insert(2, [element('tableRow', {}, [cell([rowOf('stray')])])]);
              rows.insert(1, [paragraph('stray')]);
            });
            Y.applyUpdate(document, Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(document)), 'net');
            expect(editor.mended()).toBe(1);
            // One paragraph, with nothing in it, and no copy of anything that was there.
            expect(put(editor)).toEqual(['paragraph']);
            expect(editor.fragment.toString()).not.toContain('stray');
            const after = (table().toArray() as YNode[]).map(deep);
            expect([after[0], after[1], after[3], after[4]]).toEqual(before);
            expect(child(table(), 2, 0).toString()).toContain('<paragraph></paragraph></tablecell>');
            expect(child(table(), 2, 0).length).toBe(1);
            expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
            expect(open(copyOf(document)).mended()).toBe(0);
          });

          // The bound on cells makes the table in the cell again, without the row that is past it
          // (`closeNested`): it is still the table that stays, and its other rows the rows they were.
          it('nothing, where a row of a table in a cell is past the cells and stands between rows that are not: those are the items they were', () => {
            const wide = (cells: number, written: string) =>
              element(
                'tableRow',
                {},
                Array.from({ length: cells }, (_, at) => cell([paragraph(at ? '' : written)])),
              );
            const origin = new Y.Doc();
            // 9,900 cells of its own: a hundred are left for the tables in them.
            origin
              .getXmlFragment('default')
              .push([
                paragraph('top'),
                blockOf(Array.from({ length: 100 }, (_, at) => wide(99, at ? '' : 'outer'))),
              ]);
            const [da, db] = [copyOf(origin), copyOf(origin)];
            const [a, b] = [open(da), open(db)];
            const inner = (fragment: Y.XmlFragment) => child(fragment.get(1) as Y.XmlElement, 0, 0, 0, 1, 0);
            const hostile = copyOf(da, 1);
            const sent = hostile.getXmlFragment('default');
            // Forty and forty are inside the hundred; forty more are not; ten after them are.
            hostile.transact(() =>
              child(sent.get(1) as Y.XmlElement, 0, 0, 0).push([
                blockOf([
                  wide(40, 'honest 0.'),
                  wide(40, 'honest 1.'),
                  wide(40, 'stray'),
                  wide(10, 'honest 2.'),
                ]),
              ]),
            );
            const rows = (inner(sent).toArray() as YNode[]).map(deep);
            const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
            Y.applyUpdate(da, update, 'net');
            Y.applyUpdate(db, update, 'net');
            exchange(da, db, hostile);
            for (const editor of [a, b]) {
              const text = editor.text().textContent;
              expect(text).not.toContain('stray');
              expect(honest(3).map((each) => times(text, each))).toEqual([1, 1, 1]);
              expect((inner(editor.fragment).toArray() as YNode[]).map(deep)).toEqual([
                rows[0],
                rows[1],
                rows[3],
              ]);
              expect(editor.mended()).toBe(1);
              deletionsOnly(editor);
            }
            expect(a.fragment.toString()).toBe(b.fragment.toString());
            expect(open(copyOf(da)).mended()).toBe(0);
          });

          // The grid makes the row again, and its cell (`closeGrid`): they are still the row and the cell that stay.
          it('the span of a cell that reached past the table, where a paragraph between its rows goes: written on the cell that is there', () => {
            const origin = new Y.Doc();
            origin
              .getXmlFragment('default')
              .push([paragraph('top'), blockOf(honest(3).map((each) => row(each)))]);
            const [da, db] = [copyOf(origin), copyOf(origin)];
            const [a, b] = [open(da), open(db)];
            const table = (editor: ReturnType<typeof open>) =>
              child(editor.fragment.get(1) as Y.XmlElement, 0);
            const before = deep(table(a));
            const hostile = copyOf(da, 1);
            const sent = child(hostile.getXmlFragment('default').get(1) as Y.XmlElement, 0);
            hostile.transact(() => {
              sent.insert(2, [paragraph('stray')]);
              child(sent, 1, 0).setAttribute('rowspan', 9 as unknown as string);
            });
            const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
            Y.applyUpdate(da, update, 'net');
            Y.applyUpdate(db, update, 'net');
            // The span of one row, on the one cell, by each browser, and nothing else.
            expect([put(a), put(b)]).toEqual([['=1'], ['=1']]);
            exchange(da, db, hostile);
            for (const editor of [a, b]) {
              expect(deep(table(editor))).toEqual(before);
              expect(child(table(editor), 1, 0).getAttribute('rowspan')).toBe(1);
              expect(editor.fragment.toString()).not.toContain('stray');
              expect(editor.mended()).toBe(1);
            }
            expect(a.fragment.toString()).toBe(b.fragment.toString());
            expect(open(copyOf(da)).mended()).toBe(0);
          });

          it('the caption of a block that has none, where rows of its table go: the table and its rows are the items they were', () => {
            const origin = new Y.Doc();
            origin
              .getXmlFragment('default')
              .push([paragraph('top'), blockOf(honest(4).map((each) => row(each)))]);
            const document = copyOf(origin);
            const editor = open(document);
            const block = () => editor.fragment.get(1) as Y.XmlElement;
            const before = deep(child(block(), 0));
            const hostile = copyOf(document, 1);
            const sent = hostile.getXmlFragment('default').get(1) as Y.XmlElement;
            hostile.transact(() => {
              sent.delete(1, 1);
              child(sent, 0).insert(3, [paragraph('stray')]);
              child(sent, 0).insert(1, [paragraph('stray'), paragraph('stray')]);
            });
            Y.applyUpdate(document, Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(document)), 'net');
            expect(editor.mended()).toBe(1);
            expect(put(editor)).toEqual(['tableCaption']);
            expect(deep(child(block(), 0))).toEqual(before);
            expect(editor.fragment.toString()).not.toContain('stray');
            expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
            expect(open(copyOf(document)).mended()).toBe(0);
          });

          it('the spans of cells that have none, written on the cells that are there: no cell is another item', () => {
            const origin = new Y.Doc();
            origin
              .getXmlFragment('default')
              .push([paragraph('top'), blockOf(honest(4).map((each) => rowOf(each)))]);
            const [da, db] = [copyOf(origin), copyOf(origin)];
            const [a, b] = [open(da), open(db)];
            const before = deep(a.fragment.get(1) as Y.XmlElement);
            const hostile = copyOf(da, 1);
            hostile.transact(() =>
              child(hostile.getXmlFragment('default').get(1) as Y.XmlElement, 0).insert(2, [
                paragraph('stray'),
              ]),
            );
            const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
            Y.applyUpdate(da, update, 'net');
            Y.applyUpdate(db, update, 'net');
            // Two spans for each of the four cells, by each browser, and nothing else.
            const spans = Array.from({ length: 4 }, () => ['@colspan', '@rowspan']).flat();
            expect([put(a), put(b)]).toEqual([spans, spans]);
            exchange(da, db, hostile);
            expect([a.mended(), b.mended()]).toEqual([1, 1]);
            expect(deep(a.fragment.get(1) as Y.XmlElement)).toEqual(before);
            expect(a.fragment.toString()).toBe(b.fragment.toString());
            expect(a.fragment.toString()).not.toContain('stray');
            expect(open(copyOf(da)).mended()).toBe(0);
          });

          // KNOWN, AND STATED WHERE THE RULE IS (`closeNested` of table-bounds.ts):
          // two that take the same thing out agree, and two that put something in
          // each put in their own. Nothing of the writer's is doubled by it: what
          // is put in is the empty paragraph a cell must hold.
          it('by each browser that mends at once, its own: a cell left with nothing holds two empty paragraphs, and every browser the same', () => {
            const origin = new Y.Doc();
            origin
              .getXmlFragment('default')
              .push([paragraph('top'), blockOf(honest(2).map((each) => row(each)))]);
            const [da, db] = [copyOf(origin), copyOf(origin)];
            const [a, b] = [open(da), open(db)];
            const before = (child(a.fragment.get(1) as Y.XmlElement, 0).toArray() as YNode[]).map(deep);
            const hostile = copyOf(da, 1);
            hostile.transact(() =>
              child(hostile.getXmlFragment('default').get(1) as Y.XmlElement, 0).insert(1, [
                element('tableRow', {}, [cell([rowOf('stray')])]),
              ]),
            );
            const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
            Y.applyUpdate(da, update, 'net');
            Y.applyUpdate(db, update, 'net');
            expect([put(a), put(b)]).toEqual([['paragraph'], ['paragraph']]);
            exchange(da, db, hostile);
            expect([a.mended(), b.mended()]).toEqual([1, 1]);
            expect(names(child(a.fragment.get(1) as Y.XmlElement, 0, 1, 0))).toEqual([
              'paragraph',
              'paragraph',
            ]);
            expect(a.text().textContent).toBe('tophonest 0.honest 1.caption');
            const rows = (child(a.fragment.get(1) as Y.XmlElement, 0).toArray() as YNode[]).map(deep);
            expect([rows[0], rows[2]]).toEqual(before);
            expect(a.fragment.toString()).toBe(b.fragment.toString());
            expect(yXmlFragmentToProseMirrorRootNode(a.fragment, schema).eq(a.text())).toBe(true);
            expect(open(copyOf(da)).mended()).toBe(0);
          });
        });

        // KNOWN, AND NOT MENDED HERE (measured 13 October 2026, and reported to
        // the owner). A paragraph of the shared document may hold two texts side
        // by side; a paragraph of the editor holds one run of text. The library's
        // comparison makes the first text hold everything and deletes the second,
        // wherever it looks at such a paragraph: here, since the mending compares
        // the whole document, and as much at the next letter a writer types in
        // that paragraph (`_prosemirrorChanged`). Two browsers that do it at once
        // each put the words of the second text into the first. Measured, in both
        // of these: "FIRST SECONDSECOND" in every browser.
        //
        // The two ways to it: something the schema leaves out stands between two
        // texts of one paragraph, and is taken out; or the two texts stood side
        // by side already, anywhere in a document in which anything is mended.
        // Each test states what should hold, and is marked as one that fails.
        it.fails.each([
          ['a row between two texts of one paragraph, which goes', true],
          ['two texts side by side in a paragraph, where something is mended elsewhere', false],
        ])('the words of a text are kept once: %s', (_name, inside) => {
          const origin = new Y.Doc();
          origin
            .getXmlFragment('default')
            .push([
              element('paragraph', {}, inside ? [words('FIRST ')] : [words('FIRST '), words('SECOND')]),
              element('blockquote', {}, [paragraph('honest 0.'), paragraph('honest 1.')]),
            ]);
          const [da, db] = [copyOf(origin), copyOf(origin)];
          const [a, b] = [open(da), open(db)];
          expect([a.mended(), b.mended()]).toEqual([0, 0]);
          const hostile = copyOf(da, 1);
          hostile.transact(() => {
            const fragment = hostile.getXmlFragment('default');
            if (inside) (fragment.get(0) as Y.XmlElement).push([rowOf('stray'), words('SECOND')]);
            else (fragment.get(1) as Y.XmlElement).insert(1, [rowOf('stray')]);
          });
          const update = Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(da));
          Y.applyUpdate(da, update, 'net');
          Y.applyUpdate(db, update, 'net');
          exchange(da, db, hostile);
          expect(a.fragment.toString()).toBe(b.fragment.toString());
          expect(a.text().textContent).not.toContain('stray');
          // Measured: 2.
          expect(times(a.text().textContent, 'SECOND')).toBe(1);
        });

        it('is no part of what a writer’s own changes write: typing, and a paragraph put in, mend nothing', () => {
          const [, kept, make] = SHAPES[2]!;
          const editor = open(copyOf(made(make, kept)));
          type(editor, 'honest 3.', 'typed ');
          const view = editor.typed();
          view.dispatch(view.state.tr.insert(0, schema.nodes.paragraph!.create(null, schema.text('put in'))));
          editor.binding._prosemirrorChanged(view.state.doc);
          expect(editor.fragment.toString()).toContain('put in');
          expect(editor.mended()).toBe(0);
          expect(editor.undo.undoStack.length).toBeGreaterThan(0);
        });

        // The work on the largest: counted, and the same whatever the size.
        it.each([10, 1000])(
          'makes the text the same number of times and mends once, whatever the size: %i paragraphs with a row between each two',
          (kept) => {
            const [, , make, path, stray] = SHAPES[0]!;
            const document = copyOf(made(make, kept));
            const editor = open(document);
            const hostile = strayed(document, path, kept, stray, 1, false);
            const [built, asked] = [editor.dispatched(), vi.spyOn(schema, 'node')];
            Y.applyUpdate(document, Y.encodeStateAsUpdate(hostile, Y.encodeStateVector(document)), 'net');
            const work = asked.mock.calls.length;
            asked.mockRestore();
            expect(editor.mended()).toBe(1);
            expect(editor.dispatched() - built).toBe(2);
            // The nodes the schema is asked for, in the two makings: each child and stray a fixed number of times.
            expect(work).toBeLessThanOrEqual(2 * 12 * kept);
            deletionsOnly(editor);
          },
        );
      });
    });

    // Register D180, the browser's half: a mending past the room left under 5 MB is not written.
    describe('and a mending that would take the document past 5 MB', () => {
      /** A table of cells without the paragraph each must hold, after `padding` characters of text. */
      const emptyCells = (padding: number) => {
        const document = new Y.Doc();
        const rows = Array.from({ length: 50 }, () =>
          element(
            'tableRow',
            {},
            Array.from({ length: 20 }, () => element('tableCell')),
          ),
        );
        document.getXmlFragment('default').push([paragraph('top'), blockOf(rows)]);
        if (padding > 0) {
          const room = MAX_STATE_BYTES - Y.encodeStateAsUpdate(document).byteLength - padding;
          document.getXmlFragment('default').insert(0, [paragraph('x'.repeat(room))]);
        }
        return document;
      };

      it('is written where it fits', () => {
        const editor = open(emptyCells(0));
        expect(editor.mended()).toBeGreaterThan(0);
        expect(editor.unrepairable).not.toHaveBeenCalled();
      });

      it('is not written where it does not: the tab is told once, and nothing of the text is written after', () => {
        const document = emptyCells(2000);
        expect(Y.encodeStateAsUpdate(document).byteLength).toBeLessThan(MAX_STATE_BYTES);
        const before = bytes(document);
        const editor = open(document);
        expect(editor.unrepairable).toHaveBeenCalledTimes(1);
        expect(editor.unshown).not.toHaveBeenCalled();
        expect(editor.mended()).toBe(0);
        expect(bytes(document)).toBe(before);
        // More arrives, and the text is made again: it is not tried again, and nothing is written.
        const peer = peerOf(document);
        peer.fragment.push([paragraph('more')]);
        peer.send();
        expect(editor.text().textContent).toContain('more');
        expect(editor.unrepairable).toHaveBeenCalledTimes(1);
        expect(editor.mended()).toBe(0);
        const view = editor.typed();
        view.dispatch(view.state.tr.insertText('typed ', 1));
        editor.binding._prosemirrorChanged(view.state.doc);
        expect(editor.fragment.toString()).not.toContain('typed');
      });
    });

    // The review of pull request 42: a client empties an element in a document at a limit, which the
    // server takes (D180); the filling every browser wrote would pass the limit, be refused, and hold
    // every tab. It is not written: the tab opens to deletions alone, and a deletion lets it through.
    describe('and a mending that the server would refuse for a limit of the document', () => {
      const replica = (document: Y.Doc) => {
        const made = new Y.Doc();
        Y.applyUpdate(made, Y.encodeStateAsUpdate(document));
        return made;
      };
      /** The document after a member's update that the server takes, and that update. */
      const emptied = (document: Y.Doc, change: (fragment: Y.XmlFragment) => void) => {
        const member = replica(document);
        member.transact(() => change(member.getXmlFragment('default')));
        const update = Y.encodeStateAsUpdate(member, Y.encodeStateVector(document));
        expect(shapeOf(document, update)).toBeNull();
        Y.applyUpdate(document, update);
        return document;
      };
      const CASES = [
        [
          '5,000 blocks, a quote emptied',
          () => {
            const document = new Y.Doc();
            document
              .getXmlFragment('default')
              .push([
                element('blockquote', {}, [paragraph('q')]),
                ...Array.from({ length: 4999 }, () => paragraph('x')),
              ]);
            return emptied(document, (fragment) => {
              (fragment.get(0) as Y.XmlElement).delete(0, 1);
              fragment.push([paragraph('added')]);
            });
          },
          'This document holds 5,001 blocks, more than our current limit per document (5,000). It is read-only until it is back under the limit. You can still delete blocks.',
        ],
        [
          '100 tables, a table block emptied',
          () => {
            const document = new Y.Doc();
            document
              .getXmlFragment('default')
              .push([paragraph('x'), ...Array.from({ length: 100 }, () => blockOf([rowOf('c')]))]);
            return emptied(document, (fragment) => {
              (fragment.get(1) as Y.XmlElement).delete(0, 2);
              fragment.push([blockOf([rowOf('added')])]);
            });
          },
          'This document holds 101 tables, more than our current limit per document (100). It is read-only until it is back under the limit. You can still delete tables.',
        ],
      ] as const;

      it.each(CASES)(
        '%s: not written and not held, deletions alone, and a block deleted lets it through',
        (_, made, statement) => {
          const document = made();
          const before = bytes(document);
          const editor = open(document);
          expect(editor.unrepairable).not.toHaveBeenCalled();
          expect(editor.unshown).not.toHaveBeenCalled();
          expect(editor.mended()).toBe(0);
          expect(bytes(document)).toBe(before);
          // The filled text is past the limit: the statement, and deletions alone.
          expect(overLimits(editor.text())).toEqual([statement]);
          const view = editor.typed();
          // The first and the last place in text: after a letter.
          const written: number[] = [];
          view.state.doc.descendants((node, pos) => {
            if (node.isTextblock && node.textContent) written.push(pos + 1 + node.content.size);
          });
          expect(limitRefusal(view.state.tr.insertText('typed', written[0]!), view.state.doc)).toBe(
            statement,
          );
          // A second honest browser is not held either, and writes nothing.
          const second = open(replica(document));
          expect([second.unrepairable.mock.calls.length, second.mended()]).toEqual([0, 0]);
          // A letter deleted leaves it past: nothing is written, not even the letter.
          const letter = view.state.tr.delete(written.at(-1)! - 1, written.at(-1)!);
          expect(limitRefusal(letter, view.state.doc)).toBeNull();
          view.dispatch(letter);
          editor.binding._prosemirrorChanged(view.state.doc);
          expect(editor.mended()).toBe(0);
          expect(bytes(document)).toBe(before);
          // The last block deleted brings it back to the limit: the deletion and the filling are written
          // together, and the server takes them.
          const server = replica(document);
          const { doc } = view.state;
          const block = view.state.tr.delete(doc.content.size - doc.lastChild!.nodeSize, doc.content.size);
          expect(limitRefusal(block, doc)).toBeNull();
          view.dispatch(block);
          editor.binding._prosemirrorChanged(view.state.doc);
          expect(editor.mended()).toBe(1);
          expect(shapeOf(server, editor.mends()[0]!)).toBeNull();
          expect(overLimits(editor.text())).toEqual([]);
          expect(editor.unrepairable).not.toHaveBeenCalled();
          // What the binding builds of the shared document now needs no filling.
          expect(open(replica(document)).mended()).toBe(0);
        },
      );
    });

    // The review of pull request 34: a browser that cannot edit the document wrote a mending to it.
    describe('and a browser that cannot edit the document', () => {
      it('writes no mending: the text is made without what the schema leaves out, and the shared document is as it arrived', async () => {
        const document = holding(3);
        const editor = open(document, false);
        const peer = peerOf(document);
        const table = (peer.fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement;
        table.push([paragraph('not a row')]);
        peer.fragment.push([rowOf('a row without a table')]);
        peer.send();
        expect(editor.unshown).not.toHaveBeenCalled();
        expect(editor.text().textContent).not.toContain('not a row');
        expect(editor.mended()).toBe(0);
        expect(editor.fragment.toString()).toContain('not a row');
        expect(editor.fragment.toString()).toContain('a row without a table');
        // More arrives, and still nothing is written.
        peer.fragment.push([paragraph('more')]);
        peer.send();
        expect(editor.mended()).toBe(0);

        // When the text can be edited again, what was owed is mended, before anything else.
        editor.setEditable(true);
        await new Promise((done) => setTimeout(done, 0));
        expect(editor.mended()).toBeGreaterThan(0);
        expect(editor.fragment.toString()).not.toContain('not a row');
        peer.fragment.insert(0, [paragraph('and more')]);
        peer.send();
        expect(editor.mended()).toBeGreaterThan(0);
        expect(editor.fragment.toString()).not.toContain('not a row');
        expect(editor.fragment.toString()).not.toContain('a row without a table');
        expect(editor.text().textContent).toContain('and more');
        expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
      });

      // The review of pull request 44: the plugin of the binding writes the text back at each change of the
      // view, and that skipped the checks of the mending (5 MB, the shape of the document). A click changes
      // no node the binding made, which the library skips, so the change here is one that got past the
      // filter of the editor and is in the text: it is not written, and the text is made again, mended, later.
      it('writes nothing at a change of the view either, and has what is owed mended, with its checks, when it can be edited', async () => {
        const document = holding(1);
        const editor = open(document, false);
        const peer = peerOf(document);
        ((peer.fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement).push([paragraph('not a row')]);
        peer.send();
        const arrived = bytes(document);
        const written: unknown[] = [];
        document.on('update', (_update: Uint8Array, origin: unknown) => {
          if (origin !== 'peer') written.push(origin);
        });
        // As the plugin of the binding does at each change of the view.
        const view = editor.typed();
        editor.binding._prosemirrorChanged(editor.text());
        view.dispatch(view.state.tr.insertText('typed ', 1));
        editor.binding._prosemirrorChanged(view.state.doc);
        expect(written).toEqual([]);
        expect(bytes(document)).toBe(arrived);
        expect(editor.fragment.toString()).toContain('not a row');
        editor.setEditable(true);
        await new Promise((done) => setTimeout(done, 0));
        expect(editor.mended()).toBeGreaterThan(0);
        expect(editor.fragment.toString()).not.toContain('not a row');
        expect(editor.fragment.toString()).not.toContain('typed');
        expect(yXmlFragmentToProseMirrorRootNode(editor.fragment, schema).eq(editor.text())).toBe(true);
      });

      it('mends what is owed before what the member types is written, so that it is not the member’s to undo', async () => {
        const document = holding(1);
        const editor = open(document, false);
        const peer = peerOf(document);
        ((peer.fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement).push([paragraph('not a row')]);
        peer.send();
        expect(editor.mended()).toBe(0);
        editor.setEditable(true);
        await new Promise((done) => setTimeout(done, 0));
        expect(editor.mended()).toBeGreaterThan(0);
        expect(editor.fragment.toString()).not.toContain('not a row');
        expect(editor.undo.undoStack).toEqual([]);
        const view = editor.typed();
        view.dispatch(view.state.tr.insertText('typed ', 1));
        editor.binding._prosemirrorChanged(view.state.doc);
        expect(editor.fragment.toString()).toContain('typed KEEP-THIS');
        expect(editor.fragment.toString()).not.toContain('not a row');
        expect(editor.mended()).toBeGreaterThan(0);
        expect(editor.undo.undoStack).toHaveLength(1);
        editor.undo.undo();
        expect(editor.fragment.toString()).not.toContain('not a row');
        expect(editor.fragment.toString()).not.toContain('typed');
      });

      // The review of pull request 35, S5: nothing held it to once.
      it('mends what is owed once: the text is not made again at every later change of the view', async () => {
        const document = holding(1);
        const editor = open(document, false);
        const peer = peerOf(document);
        ((peer.fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement).push([paragraph('not a row')]);
        peer.send();
        editor.setEditable(true);
        await new Promise((done) => setTimeout(done, 0));
        expect(editor.fragment.toString()).not.toContain('not a row');
        const [mended, dispatched] = [editor.mended(), editor.dispatched()];
        expect(mended).toBeGreaterThan(0);
        // The view changes again and again, as it does at every key: nothing more is made or written.
        for (let changes = 0; changes < 5; changes += 1) editor.setEditable(true);
        await new Promise((done) => setTimeout(done, 0));
        expect(editor.dispatched()).toBe(dispatched);
        expect(editor.mended()).toBe(mended);
        // Not editable for a while, with nothing left out meanwhile: nothing is owed when it is editable again.
        editor.setEditable(false);
        peer.fragment.push([paragraph('more')]);
        peer.send();
        const then = editor.dispatched();
        editor.setEditable(true);
        await new Promise((done) => setTimeout(done, 0));
        expect(editor.dispatched()).toBe(then);
        expect(editor.mended()).toBe(mended);
      });
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
function open(document: Y.Doc, editable = true) {
  const fragment = document.getXmlFragment('default');
  let state = EditorState.create({ schema, plugins: [ySyncPlugin(fragment)] });
  // The most tables of any text the view was handed: what a page would have laid out. And how often it was handed one.
  let dispatched = 0;
  let most = 0;
  // What this browser wrote to the shared document as a mending.
  const mended: Uint8Array[] = [];
  document.on('update', (update: Uint8Array, origin: unknown) => {
    if (origin === 'mend') mended.push(update);
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: Transaction) {
      most = Math.max(most, tableCount(transaction.doc));
      dispatched += 1;
      state = state.apply(transaction);
    },
    hasFocus: () => false,
    // As the view of the editor says whether the text can be edited.
    editable,
  };
  const unshown = vi.fn();
  const unrepairable = vi.fn();
  const { binding } = ySyncPluginKey.getState(state) as { binding: ProsemirrorBinding };
  const settle = holdBinding(view as never, unshown, unrepairable);
  // As the plugin of the binding starts it (@tiptap/y-tiptap, `ySyncPlugin`, `view`).
  binding.initView(view);
  binding._forceRerender();
  // The history of undo, as the editor's plugin makes it: what the binding writes is tracked.
  const undo = new Y.UndoManager(fragment, { trackedOrigins: new Set([ySyncPluginKey]) });
  return {
    fragment,
    binding,
    unshown,
    unrepairable,
    undo,
    text: () => state.doc,
    typed: () => view,
    most: () => most,
    dispatched: () => dispatched,
    mended: () => mended.length,
    mends: () => mended,
    // As the plugin of the binding is told of each change of the view (./extensions.tsx).
    setEditable: (can: boolean) => {
      view.editable = can;
      settle();
    },
  };
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

// Register D185, D190 (S13-1, answered on 18 October 2026): a browser that cannot edit a
// document shows what the schema can show of it, built from the shared document, and
// writes nothing to it, no repair and no update. When an editor's browser repairs the
// document, the reader's view follows (docs/plan/reader-view.md).
describe('a browser that cannot edit the document', () => {
  // The reader shows at most once in a tenth of a second: time is the test's.
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());
  const tick = () => vi.advanceTimersByTimeAsync(1000);
  const state = (document: Y.Doc) => Buffer.from(Y.encodeStateAsUpdate(document)).toString('base64');
  const copy = (document: Y.Doc) => {
    const made = new Y.Doc();
    Y.applyUpdate(made, Y.encodeStateAsUpdate(document));
    return made;
  };
  /** A reader's view, as the editor holds it (`followShared`), and every update that left the shared document. */
  function reading(document: Y.Doc) {
    let current = EditorState.create({ schema });
    let dispatched = 0;
    const view = {
      get state() {
        return current;
      },
      dispatch(transaction: Transaction) {
        dispatched += 1;
        current = current.apply(transaction);
      },
    };
    // What this browser sent: every update of the document that did not come from the peer.
    const sent: unknown[] = [];
    document.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin !== 'peer') sent.push(origin);
    });
    const unshown = vi.fn();
    const stop = followShared(view as never, document, unshown);
    return {
      view,
      unshown,
      sent,
      stop,
      text: () => current.doc,
      dispatched: () => dispatched,
      // As a click or a drag in the text changes the view.
      selects: () => view.dispatch(current.tr.setSelection(TextSelection.create(current.doc, 2))),
    };
  }
  const base = () => {
    const document = new Y.Doc();
    document.getXmlFragment('default').push([paragraph('before'), paragraph('KEEP-THIS')]);
    return document;
  };

  // What the schema leaves out, or fills, and what a reader is then shown.
  const CASES: [string, (fragment: Y.XmlFragment) => void, string, ((doc: PMNode) => void)?][] = [
    ['text standing directly in the document', (f) => f.insert(1, [words('stray')]), 'beforeKEEP-THIS'],
    ['a row without a table', (f) => f.insert(1, [rowOf('stray')]), 'beforeKEEP-THIS'],
    [
      'a cell without a row',
      (f) => f.insert(1, [element('tableCell', {}, [paragraph('stray')])]),
      'beforeKEEP-THIS',
    ],
    [
      'a table without its block',
      (f) => f.insert(1, [element('table', {}, [rowOf('stray')])]),
      'beforeKEEP-THIS',
    ],
    [
      'a caption without a table',
      (f) => f.insert(1, [element('tableCaption', {}, [words('stray')])]),
      'beforeKEEP-THIS',
    ],
    [
      'an item without a list',
      (f) => f.insert(1, [element('listItem', {}, [paragraph('stray')])]),
      'beforeKEEP-THIS',
    ],
    [
      'a node of no type',
      (f) => f.insert(1, [element('noSuchNode', {}, [words('stray')])]),
      'beforeKEEP-THIS',
    ],
    [
      'a node of no type in a quote',
      (f) =>
        f.push([
          element('blockquote', {}, [paragraph('inner'), element('noSuchNode', {}, [words('stray')])]),
        ]),
      'beforeKEEP-THISinner',
    ],
    [
      'a mark of no type',
      (f) => f.push([paragraph('marked', { noSuchMark: { a: 1 } })]),
      'beforeKEEP-THISmarked',
    ],
    [
      'an emptied element',
      (f) => f.push([element('blockquote')]),
      'beforeKEEP-THIS',
      (doc) => {
        expect(doc.lastChild!.type.name).toBe('blockquote');
        expect(doc.lastChild!.childCount).toBe(1);
      },
    ],
    [
      'a table past its bound',
      (f) => f.push([blockOf(Array.from({ length: TABLE_MOST + 1 }, (_, at) => rowOf(`r${at}`)))]),
      `beforeKEEP-THIS${Array.from({ length: TABLE_MOST }, (_, at) => `r${at}`).join('')}caption`,
      (doc) => expect(doc.lastChild!.firstChild!.childCount).toBe(TABLE_MOST),
    ],
    [
      'a document past the limit of tables',
      (f) => f.push(Array.from({ length: 101 }, () => blockOf([rowOf('t')], words('')))),
      `beforeKEEP-THIS${'t'.repeat(101)}`,
      (doc) => expect(doc.childCount).toBe(103),
    ],
  ];

  describe.each(CASES)('%s', (_, make, expected, check) => {
    // (a) writes nothing, (b) shows what the schema can show.
    it.each(['is in the document when it is opened', 'arrives in a document that is open'] as const)(
      'is shown without it, and nothing is written, where it %s',
      async (when) => {
        const document = base();
        const peer = peerOf(document);
        if (when.startsWith('is in')) {
          make(document.getXmlFragment('default'));
        } else {
          make(peer.fragment);
        }
        const reader = reading(document);
        if (when.startsWith('arrives')) {
          expect(reader.text().textContent).toBe('beforeKEEP-THIS');
          peer.send();
          await tick();
        }
        const arrived = state(document);
        expect(reader.text().textContent).toBe(expected);
        check?.(reader.text());
        reader.selects();
        await tick();
        // Nothing left the shared document, and it holds what it held.
        expect(reader.sent).toEqual([]);
        expect(state(document)).toBe(arrived);
        expect(reader.unshown).not.toHaveBeenCalled();
        expect(reader.text().check()).toBeUndefined();
        // And it is what an editor's browser shows once it has mended.
        const editor = open(copy(document));
        expect(editor.unshown).not.toHaveBeenCalled();
        expect(editor.text().eq(reader.text())).toBe(true);
      },
    );

    // (c) the reader follows the repair, and what the editor writes after it.
    it('is repaired by an editor’s browser, and the reader’s view stays and follows', async () => {
      const shared = base();
      make(shared.getXmlFragment('default'));
      const [theirs, mine] = [copy(shared), copy(shared)];
      const reader = reading(theirs);
      // What the editor's browser writes reaches the reader, as the server sends it.
      mine.on('update', (update: Uint8Array) => Y.applyUpdate(theirs, update, 'peer'));
      const before = reader.text();
      const editor = open(mine);
      await tick();
      expect(editor.unshown).not.toHaveBeenCalled();
      // Where the editor repaired the document, the repair arrived at the reader, and changed
      // nothing it shows.
      expect(state(theirs) !== state(shared)).toBe(editor.mended() > 0);
      expect(reader.text().eq(before)).toBe(true);
      const view = editor.typed();
      view.dispatch(view.state.tr.insertText('typed ', 1));
      editor.binding._prosemirrorChanged(view.state.doc);
      await tick();
      expect(reader.text().textContent).toContain('typed before');
      expect(reader.text().eq(editor.text())).toBe(true);
      expect(reader.sent).toEqual([]);
    });
  });

  it('follows the repair that deletes what the reader was not shown, in a document that held it', async () => {
    const shared = base();
    shared.getXmlFragment('default').insert(1, [words('stray-text'), rowOf('stray-row')]);
    const [theirs, mine] = [copy(shared), copy(shared)];
    const reader = reading(theirs);
    mine.on('update', (update: Uint8Array) => Y.applyUpdate(theirs, update, 'peer'));
    expect(theirs.getXmlFragment('default').toString()).toContain('stray-text');
    const before = reader.text();
    open(mine);
    await tick();
    // The editor took them out of the shared document, and the reader's copy of it follows.
    expect(mine.getXmlFragment('default').toString()).not.toContain('stray');
    expect(theirs.getXmlFragment('default').toString()).not.toContain('stray');
    expect(reader.text().eq(before)).toBe(true);
    expect(reader.sent).toEqual([]);
  });

  it('makes the text once for the changes of one moment', async () => {
    const document = base();
    const peer = peerOf(document);
    const reader = reading(document);
    const first = reader.dispatched();
    for (const written of ['one', 'two', 'three']) {
      peer.fragment.push([paragraph(written)]);
      peer.send();
    }
    await tick();
    expect(reader.text().textContent).toBe('beforeKEEP-THISonetwothree');
    expect(reader.dispatched() - first).toBe(1);
  });

  it('keeps a selection in a part that did not change', async () => {
    const document = base();
    const peer = peerOf(document);
    const reader = reading(document);
    reader.view.dispatch(
      reader.view.state.tr.setSelection(TextSelection.create(reader.view.state.doc, 9, 12)),
    );
    peer.fragment.push([paragraph('after')]);
    peer.send();
    await tick();
    const { from, to } = reader.view.state.selection;
    expect([from, to]).toEqual([9, 12]);
    expect(reader.text().textContent).toBe('beforeKEEP-THISafter');
  });

  it('shows the empty document where nothing but strays is held', async () => {
    const document = new Y.Doc();
    document.getXmlFragment('default').push([words('stray'), rowOf('stray')]);
    const arrived = state(document);
    const reader = reading(document);
    expect(reader.text().toString()).toBe('doc(paragraph)');
    expect(reader.sent).toEqual([]);
    expect(state(document)).toBe(arrived);
  });

  it('says once that a document that cannot be built cannot, and writes nothing', async () => {
    const document = base();
    let parent: Y.XmlFragment = document.getXmlFragment('default');
    document.transact(() => {
      for (let level = 0; level < 10_000; level += 1) {
        const quote = new Y.XmlElement('blockquote');
        parent.insert(0, [quote]);
        parent = quote;
      }
      parent.insert(0, [paragraph('deep')]);
    });
    const reader = reading(document);
    expect(reader.unshown).toHaveBeenCalledTimes(1);
    const peer = peerOf(document);
    peer.fragment.push([paragraph('more')]);
    peer.send();
    await tick();
    expect(reader.unshown).toHaveBeenCalledTimes(1);
    expect(reader.sent).toEqual([]);
    expect(reader.text().textContent).toBe('');
  });

  it('shows at most once in a tenth of a second however many updates arrive, and ends on the last', async () => {
    const document = base();
    const peer = peerOf(document);
    const reader = reading(document);
    const first = reader.dispatched();
    // Two hundred separate messages, one every 10 ms: 2 seconds.
    for (let at = 0; at < 200; at += 1) {
      peer.fragment.push([paragraph(`p${at}`)]);
      peer.send();
      await vi.advanceTimersByTimeAsync(10);
    }
    await tick();
    expect(reader.text().textContent.endsWith('p199')).toBe(true);
    expect(reader.dispatched() - first).toBeLessThanOrEqual(22);
    expect(reader.sent).toEqual([]);
  });

  it('keeps one copy, fed by the shared document, and puts it away where it wrote to it, so that it never drifts', () => {
    const document = base();
    const peer = peerOf(document);
    const held = shownCopy(document, schema);
    held.show();
    const first = held.held()!;
    expect(state(first)).toBe(state(document));
    // Fed, and the same copy.
    peer.fragment.push([paragraph('one')]);
    peer.send();
    expect(held.held()).toBe(first);
    expect(held.show().textContent).toBe('beforeKEEP-THISone');
    expect(held.held()).toBe(first);
    expect(state(first)).toBe(state(document));
    // Text standing directly in the document is taken out of the copy and not of the document:
    // the copy is put away, and holds nothing the shared document does not.
    peer.fragment.insert(1, [words('stray')]);
    peer.send();
    expect(held.show().textContent).toBe('beforeKEEP-THISone');
    expect(held.held()).toBeUndefined();
    expect(document.getXmlFragment('default').toString()).toContain('stray');
    // The next text is made of a new copy, and is the one that a new copy gives.
    peer.fragment.push([paragraph('two')]);
    peer.send();
    expect(held.show().eq(shownOf(document, schema))).toBe(true);
    expect(held.held()).toBeUndefined();
    // Once the editor has taken the stray text out, the copy is kept again, and is the shared document.
    peer.fragment.delete(1, 1);
    peer.send();
    held.show();
    expect(held.held()).toBeDefined();
    expect(state(held.held()!)).toBe(state(document));
    peer.fragment.push([paragraph('three')]);
    peer.send();
    expect(state(held.held()!)).toBe(state(document));
    expect(held.show().textContent).toBe('beforeKEEP-THISonetwothree');
    held.stop();
    expect(held.held()).toBeUndefined();
  });

  it('marks what it shows as what arrives, which an editor that cannot edit takes', () => {
    const start = EditorState.create({ schema });
    const typed = start.tr.insertText('x', 1);
    expect(mayApply(typed, false)).toBe(false);
    const shown = arrives(start.tr.insertText('x', 1));
    expect(shown.docChanged).toBe(true);
    expect(mayApply(shown, false)).toBe(true);
    expect(limitRefusal(shown, start.doc)).toBeNull();
    expect(shown.getMeta('addToHistory')).toBe(false);
  });

  it('follows from the creation of its editor to the destruction of it, whichever extension holds it', async () => {
    const document = base();
    const peer = peerOf(document);
    const unshown = vi.fn();
    const extension = extensions(document, unshown, undefined, undefined, true).find(
      (each) => each.name === 'readerView',
    )!;
    let current = EditorState.create({ schema });
    const editor = {
      view: {
        get state() {
          return current;
        },
        dispatch: (transaction: Transaction) => void (current = current.apply(transaction)),
      },
    };
    const context = { editor, options: extension.options };
    const lifecycle = extension.config as unknown as Record<
      'onCreate' | 'onDestroy',
      (this: unknown) => void
    >;
    lifecycle.onCreate.call(context);
    expect(current.doc.textContent).toBe('beforeKEEP-THIS');
    peer.fragment.push([paragraph('one')]);
    peer.send();
    await tick();
    expect(current.doc.textContent).toBe('beforeKEEP-THISone');
    lifecycle.onDestroy.call(context);
    peer.fragment.push([paragraph('two')]);
    peer.send();
    await tick();
    expect(current.doc.textContent).toBe('beforeKEEP-THISone');
  });

  it('stops following when it is stopped', async () => {
    const document = base();
    const peer = peerOf(document);
    const reader = reading(document);
    reader.stop();
    peer.fragment.push([paragraph('later')]);
    peer.send();
    await tick();
    expect(reader.text().textContent).toBe('beforeKEEP-THIS');
  });

  it('has no binding to the shared document: the editor of a reader holds none of the library’s', () => {
    const names = (list: ReturnType<typeof extensions>) => list.map((each) => each.name);
    const reads = names(extensions(new Y.Doc(), undefined, undefined, undefined, true));
    expect(reads).toContain('readerView');
    expect(reads).not.toContain('collaboration');
    const writes = names(extensions(new Y.Doc()));
    expect(writes).toContain('collaboration');
    expect(writes).not.toContain('readerView');
    // The editor of a reader has the same schema as the editor of a writer.
    expect(
      Object.keys(getSchema(extensions(new Y.Doc(), undefined, undefined, undefined, true)).nodes),
    ).toEqual(Object.keys(schema.nodes));
  });
});
