// A stored state read for the export (src/lib/export/read.ts): what the editor writes, read back whole; each rule
// the editor holds an attribute to, held to again value by value against the editor's own module; and the shapes no
// editor makes, none of which may throw or come out as anything but the editor would show.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { ATTRIBUTE_RULES } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { readDocument, imageIdsOf, type Block } from '../../src/lib/export/read.ts';
import {
  bodyOf,
  bullets,
  cell,
  editorState,
  el,
  entry,
  heading,
  image,
  item,
  md,
  note,
  notes,
  ordered,
  p,
  row,
  stateOf,
  table,
  tx,
} from './export-fixtures.ts';

const IMAGE = `c${'a'.repeat(24)}`;
const NOTE = 'f'.repeat(24);
const text = (value: string, ...marks: { type: string; attrs?: object }[]) => ({
  type: 'text',
  text: value,
  ...(marks.length ? { marks } : {}),
});

describe('a document as the editor writes it', () => {
  it('is read back whole, node by node and mark by mark, and written as the table of FR-EX-36 says', () => {
    const json = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [text('Chapter')] },
        {
          type: 'paragraph',
          content: [
            text('Plain, '),
            text('bold', { type: 'bold' }),
            text(' and '),
            text('both', { type: 'bold' }, { type: 'italic' }),
            text(' and '),
            text('struck', { type: 'strike' }),
            text(' and '),
            text('code', { type: 'code' }),
            text(' and '),
            text('link', { type: 'link', attrs: { href: 'https://example.test/' } }),
            { type: 'hardBreak' },
            text('under', { type: 'underline' }),
            text(' sup', { type: 'superscript' }),
            text(' sub', { type: 'subscript' }),
            text(' high', { type: 'highlight' }),
            { type: 'footnoteReference', attrs: { id: NOTE } },
          ],
        },
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [{ type: 'paragraph', content: [text('one')] }] },
            {
              type: 'listItem',
              content: [
                { type: 'paragraph', content: [text('two')] },
                {
                  type: 'orderedList',
                  attrs: { start: 4 },
                  content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [text('four')] }] }],
                },
              ],
            },
          ],
        },
        { type: 'blockquote', content: [{ type: 'paragraph', content: [text('quoted')] }] },
        {
          type: 'callout',
          attrs: { type: 'tip' },
          content: [{ type: 'paragraph', content: [text('a tip')] }],
        },
        { type: 'codeBlock', attrs: { language: 'python' }, content: [text('print(1)\nprint(2)')] },
        { type: 'horizontalRule' },
        { type: 'pageBreak' },
        { type: 'tableOfContents', attrs: { depth: 3 } },
        {
          type: 'tableBlock',
          content: [
            {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('H1')] }] },
                    { type: 'tableHeader', content: [{ type: 'paragraph', content: [text('H2')] }] },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    { type: 'tableCell', content: [{ type: 'paragraph', content: [text('a')] }] },
                    { type: 'tableCell', content: [{ type: 'paragraph', content: [text('b')] }] },
                  ],
                },
              ],
            },
            { type: 'tableCaption', content: [text('A table')] },
          ],
        },
        { type: 'image', attrs: { id: IMAGE, alt: 'An image', caption: 'Figure 1', width: 50 } },
        { type: 'paragraph', content: [text('Last.')] },
        {
          type: 'footnotes',
          content: [
            {
              type: 'footnote',
              attrs: { id: NOTE },
              content: [text('The '), text('note', { type: 'italic' })],
            },
          ],
        },
      ],
    };
    expect(bodyOf(editorState(json))).toBe(
      [
        '## Chapter',
        '',
        'Plain, **bold** and ***both*** and ~~struck~~ and `code` and [link](https://example.test/)\\',
        '<u>under</u> <sup>sup</sup> <sub>sub</sub> <mark>high</mark>[^1]',
        '',
        '- one',
        '- two',
        '  4. four',
        '',
        '> quoted',
        '',
        '> **Tip**',
        '>',
        '> a tip',
        '',
        '```python',
        'print(1)',
        'print(2)',
        '```',
        '',
        '---',
        '',
        '| H1 | H2 |',
        '| --- | --- |',
        '| a | b |',
        '',
        'A table',
        '',
        '![An image](images/001.png)',
        '',
        'Figure 1',
        '',
        'Last.',
        '',
        '[^1]: The *note*',
        '',
      ].join('\n'),
    );
  });

  it('finds the image of a block wherever it stands, each once, in the order of the document', () => {
    const second = `c${'b'.repeat(24)}`;
    const blocks = readDocument(
      stateOf(
        image({ id: second, alt: 'second' }),
        bullets(item(p('x'), el('blockquote', {}, image({ id: IMAGE })))),
        table('', row(cell({}, image({ id: second })))),
        el('callout', {}, p('c')),
        image({ id: 'not-an-identifier' }),
      ),
    ).body;
    expect(imageIdsOf(blocks)).toEqual([second, IMAGE]);
  });
});

// The values an attribute can arrive as (the editor's own list in tests/unit/editor-schema.test.ts, shortened).
const HOSTILE: unknown[] = [
  5,
  0,
  -1,
  1.5,
  3,
  2,
  101,
  100,
  9999,
  10_000,
  1e9,
  Number.MAX_SAFE_INTEGER,
  Infinity,
  NaN,
  '2',
  '',
  'html',
  'note',
  'warning',
  'tip',
  'python',
  'no-such-language',
  '"><script>alert(1)</script>',
  'javascript:alert(1)',
  true,
  false,
  null,
  undefined,
  {},
  { a: 1 },
  [],
  [1],
  'a',
  'A',
];

function levelOf(value: unknown): number {
  const [block] = readDocument(stateOf(el('heading', { level: value }, tx('x')))).body;
  return block?.kind === 'heading' ? block.level : -1;
}

describe('an attribute is held to the rule the editor holds it to', () => {
  it('for the level of a heading', () => {
    for (const value of HOSTILE)
      expect(levelOf(value), String(value)).toBe(ATTRIBUTE_RULES.heading!.level!(value, {}));
  });

  it('for the type of a callout', () => {
    for (const value of HOSTILE) {
      const [block] = readDocument(stateOf(el('callout', { type: value }, p('x')))).body;
      const rule = ATTRIBUTE_RULES.callout!.type!(value, {});
      expect(block?.kind === 'callout' ? block.variant : null, String(value)).toBe(rule);
    }
  });

  it('for the language of a code block', () => {
    for (const value of HOSTILE) {
      const [block] = readDocument(stateOf(el('codeBlock', { language: value }, tx('x')))).body;
      const rule = ATTRIBUTE_RULES.codeBlock!.language!(value, {});
      expect(block?.kind === 'code' ? (block.language ?? 'plaintext') : null, String(value)).toBe(rule);
    }
  });

  it('for the start of an ordered list', () => {
    for (const value of HOSTILE) {
      const [block] = readDocument(stateOf(ordered(value, item(p('x'))))).body;
      expect(block?.kind === 'list' ? block.start : null, String(value)).toBe(
        ATTRIBUTE_RULES.orderedList!.start!(value, {}),
      );
    }
  });

  it('for the spans of a cell', () => {
    for (const value of HOSTILE) {
      // Two rows, so that a span of two fits and a longer one reaches below the last.
      const [block] = readDocument(
        stateOf(table('', row(cell({ colspan: value, rowspan: value }, p('x'))), row(cell({})))),
      ).body;
      const spans = block?.kind === 'table' ? block.rows[0]![0]! : null;
      const colspan = ATTRIBUTE_RULES.tableCell!.colspan!(value, {});
      expect(spans?.colspan, String(value)).toBe(colspan);
      // A cell that reaches below the last row spans one row, as the editor closes a grid.
      const rowspan = ATTRIBUTE_RULES.tableCell!.rowspan!(value, {}) as number;
      expect(spans?.rowspan, String(value)).toBe(rowspan > 2 ? 1 : rowspan);
    }
  });

  it('for the address of a link', () => {
    for (const value of [
      ...HOSTILE,
      'https://example.test/',
      'mailto:a@b.test',
      'HTTPS://X.TEST',
      'ftp://x.test',
    ]) {
      const [block] = readDocument(stateOf(p(tx('x', { link: { href: value } })))).body;
      const mark =
        block?.kind === 'paragraph' && block.content[0]?.kind === 'text'
          ? block.content[0].marks[0]
          : undefined;
      const rule = ATTRIBUTE_RULES.link!.href!(value, {});
      expect(mark?.name === 'link' ? mark.href : null, String(value)).toBe(rule);
    }
  });

  it('for the attributes of an image', () => {
    for (const value of [...HOSTILE, IMAGE, 'x'.repeat(1001), 'y'.repeat(501)]) {
      const [block] = readDocument(stateOf(image({ id: value, alt: value, caption: value }))).body;
      expect(block?.kind).toBe('image');
      if (block?.kind !== 'image') continue;
      expect(block.id, String(value)).toBe(ATTRIBUTE_RULES.image!.id!(value, {}));
      expect(block.alt, String(value)).toBe(ATTRIBUTE_RULES.image!.alt!(value, {}));
      expect(block.caption, String(value)).toBe(ATTRIBUTE_RULES.image!.caption!(value, {}));
    }
  });

  it('for the identifier of a footnote, in the marker and in the entry', () => {
    for (const value of [...HOSTILE, NOTE, NOTE.toUpperCase(), `${NOTE}0`]) {
      const rule = ATTRIBUTE_RULES.footnoteReference!.id!(value, {});
      const document = readDocument(stateOf(p(note(value)), notes(entry(value, 'words'))));
      const marker = document.body[0]?.kind === 'paragraph' ? document.body[0].content[0] : undefined;
      expect(marker?.kind === 'note' ? marker.id : 'none', String(value)).toBe(rule);
      expect([...document.entries.keys()], String(value)).toEqual(rule === null ? [] : [rule]);
    }
  });
});

describe('a state no editor writes', () => {
  const read = (...blocks: (Y.XmlElement | Y.XmlText)[]) => readDocument(stateOf(...blocks)).body;

  it('is read as the editor shows it: a node it has no type for, and text among the blocks, are left out', () => {
    expect(
      read(
        p('a'),
        el('__proto__'),
        el('constructor', {}, p('c')),
        tx('stray'),
        el('tableRow', {}, el('tableCell', {}, p('x'))),
      ),
    ).toHaveLength(1);
  });

  it('is read where a Yjs value is no text and no element, whether an attribute or a child', () => {
    // Each element is made again for each state: one that has been put in a document cannot be put in another.
    const odd = () => {
      const paragraph = el('paragraph', {
        level: new Y.Map(),
        id: new Y.Array(),
        alt: new Y.Text('x') as unknown,
      });
      paragraph.insert(0, [tx('text'), el('hardBreak'), el('footnoteReference', { id: new Y.Map() })]);
      return paragraph;
    };
    const [block] = read(
      odd(),
      el('image', { id: new Y.Map(), alt: new Y.Array(), caption: new Y.Text('c') }),
    );
    expect(block).toMatchObject({ kind: 'paragraph' });
    expect(md(odd())).toBe('text\n');
  });

  it('is read where the marks of a run are not marks: a name that is none, a value that is no object', () => {
    for (const marks of [
      { bold: 5 },
      { bold: null },
      { link: 'https://x.test' },
      { link: null },
      { link: 5 },
      { '': {} },
      { 'link--': { href: 'https://x.test' } },
      { constructor: {}, hasOwnProperty: {} },
    ]) {
      expect(() => md(p(tx('x', marks))), JSON.stringify(marks)).not.toThrow();
    }
    expect(md(p(tx('x', { bold: 5 })))).toBe('**x**\n');
  });

  it('is read at any depth, and the depth the server holds a document to is read and no more', () => {
    let deep: Y.XmlElement = p('bottom');
    for (let level = 0; level < 300; level += 1) deep = el('blockquote', {}, deep);
    expect(() => md(deep)).not.toThrow();
    let shallow: Y.XmlElement = p('bottom');
    for (let level = 0; level < 20; level += 1) shallow = el('blockquote', {}, shallow);
    expect(md(shallow)).toBe(`${'> '.repeat(20)}bottom\n`);
  });

  it('is read for a table that is far past the bounds of the editor, with the spans closed as the editor closes them', () => {
    const wide = () =>
      row(...Array.from({ length: 150 }, () => cell({ colspan: 100, rowspan: 100 }, p('x'))));
    const [block] = read(el('tableBlock', {}, el('table', {}, wide(), wide()), el('tableCaption')));
    expect(
      block?.kind === 'table'
        ? block.rows.flat().every((each) => each.colspan === 1 && each.rowspan === 1)
        : null,
    ).toBe(true);
  });

  it('reads a state that was never stored, and refuses bytes that are no state', () => {
    expect(readDocument(null)).toEqual({ body: [], entries: new Map() });
    expect(() => readDocument(new Uint8Array([255, 255, 255, 255, 255, 255]))).toThrow();
  });

  it('is read into a tree that holds nothing of the Yjs document, which is destroyed', () => {
    const state = stateOf(p('x'));
    const first: Block[] = readDocument(state).body;
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
  });

  it('leaves a heading with only a marker and a break written as the marker alone', () => {
    expect(md(heading(1, ''), el('heading', { level: 2 }, el('hardBreak')))).toBe('');
  });
});
