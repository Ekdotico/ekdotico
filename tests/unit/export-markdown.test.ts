// What the Markdown file carries and how (FR-EX-36, its table row by row; FR-EX-02; NFR-SE-08; docs/plan/slice-21.md,
// section 6). Documents are made by hand in Yjs, so that each test says exactly what a stored state holds.
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  MARKDOWN_MOST_BYTES,
  MarkdownTooLarge,
  renderMarkdown,
  yamlString,
} from '../../src/lib/export/markdown.ts';
import { readDocument } from '../../src/lib/export/read.ts';
import {
  DOCUMENT_ID,
  NOW,
  bodyOf,
  br,
  bullets,
  cell,
  el,
  entry,
  fileOf,
  headerCell,
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

const IMAGE_A = `c${'a'.repeat(24)}`;
const IMAGE_B = `c${'b'.repeat(24)}`;
const NOTE_A = 'a'.repeat(24);
const NOTE_B = 'b'.repeat(24);
const NOTE_C = 'c'.repeat(24);

describe('the front matter and the note (FR-EX-36, FR-EX-02)', () => {
  it('begins the file with the title, the day of the export, the identifier and `draft: true`, and then the note', () => {
    const file = fileOf(stateOf(p('Words.')), { title: 'My thesis' });
    expect(file).toBe(
      [
        '---',
        'title: "My thesis"',
        'date: 2026-10-26',
        `id: ${DOCUMENT_ID}`,
        'draft: true',
        '---',
        '',
        '> Draft export — not a provenance-sealed document.',
        '',
        'Words.',
        '',
      ].join('\n'),
    );
  });

  it('is the front matter and the note alone for a document that holds nothing, or was never stored', () => {
    for (const state of [null, stateOf(), stateOf(p())]) {
      const file = fileOf(state);
      expect(file.endsWith('> Draft export — not a provenance-sealed document.\n'), String(state)).toBe(true);
    }
  });

  it('holds no name of a person, and no address, in the front matter', () => {
    const parsed = load(fileOf(stateOf(p('x'))).split('---')[1]!) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(['title', 'date', 'id', 'draft']);
    expect(parsed.draft).toBe(true);
    expect(parsed.id).toBe(DOCUMENT_ID);
    // The day, in UTC: a date at 23:59 in UTC-5 is the same day as the instant.
    expect(parsed.date instanceof Date ? parsed.date.toISOString().slice(0, 10) : parsed.date).toBe(
      '2026-10-26',
    );
    const late = fileOf(stateOf(), { now: new Date(Date.UTC(2026, 11, 31, 23, 59, 59)) });
    expect(late).toContain('date: 2026-12-31\n');
  });

  // NFR-SE-08: "a title written into the front matter of a Markdown export, which is quoted so that no character of it
  // is read as YAML".
  it('quotes the title so that whatever it holds is read as the title and nothing else', () => {
    const titles = [
      'Plain',
      'a "quoted" word',
      'back\\slash and \\" together',
      'colon: and # hash',
      '---',
      '...',
      '- item',
      '[flow]',
      '{map: 1}',
      '!tag &anchor *alias',
      'true',
      'null',
      '123',
      '2026-10-26',
      '> folded',
      '| literal',
      "it's",
      '" injected: true\ndraft: false',
      'line one\nline two',
      'tab\there',
      'cr\rlf\n',
      'nul-free controls \u0001\u0007\u001f\u007f',
      'next line \u0085 and \u2028 and \u2029',
      'bom \ufeff inside',
      'noncharacters \ufffe\uffff',
      'Εκδοτικό 論文 بحث 📚 é',
      'a'.repeat(200),
      '',
      ' ',
      '  leading and trailing  ',
    ];
    for (const title of titles) {
      const file = fileOf(stateOf(p('x')), { title });
      const front = file.slice(4, file.indexOf('\n---\n', 4));
      const parsed = load(front) as Record<string, unknown>;
      expect(parsed.title, JSON.stringify(title)).toBe(title);
      expect(Object.keys(parsed), JSON.stringify(title)).toEqual(['title', 'date', 'id', 'draft']);
      expect(parsed.draft, JSON.stringify(title)).toBe(true);
      // The title is one line of the file.
      expect(front.split('\n'), JSON.stringify(title)).toHaveLength(4);
    }
  });

  it('writes a character it does not escape as it is, an emoji outside the Basic Multilingual Plane among them', () => {
    expect(yamlString('Εκδοτικό 論文 بحث 📚 é')).toBe('"Εκδοτικό 論文 بحث 📚 é"');
    expect(yamlString('a\u0000b')).toBe('"a\\u0000b"');
    expect(yamlString('a"b\\c')).toBe('"a\\"b\\\\c"');
  });
});

describe('blocks (the table of FR-EX-36, row by row)', () => {
  it('writes a heading of level 1 to 3 with that many #, a paragraph as a paragraph, and nothing for an empty one', () => {
    expect(
      md(heading(1, 'One'), heading(2, 'Two'), heading(3, 'Three'), p('Text.'), p(), heading(2, '')),
    ).toBe('# One\n\n## Two\n\n### Three\n\nText.\n');
  });

  it('holds a heading to the editor`s levels', () => {
    for (const level of [0, 4, 9, 1.5, '2', null, undefined, {}]) {
      expect(md(heading(level, 'x')), String(level)).toBe('# x\n');
    }
  });

  it('writes a line break as a backslash at the end of the line', () => {
    expect(md(p('one', br(), 'two'))).toBe('one\\\ntwo\n');
  });

  it('writes bullet and ordered lists with the nesting kept by indentation', () => {
    expect(
      md(
        bullets(
          item(p('one'), bullets(item(p('nested a')), item(p('nested b'), ordered(1, item(p('deep')))))),
          item(p('two')),
        ),
        ordered(3, item(p('c')), item(p('d'))),
      ),
    ).toBe(
      ['- one', '  - nested a', '  - nested b', '    1. deep', '- two', '', '3. c', '4. d', ''].join('\n'),
    );
  });

  it('indents under the width of an ordered list`s marker, which grows at ten', () => {
    const body = md(ordered(9, item(p('nine'), p('more')), item(p('ten'), p('more'))));
    expect(body).toBe(['9. nine', '', '   more', '10. ten', '', '    more', ''].join('\n'));
  });

  it('keeps two lists of one kind that follow each other two lists, by the marker', () => {
    // The third list follows the second, which already has the other marker: it takes the other of its own.
    expect(md(bullets(item(p('a'))), bullets(item(p('b'))), bullets(item(p('c'))))).toBe(
      '- a\n\n* b\n\n* c\n',
    );
    expect(md(ordered(1, item(p('a'))), ordered(1, item(p('b'))))).toBe('1. a\n\n1) b\n');
  });

  it('puts the blocks of an item one under another, a nested list directly under its words', () => {
    expect(
      md(
        bullets(
          item(
            p('words'),
            el('codeBlock', { language: 'plaintext' }, tx('code')),
            p('after'),
            bullets(item(p('n'))),
          ),
        ),
      ),
    ).toBe(['- words', '', '  ```', '  code', '  ```', '', '  after', '  - n', ''].join('\n'));
  });

  it('writes a blockquote with `>` on every line, nested ones too', () => {
    expect(md(el('blockquote', {}, p('a'), p('b'), el('blockquote', {}, p('inner'))))).toBe(
      ['> a', '>', '> b', '>', '> > inner', ''].join('\n'),
    );
  });

  it('writes a callout as a blockquote whose first line is the variant in bold', () => {
    expect(md(el('callout', { type: 'note' }, p('N')))).toBe('> **Note**\n>\n> N\n');
    expect(md(el('callout', { type: 'warning' }, p('W1'), p('W2')))).toBe(
      '> **Warning**\n>\n> W1\n>\n> W2\n',
    );
    expect(md(el('callout', { type: 'tip' }, p('T')))).toBe('> **Tip**\n>\n> T\n');
    for (const type of ['danger', '', 5, null, undefined, {}]) {
      expect(md(el('callout', { type }, p('x'))), String(type)).toBe('> **Note**\n>\n> x\n');
    }
  });

  it('writes a code block as a fence, with the language where one is set and it is one the editor has', () => {
    expect(md(el('codeBlock', { language: 'typescript' }, tx('const a = 1;\n\nconst b = 2;')))).toBe(
      '```typescript\nconst a = 1;\n\nconst b = 2;\n```\n',
    );
    for (const language of [
      'plaintext',
      'nonsense',
      '',
      null,
      undefined,
      5,
      'x"><script>',
      'js\nfoo',
      'C++',
    ]) {
      expect(md(el('codeBlock', { language }, tx('x'))), String(language)).toBe('```\nx\n```\n');
    }
    expect(md(el('codeBlock', { language: 'cpp' }))).toBe('```cpp\n```\n');
  });

  it('fences code with more backticks than it holds, so that nothing in it ends the block', () => {
    expect(md(el('codeBlock', {}, tx('a ``` b')))).toBe('````\na ``` b\n````\n');
    expect(md(el('codeBlock', {}, tx('`````x\n```')))).toBe('``````\n`````x\n```\n``````\n');
    // Inside a list the fence and the code are indented together.
    expect(md(bullets(item(p('a'), el('codeBlock', {}, tx('```\nx')))))).toBe(
      ['- a', '', '  ````', '  ```', '  x', '  ````', ''].join('\n'),
    );
  });

  it('writes a horizontal rule as three hyphens, and nothing for a page break or a table of contents', () => {
    expect(md(p('a'), el('horizontalRule'), p('b'))).toBe('a\n\n---\n\nb\n');
    expect(md(p('a'), el('pageBreak'), el('tableOfContents', { depth: 2 }), p('b'))).toBe('a\n\nb\n');
  });

  it('leaves out what the schema does not have, and text among the blocks', () => {
    expect(
      md(p('a'), el('script', {}, tx('alert(1)')), tx('stray text'), el('listItem', {}, p('loose')), p('b')),
    ).toBe('a\n\nb\n');
  });
});

describe('marks', () => {
  const t = tx;
  it('writes bold, italic, strikethrough, inline code and a hyperlink in Markdown', () => {
    expect(
      md(
        p(
          t('b', { bold: {} }),
          ' ',
          t('i', { italic: {} }),
          ' ',
          t('s', { strike: {} }),
          ' ',
          t('c', { code: {} }),
          ' ',
          t('l', { link: { href: 'https://example.test/a' } }),
        ),
      ),
    ).toBe('**b** *i* ~~s~~ `c` [l](https://example.test/a)\n');
  });

  it('writes underline, superscript, subscript and highlight as the elements u, sup, sub and mark', () => {
    expect(
      md(
        p(
          t('u', { underline: {} }),
          ' ',
          t('p', { superscript: {} }),
          ' ',
          t('b', { subscript: {} }),
          ' ',
          t('h', { highlight: {} }),
        ),
      ),
    ).toBe('<u>u</u> <sup>p</sup> <sub>b</sub> <mark>h</mark>\n');
  });

  it('puts the text inside an element escaped, so that it can neither close it nor open another', () => {
    expect(md(p(t('</u><script>x</script>', { underline: {} })))).toBe(
      '<u>\\</u>\\<script>x\\</script></u>\n',
    );
  });

  it('shares a mark between neighbours, and nests them so that what ends first is closed first', () => {
    expect(md(p(t('a', { bold: {} }), t('b', { bold: {} })))).toBe('**ab**\n');
    expect(md(p(t('it', { italic: {} }), t('al ', { italic: {}, bold: {} }), 'x'))).toBe('*it**al*** x\n');
    // The mark that goes on longer is the outer: italic ends with the first run, bold with the second.
    expect(md(p(t('x', { bold: {}, italic: {} }), t('y', { bold: {} })))).toBe('***x*y**\n');
  });

  it('puts the white space at the edge of a marked run outside the delimiters', () => {
    expect(md(p('a', t(' b ', { bold: {} }), 'c'))).toBe('a **b** c\n');
    expect(md(p(t('b ', { bold: {} })))).toBe('**b**\n');
    // A run of white space alone carries no mark of its own.
    expect(md(p(t('a', { bold: {} }), t(' ', { bold: {} }), t('b', { bold: {} })))).toBe('**a b**\n');
    // And one between two words that go on in the same mark is inside the one mark, which is the same on the page.
    expect(md(p(t('a', { bold: {} }), ' ', t('b', { bold: {} })))).toBe('**a b**\n');
    expect(md(p(t('a', { bold: {} }), ' ', t('b', { italic: {} })))).toBe('**a** *b*\n');
  });

  it('writes code with a delimiter longer than any run of backticks in it, and pads where it must', () => {
    expect(md(p(t('a`b', { code: {} })))).toBe('``a`b``\n');
    expect(md(p(t('`edge`', { code: {} })))).toBe('`` `edge` ``\n');
    expect(md(p(t(' sp ', { code: {} })))).toBe('`  sp  `\n');
    expect(md(p(t('   ', { code: {} })))).toBe('`   `\n');
    // Code is raw: Markdown in it is not escaped.
    expect(md(p(t('*not* <b> [x](y) \\', { code: {} })))).toBe('`*not* <b> [x](y) \\`\n');
  });

  it('writes a link whose address is the editor`s rule, and the text of one whose address is not', () => {
    expect(md(p(t('ok', { link: { href: 'mailto:a@b.test' } })))).toBe('[ok](mailto:a@b.test)\n');
    for (const href of [
      'javascript:alert(1)',
      'data:text/html;base64,AAAA',
      '//x.test',
      '/relative',
      '',
      null,
      5,
      undefined,
    ]) {
      expect(md(p(t('no', { link: { href } }))), String(href)).toBe('no\n');
    }
    expect(md(p(t('no', { link: 'https://x.test' })))).toBe('no\n');
    expect(md(p(t('a(b)c', { link: { href: 'https://x.test/a_(b)' } })))).toBe(
      '[a(b)c](https://x.test/a_%28b%29)\n',
    );
  });

  it('reads a mark by the name the binding gives one that can overlap itself, and ignores a name it does not know', () => {
    expect(md(p(t('x', { 'bold--Ab12Cd34': {}, 'weird--Ab12Cd34': {}, wat: {}, __proto__x: {} })))).toBe(
      '**x**\n',
    );
  });
});

describe('tables', () => {
  const headerRow = (...texts: string[]) => row(...texts.map((text) => headerCell({}, p(text))));
  const bodyRow = (...texts: string[]) => row(...texts.map((text) => cell({}, p(text))));

  it('writes a pipe table, the header row first, and the caption as a paragraph below', () => {
    expect(md(table('Table 1', headerRow('A', 'B'), bodyRow('1', '2'), bodyRow('3', '4')))).toBe(
      ['| A | B |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', '', 'Table 1', ''].join('\n'),
    );
  });

  it('writes a table without a header row with an empty header row (the owner`s answer to Q15)', () => {
    expect(md(table('', bodyRow('1', '2'), bodyRow('3', '4')))).toBe(
      ['| | |', '| --- | --- |', '| 1 | 2 |', '| 3 | 4 |', ''].join('\n'),
    );
  });

  it('takes a first row of header cells for the header and no other row', () => {
    expect(md(table('', headerRow('A', 'B'), headerRow('C', 'D')))).toBe(
      ['| A | B |', '| --- | --- |', '| C | D |', ''].join('\n'),
    );
    expect(md(table('', row(headerCell({}, p('A')), cell({}, p('B'))), bodyRow('C', 'D')))).toBe(
      ['| | |', '| --- | --- |', '| A | B |', '| C | D |', ''].join('\n'),
    );
  });

  it('writes a merged cell in the first of its squares and leaves the others empty', () => {
    expect(
      md(
        table(
          '',
          row(headerCell({ colspan: 2 }, p('wide')), headerCell({}, p('C'))),
          row(cell({ rowspan: 2 }, p('tall')), cell({}, p('b')), cell({}, p('c'))),
          row(cell({}, p('d')), cell({}, p('e'))),
        ),
      ),
    ).toBe(['| wide | | C |', '| --- | --- | --- |', '| tall | b | c |', '| | d | e |', ''].join('\n'));
  });

  it('holds the spans to what the editor holds them to', () => {
    // A cell that reaches below the last row spans one row; a span of 0, 101 or a string is 1.
    for (const bad of [0, 101, '2', 1.5, null, -1, {}]) {
      expect(
        md(table('', bodyRow('x'), row(cell({ colspan: bad, rowspan: bad }, p('y'))))),
        String(bad),
      ).toBe(['| |', '| --- |', '| x |', '| y |', ''].join('\n'));
    }
    expect(md(table('', row(cell({ rowspan: 3 }, p('a'))), bodyRow('b')))).toBe(
      ['| |', '| --- |', '| a |', '| b |', ''].join('\n'),
    );
  });

  it('escapes a vertical bar in a cell, in code too', () => {
    expect(md(table('', bodyRow('a|b'), row(cell({}, p(tx('c|d', { code: {} }))))))).toBe(
      ['| |', '| --- |', '| a\\|b |', '| `c\\|d` |', ''].join('\n'),
    );
  });

  it('writes the blocks of a cell as lines joined by `<br>`, since a cell is one line (register row S21-3)', () => {
    const body = md(
      table(
        '',
        row(
          cell(
            {},
            p('first', br(), 'second'),
            p('third'),
            bullets(item(p('item a')), item(p('item b'))),
            el('codeBlock', {}, tx('x = 1\ny = 2')),
            el('blockquote', {}, p('quoted')),
            el('horizontalRule'),
            heading(2, 'head'),
          ),
        ),
      ),
    );
    expect(body).toBe(
      [
        '| |',
        '| --- |',
        '| first<br>second<br>third<br>item a<br>item b<br>`x = 1`<br>`y = 2`<br>quoted<br>head |',
        '',
      ].join('\n'),
    );
  });

  it('writes a table in a cell as its cells, row by row, and the image in a cell as an image', () => {
    const inner = table('inner caption', row(cell({}, p('i1')), cell({}, p('i2'))), row(cell({}, p('i3'))));
    const state = stateOf(
      table('', row(cell({}, p('outer'), inner, image({ id: IMAGE_A, alt: 'alt', caption: 'cap' })))),
    );
    expect(bodyOf(state, { available: [IMAGE_A] })).toBe(
      [
        '| |',
        '| --- |',
        '| outer<br>i1<br>i2<br>i3<br>inner caption<br>![alt](images/001.png)<br>cap |',
        '',
      ].join('\n'),
    );
  });

  it('writes a table with no cell as its caption, and a caption of no words as nothing', () => {
    expect(md(table('only a caption', row()))).toBe('only a caption\n');
    expect(md(table('', row()))).toBe('');
  });

  it('writes a table outside its block, which the editor does not make, as a table', () => {
    expect(md(el('table', {}, bodyRow('1')))).toBe(['| |', '| --- |', '| 1 |', ''].join('\n'));
  });
});

describe('images', () => {
  it('writes the alt text as the text of the image and the path in the archive as its target, the caption below', () => {
    expect(md(image({ id: IMAGE_A, alt: 'A cat', caption: 'Figure 1' }))).toBe(
      '![A cat](images/001.png)\n\nFigure 1\n',
    );
    expect(md(image({ id: IMAGE_A, alt: '', caption: '' }))).toBe('![](images/001.png)\n');
  });

  it('names the files by the order of the images in the document, one file for an image used twice', () => {
    const state = stateOf(
      image({ id: IMAGE_B, alt: 'b' }),
      image({ id: IMAGE_A, alt: 'a' }),
      image({ id: IMAGE_B, alt: 'b again' }),
    );
    expect(bodyOf(state)).toBe(
      '![b](images/001.png)\n\n![a](images/002.png)\n\n![b again](images/001.png)\n',
    );
  });

  it('writes the width of nothing (the owner`s answer to Q15)', () => {
    expect(md(image({ id: IMAGE_A, alt: 'a', width: 40 }))).toBe('![a](images/001.png)\n');
  });

  it('escapes the alt text and the caption as text', () => {
    expect(md(image({ id: IMAGE_A, alt: '[x](javascript:alert(1)) <b>', caption: '# not a heading' }))).toBe(
      '![\\[x\\](javascript:alert(1)) \\<b>](images/001.png)\n\n\\# not a heading\n',
    );
  });

  it('writes the words of an image that is not available, and no link (register row S21-1)', () => {
    const none = { available: [] as string[] };
    const unavailable = (attributes: Record<string, unknown>) => bodyOf(stateOf(image(attributes)), none);
    expect(unavailable({ id: IMAGE_A, alt: 'A cat', caption: 'Figure 1' })).toBe('A cat\n\nFigure 1\n');
    expect(unavailable({ id: IMAGE_A, alt: 'A cat' })).toBe('A cat\n');
    expect(unavailable({ id: IMAGE_A, caption: 'Only a caption' })).toBe('Only a caption\n');
    expect(unavailable({ id: IMAGE_A })).toBe('');
    // No identifier, or one that is not the form the database issues: nothing is looked up and nothing is linked.
    for (const id of [
      null,
      undefined,
      '',
      '../../etc/passwd',
      'https://x.test/a.png',
      'data:image/png;base64,AAAA',
      5,
      `${IMAGE_A}x`,
      IMAGE_A.toUpperCase(),
    ]) {
      expect(bodyOf(stateOf(image({ id, alt: 'words' })), { available: [IMAGE_A] }), String(id)).toBe(
        'words\n',
      );
    }
  });

  it('never writes an address of its own: the target is the relative path it is given', () => {
    expect(
      md(image({ id: IMAGE_A, alt: 'a', src: 'https://evil.test/x.png', href: 'javascript:1', url: 'x' })),
    ).toBe('![a](images/001.png)\n');
  });
});

describe('footnotes (the rules of slice 20)', () => {
  it('writes [^n] in the text and the entry at the end, numbered in the order of the markers', () => {
    expect(
      md(
        p('First', note(NOTE_B), ' and second', note(NOTE_A), '.'),
        notes(entry(NOTE_A, 'Note A'), entry(NOTE_B, 'Note B')),
      ),
    ).toBe(['First[^1] and second[^2].', '', '[^1]: Note B', '[^2]: Note A', ''].join('\n'));
  });

  it('numbers them across headings, lists, quotes, callouts and cells in the order of the document', () => {
    expect(
      md(
        heading(1, 'Head'),
        bullets(item(p('x', note(NOTE_C)))),
        el('blockquote', {}, p('q', note(NOTE_B))),
        table('', row(cell({}, p('c', note(NOTE_A))))),
        notes(entry(NOTE_A, 'a'), entry(NOTE_B, 'b'), entry(NOTE_C, 'c')),
      ),
    ).toBe(
      [
        '# Head',
        '',
        '- x[^1]',
        '',
        '> q[^2]',
        '',
        '| |',
        '| --- |',
        '| c[^3] |',
        '',
        '[^1]: c',
        '[^2]: b',
        '[^3]: a',
        '',
      ].join('\n'),
    );
  });

  it('counts a second marker with an identifier already seen with the first, and writes one entry', () => {
    expect(
      md(
        p('a', note(NOTE_A), ' b', note(NOTE_B), ' c', note(NOTE_A)),
        notes(entry(NOTE_A, 'A'), entry(NOTE_B, 'B')),
      ),
    ).toBe(['a[^1] b[^2] c[^1]', '', '[^1]: A', '[^2]: B', ''].join('\n'));
  });

  it('finds an entry by its identifier in any list, the first of an identifier in the document winning', () => {
    expect(
      md(
        p('a', note(NOTE_A), note(NOTE_B)),
        notes(entry(NOTE_B, 'B first')),
        p('a block after the first list'),
        notes(entry(NOTE_A, 'A'), entry(NOTE_B, 'B second'), entry(NOTE_A, 'A again')),
      ),
    ).toBe(['a[^1][^2]', '', 'a block after the first list', '', '[^1]: A', '[^2]: B first', ''].join('\n'));
  });

  it('writes an entry that has no marker nowhere, and a marker that has no entry with no words', () => {
    expect(md(p('a', note(NOTE_A)), notes(entry(NOTE_B, 'orphan')))).toBe(
      ['a[^1]', '', '[^1]:', ''].join('\n'),
    );
    expect(md(p('a', note(NOTE_A)))).toBe(['a[^1]', '', '[^1]:', ''].join('\n'));
  });

  it('writes no marker that holds no valid identifier, and does not number it', () => {
    for (const id of [null, undefined, '', 'short', 'A'.repeat(24), '../'.repeat(8), 12, `${NOTE_A}0`]) {
      expect(md(p('a', note(id), 'b', note(NOTE_A)), notes(entry(NOTE_A, 'A'))), String(id)).toBe(
        ['ab[^1]', '', '[^1]: A', ''].join('\n'),
      );
    }
  });

  it('puts a line break of an entry on a line of its own, indented under the entry', () => {
    expect(md(p('a', note(NOTE_A)), notes(entry(NOTE_A, 'one', br(), '# two', br(), 'three')))).toBe(
      ['a[^1]', '', '[^1]: one\\', '    \\# two\\', '    three', ''].join('\n'),
    );
  });

  it('gives an entry the marks of its words, and none of a marker in it', () => {
    expect(
      md(
        p('a', note(NOTE_A)),
        notes(entry(NOTE_A, tx('bold', { bold: {} }), ' and ', note(NOTE_B), tx(' <b>', { italic: {} }))),
      ),
    ).toBe(['a[^1]', '', '[^1]: **bold** and  *\\<b>*', ''].join('\n'));
  });

  it('ignores a list of entries that is not at the root, and a marker in one', () => {
    expect(md(p('a', note(NOTE_A)), el('blockquote', {}, notes(entry(NOTE_A, 'nested list')), p('q')))).toBe(
      ['a[^1]', '', '> q', '', '[^1]:', ''].join('\n'),
    );
  });
});

describe('the size of the file', () => {
  it('fails, before a byte is sent, where the Markdown passes the bound (register row S21-8)', () => {
    const big = 'é'.repeat(Math.ceil(MARKDOWN_MOST_BYTES / 2) + 10);
    const state = stateOf(p(big));
    expect(() =>
      renderMarkdown({
        title: 't',
        id: DOCUMENT_ID,
        now: NOW,
        document: readDocument(state),
        images: new Map(),
      }),
    ).toThrow(MarkdownTooLarge);
    expect(() => fileOf(stateOf(p('é'.repeat(1000))))).not.toThrow();
  });
});
