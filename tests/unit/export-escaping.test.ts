// The text of a document comes out of the Markdown export as the same text, whatever it holds (FR-EX-36: "a
// character of the user's text that Markdown would read as syntax is escaped, so that the text reads as it was
// written"; NFR-SE-08, NFR-I18-03): asked of a real parser, with HTML switched on, so that anything the export lets
// through as syntax shows as a token that is no text. Each test is a place text can stand: a paragraph, an item of a
// list, a quotation, a callout, a heading, a cell of a table, the alt text and the caption of an image.
import MarkdownIt from 'markdown-it';
// @ts-expect-error -- the package ships no declarations; the test uses it as `(parser) => parser.use(plugin)`.
import footnotes from 'markdown-it-footnote';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  bodyOf,
  br,
  bullets,
  cell,
  el,
  entry,
  headerCell,
  heading,
  image,
  item,
  note,
  notes,
  ordered,
  p,
  row,
  stateOf,
  table,
  tx,
} from './export-fixtures.ts';

const parser = new MarkdownIt({ html: true });
/** The same parser with the footnotes of GitHub and Pandoc, which the export is written for. */
const withFootnotes = new MarkdownIt({ html: true }).use(
  footnotes as (md: InstanceType<typeof MarkdownIt>) => void,
);

interface Seen {
  /** The types of the block tokens, in order, closing ones left out. */
  blocks: string[];
  /** The types of the inline tokens that are no text, no code, no break. */
  syntax: string[];
  /** What a reader reads: the text, the code, and a line break where there is one. */
  text: string;
}

function read(markdown: string): Seen {
  const seen: Seen = { blocks: [], syntax: [], text: '' };
  for (const token of parser.parse(markdown, {})) {
    if (token.type !== 'inline') {
      if (!token.type.endsWith('_close')) seen.blocks.push(token.type);
      continue;
    }
    for (const child of token.children ?? []) {
      if (child.type === 'text' || child.type === 'code_inline') seen.text += child.content;
      else if (child.type === 'softbreak' || child.type === 'hardbreak') seen.text += '\n';
      else seen.syntax.push(child.type);
    }
  }
  return seen;
}

// Fragments that are syntax somewhere in Markdown, in the places that matter.
const PIECES = [
  '\\',
  '`',
  '``',
  '*',
  '**',
  '_',
  '__',
  '[',
  ']',
  '(',
  ')',
  '<',
  '>',
  '#',
  '##',
  '+',
  '-',
  '--',
  '---',
  '=',
  '==',
  '.',
  '1.',
  '12)',
  '!',
  '![',
  '](',
  '|',
  '~',
  '~~',
  '~~~',
  '```',
  '$',
  '&',
  '&amp;',
  '&#35;',
  '&lt;',
  ';',
  ':',
  '/',
  "'",
  '"',
  ' ',
  '  ',
  '    ',
  '\t',
  '\n',
  '\r\n',
  '<script>',
  '</script>',
  '<!--',
  '-->',
  '<b>',
  '<a href="x">',
  '<https://x.test>',
  'https://x.test',
  'www.x.test',
  '[x](y)',
  '[^1]',
  '[x]: y',
  '{.a}',
  '@a',
  '^',
  'a',
  'b',
  'é',
  '論',
  '📚',
  'ا',
  'Ω',
  ' ',
  '​',
];

function generated(count: number, seed: number): string[] {
  let state = seed;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
  return Array.from({ length: count }, () =>
    Array.from({ length: 1 + (next() % 9) }, () => PIECES[next() % PIECES.length]).join(''),
  );
}

/**
 * The text a reader gets back for text that was written: line ends are one, and a line break that begins or ends a
 * paragraph is nothing (Markdown has no such break), nor is the white space at the end of it.
 */
const expected = (text: string) =>
  text
    .replace(/\r\n|\r/gu, '\n')
    .replace(/^([ \t]*\n)+/u, '')
    .replace(/[ \t\n]+$/u, '');
/** Nothing is left of text that is only white space. */
const nothing = (text: string) => /^[ \t\r\n]*$/u.test(text);

const CASES = generated(4000, 20261026);

/** Runs a check on each text and reports the first few that fail, with the Markdown that was written for them. */
function forEach(texts: readonly string[], check: (text: string) => void) {
  const failed: string[] = [];
  for (const text of texts) {
    try {
      check(text);
    } catch (error) {
      const message = (error as Error).message.replace(/\s+/gu, ' ').slice(0, 300);
      failed.push(`${JSON.stringify(text)}: ${message}`);
    }
  }
  expect(failed.slice(0, 8), `${failed.length} of ${texts.length} failed`).toEqual([]);
}

describe('text in a paragraph', () => {
  it('reads back as written, for 4,000 texts made of what Markdown reads as syntax', () => {
    forEach(
      CASES.filter((text) => !nothing(text)),
      (text) => {
        const markdown = bodyOf(stateOf(p(text)));
        const seen = read(markdown);
        expect(seen.blocks, markdown).toEqual(['paragraph_open']);
        expect(seen.syntax, markdown).toEqual([]);
        expect(seen.text, markdown).toBe(expected(text));
      },
    );
  });
});

describe('text in the other places a block can stand', () => {
  const some = CASES.slice(0, 1200).filter((text) => !nothing(text));

  it('in an item of a bullet list and of an ordered list', () => {
    for (const text of some) {
      for (const state of [stateOf(bullets(item(p(text)))), stateOf(ordered(1, item(p(text))))]) {
        const seen = read(bodyOf(state));
        expect(seen.syntax, JSON.stringify(text)).toEqual([]);
        expect(seen.text, JSON.stringify(text)).toBe(expected(text));
        expect(
          seen.blocks.filter(
            (type) => !/^(bullet|ordered)_list_open$|^list_item_open$|^paragraph_open$|^inline$/u.test(type),
          ),
          JSON.stringify(text),
        ).toEqual([]);
      }
    }
  });

  it('in a quotation and a callout', () => {
    for (const text of some) {
      for (const block of [el('blockquote', {}, p(text)), el('callout', { type: 'warning' }, p(text))]) {
        const seen = read(bodyOf(stateOf(block)));
        // The label of a callout is the one bold word the file writes itself.
        const callout = block.nodeName === 'callout';
        expect(seen.syntax, JSON.stringify(text)).toEqual(callout ? ['strong_open', 'strong_close'] : []);
        const readBack = callout ? seen.text.replace(/^Warning\n?/u, '') : seen.text;
        expect(readBack, JSON.stringify(text)).toBe(expected(text));
      }
    }
  });

  it('in a heading, on one line', () => {
    for (const text of some) {
      const seen = read(bodyOf(stateOf(heading(2, text))));
      expect(seen.syntax, JSON.stringify(text)).toEqual([]);
      expect(seen.blocks, JSON.stringify(text)).toEqual(['heading_open']);
      // A line break in a heading is a space, and a heading's own white space is its markup's.
      const oneLine = text.replace(/\r\n|[\n\r]/gu, ' ').replace(/^[ \t]+|[ \t]+$/gu, '');
      expect(seen.text, JSON.stringify(text)).toBe(oneLine);
    }
  });

  it('in a cell of a table, in the header and in the body', () => {
    for (const text of some) {
      const state = stateOf(
        table(
          '',
          row(headerCell({}, p(text)), headerCell({}, p('h'))),
          row(cell({}, p(text)), cell({}, p('b'))),
        ),
      );
      const tokens = parser.parse(bodyOf(state), {});
      expect(
        tokens.filter((token) => token.type === 'table_open'),
        JSON.stringify(text),
      ).toHaveLength(1);
      // The text of each cell, with `<br>` (the one element a cell breaks a line with) read as a line break.
      const cells: string[] = [];
      tokens.forEach((token, at) => {
        if (token.type !== 'inline' || !/^(th|td)_open$/u.test(tokens[at - 1]?.type ?? '')) return;
        let cellText = '';
        for (const child of token.children ?? []) {
          if (child.type === 'text' || child.type === 'code_inline') cellText += child.content;
          else if (child.type === 'html_inline' && child.content === '<br>') cellText += '\n';
          else throw new Error(`a ${child.type} in a cell: ${child.content}`);
        }
        cells.push(cellText);
      });
      // A cell is trimmed (by `markdown-it` with `trim`, which also takes a no-break space at either end of it), and
      // a line break at either end of one breaks nothing.
      const inCell = text.replace(/\r\n|\r/gu, '\n').trim();
      expect(cells, JSON.stringify(text)).toEqual([inCell, 'h', inCell, 'b']);
    }
  });

  it('in the alt text and the caption of an image', () => {
    const id = 'c' + 'a'.repeat(24);
    for (const text of some) {
      const seen = read(bodyOf(stateOf(image({ id, alt: text.slice(0, 40), caption: text.slice(0, 40) }))));
      expect(
        seen.syntax.filter((type) => type !== 'image'),
        JSON.stringify(text),
      ).toEqual([]);
    }
  });
});

describe('the elements a file may hold', () => {
  const ALLOWED = new Set(['u', 'sup', 'sub', 'mark', 'br']);

  it('are the four of FR-EX-36 around escaped text, and the break of a cell, and no other', () => {
    const marks = { underline: {}, superscript: {}, subscript: {}, highlight: {} };
    for (const text of CASES.slice(0, 600)) {
      if (nothing(text)) continue;
      const body = bodyOf(stateOf(p(tx(text, marks)), table('', row(cell({}, p(tx(text, marks)), p(text))))));
      for (const token of parser.parse(body, {})) {
        for (const child of token.children ?? []) {
          if (child.type !== 'html_inline') continue;
          const name = /^<\/?([a-z]+)>$/u.exec(child.content)?.[1];
          expect(
            name !== undefined && ALLOWED.has(name),
            `${child.content} from ${JSON.stringify(text)}`,
          ).toBe(true);
        }
        expect(token.type, JSON.stringify(text)).not.toBe('html_block');
      }
    }
  });

  it('hold no address but a link`s, which is the editor`s rule', () => {
    const hostile = [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:x',
      'file:///etc/passwd',
      '//evil.test/',
      'https://user:pw@evil.test/',
      'https://a.test/ b',
      'https://a.test/\u0000',
      'HTTPS:example',
      '',
    ];
    for (const href of hostile) {
      const body = bodyOf(stateOf(p(tx('click', { link: { href } }))));
      expect(read(body).syntax, href).toEqual([]);
      expect(body, href).not.toMatch(/\]\(/u);
    }
  });

  it('keep an address from ending its link, whatever it holds', () => {
    for (const href of [
      'https://a.test/x(y)z',
      'https://a.test/?a=1&amp;b=2',
      'https://a.test/<x>',
      'https://a.test/"q"',
      'mailto:a@b.test',
    ]) {
      const body = bodyOf(stateOf(p(tx('go', { link: { href } }), ' after')));
      const tokens = parser.parse(body, {}).flatMap((token) => token.children ?? []);
      const open = tokens.find((token) => token.type === 'link_open');
      expect(open, href).toBeDefined();
      const target = open!.attrGet('href')!;
      // The address that comes out of a parser is the address that went in, once the parser's own encoding is undone.
      expect(decodeURI(String(target)), href).toBe(href);
      expect(
        tokens
          .filter((token) => token.type === 'text')
          .map((token) => token.content)
          .join(''),
        href,
      ).toBe('go after');
    }
  });
});

// The review of pull request 59, S1 and S2: two ways a user's words became syntax that the text tests above did not
// reach, because the words were right and what stood beside them was not.
describe('what stands beside the text', () => {
  it('a `!` at the end of a run is not the start of an image when a link follows it', () => {
    const body = bodyOf(
      stateOf(p('Look!', tx('here', { link: { href: 'https://evil.example/pixel.png' } }))),
    );
    const seen = read(body);
    expect(seen.syntax, body).toEqual(['link_open', 'link_close']);
    expect(seen.text, body).toBe('Look!here');
    expect(body).toContain('Look\\![here](https://evil.example/pixel.png)');
    // Inside a mark that goes on, in a cell, and before a footnote marker.
    for (const content of [
      p(tx('Look!', { bold: {} }), tx('here', { bold: {}, link: { href: 'https://a.test/' } })),
      p(tx('Look!'), tx('here', { link: { href: 'https://a.test/' } }), '!', note('a'.repeat(24))),
    ]) {
      const text = bodyOf(stateOf(content, notes(entry('a'.repeat(24), 'two words'))));
      expect(
        parser
          .parse(text, {})
          .flatMap((token) => token.children ?? [])
          .map((child) => child.type),
        text,
      ).not.toContain('image');
    }
    const inCell = bodyOf(
      stateOf(
        table(
          '',
          row(headerCell({}, p('h'))),
          row(cell({}, p('Look!', tx('x', { link: { href: 'https://a.test/' } })))),
        ),
      ),
    );
    expect(read(inCell).syntax.filter((type) => type === 'image')).toEqual([]);
    expect(inCell).toContain('Look\\![x]');
  });

  it('a footnote that is one word is no link reference definition where footnotes are not known', () => {
    for (const words of [
      'https://evil.example/x',
      'javascript:alert(1)',
      '<b>',
      'evil.example',
      'x "title"',
      "x 'title'",
      'x (title)',
      'x "title',
    ]) {
      const state = stateOf(p('see', note('a'.repeat(24))), notes(entry('a'.repeat(24), words)));
      const body = bodyOf(state);
      // A renderer that has no footnotes: the marker stays text and nothing is a link.
      const plain = parser.parse(body, {}).flatMap((token) => token.children ?? []);
      expect(
        plain.map((child) => child.type),
        `${words}: ${body}`,
      ).not.toContain('link_open');
      expect(plain.some((child) => child.type === 'text' && child.content.includes('[^1]'))).toBe(true);
      // A renderer that has them: the marker is a reference, the words are the footnote's.
      const aware = withFootnotes.parse(body, {});
      const flat = aware.flatMap((token) => token.children ?? []).map((child) => child.type);
      expect(flat, `${words}: ${body}`).toContain('footnote_ref');
      expect(flat).not.toContain('link_open');
      const block = aware.findIndex((token) => token.type === 'footnote_block_open');
      expect(block, body).toBeGreaterThan(-1);
      const inside = aware
        .slice(block)
        .filter((token) => token.type === 'inline')
        .map((token) => token.content)
        .join(' ');
      expect(inside.replace(/\\/gu, ''), body).toContain(words.replace(/[<>]/gu, '').split(' ')[0]!);
    }
  });

  it('a footnote of several words stays on the line of its label, and a second entry follows a first', () => {
    const state = stateOf(
      p('a', note('a'.repeat(24)), note('b'.repeat(24))),
      notes(entry('a'.repeat(24), 'one', br(), 'two'), entry('b'.repeat(24), 'x y z')),
    );
    const body = bodyOf(state);
    const aware = withFootnotes.parse(body, {});
    const refs = aware
      .flatMap((token) => token.children ?? [])
      .filter((child) => child.type === 'footnote_ref');
    expect(refs).toHaveLength(2);
    expect(aware.filter((token) => token.type === 'footnote_open')).toHaveLength(2);
    expect(body).toContain('[^2]: x y z');
  });

  it('a vertical bar in the address of a link in a cell does not end the cell', () => {
    const body = bodyOf(
      stateOf(
        table(
          '',
          row(headerCell({}, p('h1')), headerCell({}, p('h2'))),
          row(cell({}, p(tx('x', { link: { href: 'https://e.x/a|b' } }))), cell({}, p('y'))),
        ),
      ),
    );
    expect(body).toContain('(https://e.x/a%7Cb)');
    const tokens = parser.parse(body, {});
    expect(tokens.filter((token) => token.type === 'td_open')).toHaveLength(2);
    const link = tokens.flatMap((token) => token.children ?? []).find((child) => child.type === 'link_open');
    expect(link?.attrGet('href')).toBe('https://e.x/a%7Cb');
    // Outside a table the bar is part of the address as it was.
    expect(bodyOf(stateOf(p(tx('x', { link: { href: 'https://e.x/a|b' } }))))).toContain('(https://e.x/a|b)');
  });

  it('a line break in a cell is `<br>` alone, in the alt text and caption of an image as in a paragraph', () => {
    const body = bodyOf(
      stateOf(
        table(
          '',
          row(headerCell({}, p('h'))),
          row(cell({}, image({ id: null, alt: 'one\ntwo', caption: 'three\nfour' }))),
          row(cell({}, p('five', br(), 'six'))),
        ),
      ),
    );
    expect(body).toContain('| one<br>two<br>three<br>four |');
    expect(body).toContain('| five<br>six |');
    expect(body).not.toContain('\\<br>');
    expect(body).not.toMatch(/\\\n/u);
    expect(parser.parse(body, {}).filter((token) => token.type === 'td_open')).toHaveLength(2);
  });
});

void Y;
