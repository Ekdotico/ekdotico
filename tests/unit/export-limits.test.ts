// What a large or a hostile document costs the Markdown export (the review of pull request 59, B2 and B3, and the
// bound of S6): time that grows as the square of a run of spaces freezes the one process that serves everyone, and a
// call that spreads a hundred thousand lines into its arguments overflows the stack after the export was counted.
// Each test here fails, in time or by a RangeError, when its fix is taken out.
import { describe, expect, it } from 'vitest';
import { MARKDOWN_MOST_BYTES, MarkdownTooLarge, renderMarkdown } from '../../src/lib/export/markdown.ts';
import type { Block, Inline, Mark, ReadDocument } from '../../src/lib/export/read.ts';
import { readDocument } from '../../src/lib/export/read.ts';
import { DOCUMENT_ID, NOW, el, stateOf, tx } from './export-fixtures.ts';

const render = (body: Block[], entries: ReadDocument['entries'] = new Map()) =>
  renderMarkdown({ title: 'T', id: DOCUMENT_ID, now: NOW, document: { body, entries }, images: new Map() });
const text = (value: string, marks: Mark[] = []): Inline => ({
  kind: 'text',
  text: value,
  marks,
});
const paragraph = (...content: Inline[]): Block => ({ kind: 'paragraph', content });

/** Runs a render and returns the milliseconds it took. */
function timed(run: () => unknown): number {
  const start = performance.now();
  run();
  return performance.now() - start;
}

// A bound of a second, where the quadratic form took minutes: a machine under load is no reason to fail, and a
// quadratic form is no reason to pass.
const BOUND_MS = 1000;

// The sizes are tried in order, the small one first: a step that takes time as the square of the size fails at the
// small one in seconds, where it would take hours at the large one (and a test that does not end is not a failure
// anyone reads).
const SMALL = 60_000;
const LARGE = 1_000_000;
function within(make: (size: number) => Block[], label: string) {
  for (const size of [SMALL, LARGE]) {
    const body = make(size);
    expect(
      timed(() => render(body)),
      `${label} at ${size}`,
    ).toBeLessThan(BOUND_MS);
  }
}

describe('time (B2): no step grows as the square of a run of white space', () => {
  it('a paragraph of a million spaces, at the end, in the middle, and alone', () => {
    for (const shape of [
      (spaces: string) => `a${spaces}`,
      (spaces: string) => `a${spaces}b`,
      (spaces: string) => spaces,
      (spaces: string) => `${spaces}a`,
      (spaces: string) => `a${spaces}\n${spaces}b`,
    ]) {
      within((size) => [paragraph(text(shape(' '.repeat(size))))], shape('_'));
    }
  });

  it('a million tabs and mixed white space, in a heading, an item, a cell and a quotation', () => {
    const blanks = (size: number) => ' \t'.repeat(size / 2);
    within((size) => [{ kind: 'heading', level: 2, content: [text(`a${blanks(size)}b`)] }], 'heading');
    within(
      (size) => [{ kind: 'list', ordered: false, start: 1, items: [[paragraph(text(`a${blanks(size)}b`))]] }],
      'list',
    );
    within((size) => [{ kind: 'quote', children: [paragraph(text(`a${blanks(size)}b`))] }], 'quote');
    within(
      (size) => [
        {
          kind: 'table',
          caption: `a${blanks(size)}b`,
          rows: [
            [{ header: false, colspan: 1, rowspan: 1, children: [paragraph(text(`a${blanks(size)}b`))] }],
          ],
        },
      ],
      'table',
    );
  });

  it('white space inside marks, and at the end of a run that closes one', () => {
    within((size) => {
      const spaces = ' '.repeat(size / 2);
      return [
        paragraph(
          text(`a${spaces}`, [{ name: 'bold' }]),
          text(spaces, [{ name: 'italic' }]),
          text(`${spaces}b${spaces}`, [{ name: 'link', href: 'https://a.test/' }]),
          text(spaces),
        ),
      ];
    }, 'marks');
  });

  it('a code span of a million spaces, and a run of a million backticks', () => {
    within((size) => [paragraph(text(` a${' '.repeat(size)}`, [{ name: 'code' }]))], 'code span of spaces');
    within((size) => [paragraph(text('`'.repeat(size), [{ name: 'code' }]))], 'code span of backticks');
    within((size) => [{ kind: 'code', language: null, text: '`'.repeat(size) }], 'code block of backticks');
  });

  it('50,000 runs that alternate a mark', () => {
    for (const size of [10_000, 50_000]) {
      const runs = Array.from({ length: size }, (_, at) => text('ab ', at % 2 ? [{ name: 'bold' }] : []));
      expect(
        timed(() => render([paragraph(...runs)])),
        `bold at ${size}`,
      ).toBeLessThan(BOUND_MS);
      const links = Array.from({ length: size }, (_, at) =>
        text(' x ', at % 2 ? [{ name: 'link', href: `https://a.test/${at % 7}` }] : [{ name: 'italic' }]),
      );
      expect(
        timed(() => render([paragraph(...links)])),
        `links at ${size}`,
      ).toBeLessThan(BOUND_MS);
    }
  });

  it('a hundred thousand line breaks between spaces', () => {
    within((size) => [paragraph(text(' \n'.repeat(size / 10) + 'a'))], 'lines of a space');
    within((size) => [paragraph(text('a \n'.repeat(size / 10)))], 'lines of a word and a space');
  });
});

describe('the stack (B3): no call has an argument for each line or run', () => {
  it('a code block of 300,000 lines', () => {
    const out = render([{ kind: 'code', language: null, text: 'x\n'.repeat(300_000) }]);
    expect(out.split('\n').length).toBeGreaterThan(300_000);
  });

  it('a code block and a code span with 300,000 runs of backticks', () => {
    // The fence is the longest run of backticks plus one: every run was an argument of one `Math.max`.
    const out = render([
      { kind: 'code', language: null, text: '`\n'.repeat(300_000) },
      paragraph(text('`a'.repeat(300_000), [{ name: 'code' }])),
    ]);
    expect(out).toContain('```\n`\n');
    expect(out).toContain('`` `a`a');
  });

  it('a paragraph of 200,000 line breaks', () => {
    const out = render([paragraph(text('a\n'.repeat(200_000) + 'b'))]);
    expect(out.split('\n').length).toBeGreaterThan(200_000);
  });

  it('a quotation of 150,000 paragraphs, and a callout, a list and a table of as many', () => {
    const children = Array.from({ length: 150_000 }, () => paragraph(text('x')));
    expect(render([{ kind: 'quote', children }]).split('\n').length).toBeGreaterThan(150_000);
    expect(render([{ kind: 'callout', variant: 'tip', children }]).split('\n').length).toBeGreaterThan(
      150_000,
    );
    expect(
      render([{ kind: 'list', ordered: true, start: 1, items: [children] }]).split('\n').length,
    ).toBeGreaterThan(150_000);
    const out = render([
      {
        kind: 'table',
        caption: '',
        rows: [[{ header: false, colspan: 1, rowspan: 1, children }]],
      },
    ]);
    expect(out).toContain('x<br>x');
  });

  it('a cell whose code holds 200,000 lines, and a table of 100,000 rows', () => {
    const cellOf = (children: Block[]) => ({ header: false, colspan: 1, rowspan: 1, children });
    expect(
      render([
        {
          kind: 'table',
          caption: '',
          rows: [[cellOf([{ kind: 'code', language: null, text: 'y\n'.repeat(200_000) }])]],
        },
      ]),
    ).toContain('`y`<br>`y`');
    const rows = Array.from({ length: 100_000 }, () => [cellOf([paragraph(text('r'))])]);
    expect(render([{ kind: 'table', caption: '', rows }]).split('\n').length).toBeGreaterThan(100_000);
  });

  it('a footnote of 200,000 lines, and 100,000 footnotes', () => {
    const lines = text('f\n'.repeat(200_000) + 'g');
    const one = render(
      [paragraph(text('a'), { kind: 'note', id: 'n'.repeat(24) })],
      new Map([['n'.repeat(24), [lines]]]),
    );
    expect(one.split('\n').length).toBeGreaterThan(200_000);
    const ids = Array.from({ length: 100_000 }, (_, at) => String(at).padStart(24, '0'));
    const many = render(
      [paragraph(...ids.map((id): Inline => ({ kind: 'note', id })))],
      new Map(ids.map((id) => [id, [text('w x')]])),
    );
    expect(many.split('\n').length).toBeGreaterThan(100_000);
  });

  it('a stored document of 130,000 runs in one paragraph, read as it is stored', () => {
    // `readDocument` turned each op of a run into an argument of one call. A mark that alternates keeps the ops
    // from being merged into one.
    const run = tx('a', { bold: {} });
    for (let at = 1; at < 130_000; at += 1) run.insert(run.length, 'a', at % 2 ? {} : { bold: {} });
    const read = readDocument(stateOf(el('paragraph', {}, run)));
    expect(read.body).toHaveLength(1);
    const out = renderMarkdown({
      title: 'T',
      id: DOCUMENT_ID,
      now: NOW,
      document: read,
      images: new Map(),
    });
    expect(out.length).toBeGreaterThan(130_000);
  });

  it('nesting past the depth a document may have, without a stack overflow', () => {
    let block: Block = paragraph(text('deep'));
    for (let depth = 0; depth < 3000; depth += 1) block = { kind: 'quote', children: [block] };
    expect(() => render([block])).not.toThrow();
    let list: Block = paragraph(text('deep'));
    for (let depth = 0; depth < 3000; depth += 1)
      list = { kind: 'list', ordered: false, start: 1, items: [[list]] };
    expect(() => render([list])).not.toThrow();
  });
});

describe('the bound (S6): the file is asked while it is written', () => {
  it('stops at the block that passes the bound, and does not go on to write the rest', () => {
    // 100 paragraphs of a thirtieth of the bound: the file passes it at the 31st. The blocks are counted as they
    // are met, so that a check made after them all (the file's own, which stays as a backstop) is told apart.
    const big = 'x'.repeat(Math.floor(MARKDOWN_MOST_BYTES / 30));
    let visited = 0;
    const children = Array.from({ length: 100 }, () => paragraph(text(big)));
    Object.defineProperty(children, Symbol.iterator, {
      value: function* () {
        for (let at = 0; at < 100; at += 1) {
          visited += 1;
          yield children[at]!;
        }
      },
    });
    expect(() => render([{ kind: 'quote', children }])).toThrow(MarkdownTooLarge);
    expect(visited).toBeLessThan(40);
  });

  it('counts what a quotation and a list put before each line, which the text does not hold', () => {
    // 15 bytes a line, so that the 2 of a quotation are an eighth more: 31 MB of code is under the bound, and
    // quoted is over it.
    const lines = Math.floor((MARKDOWN_MOST_BYTES * 0.92) / 15);
    const code: Block = { kind: 'code', language: null, text: 'xxxxxxxxxxxxxx\n'.repeat(lines) };
    expect(render([code]).length).toBeGreaterThan(lines * 15);
    expect(() => render([{ kind: 'quote', children: [code] }])).toThrow(MarkdownTooLarge);
    expect(() => render([{ kind: 'list', ordered: false, start: 1, items: [[code]] }])).toThrow(
      MarkdownTooLarge,
    );
  });

  it('stops a document of many small blocks, none of which is large', () => {
    const big = 'é'.repeat(Math.ceil(MARKDOWN_MOST_BYTES / 2 / 8) + 10);
    const blocks = Array.from({ length: 9 }, () => paragraph(text(big)));
    expect(() => render(blocks)).toThrow(MarkdownTooLarge);
  });
});
