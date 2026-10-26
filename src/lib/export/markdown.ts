// A document written as Markdown (FR-EX-36, FR-EX-02; docs/plan/slice-21.md, section 6, which has the table of
// what each block becomes). CommonMark with the GitHub extensions a table and a strikethrough need, and the
// footnotes of GitHub and Pandoc.
//
// THE TEXT OF THE DOCUMENT IS TEXT. A character the user typed that Markdown would read as syntax is written after
// a backslash (or as a character reference where a backslash does not reach), so that it reads as it was written
// and so that no raw HTML, no link and no image the user did not make can come out of it (NFR-SE-06, NFR-SE-08).
// The only HTML in a file is the five elements of FR-EX-36 (`u`, `sup`, `sub`, `mark` around escaped text, and `br`
// in a table cell, which a cell has no other way to break a line with), and the only address is a link's, held to
// the editor's rule (src/lib/editor/link.ts) when it was read (./read.ts). No character is removed (NFR-I18-03).
import { MAX_ELEMENT_DEPTH } from '../collab/state.ts';
import type { Block, Cell, Inline, Mark, ReadDocument, Row } from './read.ts';

/**
 * The most a file may be, in bytes. The Docs bound the images of an archive and not the text beside them (register
 * row S21-8), and a document of 5 MB can write a larger file (indentation, escapes, the cells of a table). Past it
 * the export fails before it sends a byte.
 */
export const MARKDOWN_MOST_BYTES = 32 * 1024 * 1024;

/** The note below the front matter: the sentence FR-EX-02 gives the other formats, verbatim. */
export const DRAFT_NOTE = 'Draft export — not a provenance-sealed document.';

export class MarkdownTooLarge extends Error {
  override name = 'MarkdownTooLarge';
  constructor() {
    super('the Markdown is larger than an export may be');
  }
}

export interface MarkdownInput {
  title: string;
  /** The document's identifier. */
  id: string;
  /** The moment of the export; the front matter has its day, in UTC. */
  now: Date;
  document: ReadDocument;
  /** The relative path of each image of the archive, by the identifier a block holds; a block whose image is not here is written as words. */
  images: ReadonlyMap<string, string>;
}

// ── Front matter ────────────────────────────────────────────────────────────

/**
 * The title as a YAML double-quoted string (NFR-SE-08), so that no character of it is read as YAML: `\` and `"`
 * are escaped, and so is every character the YAML specification does not allow to stand as it is (the controls, the
 * line breaks of YAML 1.1, the byte order mark, the non-characters). Every other code point, an emoji outside the
 * Basic Multilingual Plane among them, is written as it is (NFR-I18-03).
 */
export function yamlString(text: string): string {
  const escaped = text
    .toWellFormed()
    .replace(
      /["\\]|[^\x20-\x7e\xa0-\u2027\u202a-\ud7ff\ue000-\ufefe\uff00-\ufffd\u{10000}-\u{10ffff}]/gu,
      (each) =>
        each === '"' || each === '\\'
          ? `\\${each}`
          : `\\u${each.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
  return `"${escaped}"`;
}

// ── Text ────────────────────────────────────────────────────────────────────

// What is escaped wherever it stands: emphasis, code, links, footnotes, tables, strikethrough, and the dollar of
// mathematics; and `<`, which is where raw HTML, an autolink and a comment begin.
const ALWAYS = /[\\`*_[\]<|~$]/gu;
// A character reference that the user typed as text: `&amp;` must read as `&amp;`.
const REFERENCE = /&(?=#?[A-Za-z0-9]+;)/gu;
const escapeText = (text: string) => text.replace(ALWAYS, '\\$&').replace(REFERENCE, '\\&');

/**
 * What stands at the start of a line and would begin a block: a heading, a quotation, a list, the line under a
 * heading, an indented code block. The text is the start of the line, as it was typed.
 */
function atLineStart(text: string): string {
  // A tab or a space first: written as a character reference, which is not indentation, so that four of them are
  // not a code block. The line then begins with `&` and nothing after it is at the start of a line.
  if (text.startsWith(' ')) return `&#32;${text.slice(1)}`;
  if (text.startsWith('\t')) return `&#9;${text.slice(1)}`;
  // A number and the full stop or bracket after it make a list; digits alone may be followed by one in the next run.
  const digits = /^([0-9]{1,9})([.)]|$)/u.exec(text);
  if (digits) {
    return digits[2] === ''
      ? `&#${text.charCodeAt(0)};${text.slice(1)}`
      : `${digits[1]}\\${digits[2]}${text.slice(digits[0].length)}`;
  }
  return text.replace(/^[#>+\-=]/u, '\\$&');
}

/** A backtick span for the code, with a delimiter longer than any run of backticks in it. */
function codeSpan(code: string): string {
  const longest = Math.max(0, ...(code.match(/`+/gu) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  // A space is taken off each side of a span that has one on both; a span that begins or ends with a backtick
  // would run into its delimiter. Either way one space is put on each side to be taken off.
  const pad = /^[ `]|[ `]$/u.test(code) && !/^ +$/u.test(code) ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** An address as a link destination: nothing in it can end the link. It holds no space, control character or backslash (linkAddress). */
function destination(href: string): string {
  return href
    .replace(/[()<>"]/gu, (each) => `%${each.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(REFERENCE, '\\&');
}

/**
 * Nothing but what Markdown calls white space: a space, a tab, a line end. A no-break space is a character of the text
 * and is kept, which `trim` of the language would not (NFR-I18-03).
 */
const blank = (text: string) => /^[ \t\r\n]*$/u.test(text);
const stripped = (text: string) => text.replace(/^[ \t]+|[ \t]+$/gu, '');
const keyOf = (mark: Mark) => (mark.name === 'link' ? `link:${mark.href}` : mark.name);
/** A run of white space alone that no code span holds. */
const isSpace = (run: Inline) =>
  run.kind === 'text' && blank(run.text) && !run.marks.some((mark) => mark.name === 'code');
const sameMark = (a: Mark, b: Mark) =>
  a.name === b.name && (a.name !== 'link' || (b.name === 'link' && a.href === b.href));
const sameMarks = (a: readonly Mark[], b: readonly Mark[]) =>
  a.length === b.length && a.every((mark, at) => sameMark(mark, b[at]!));

const OPEN: Record<Exclude<Mark['name'], 'link' | 'code'>, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strike: ['~~', '~~'],
  underline: ['<u>', '</u>'],
  superscript: ['<sup>', '</sup>'],
  subscript: ['<sub>', '</sub>'],
  highlight: ['<mark>', '</mark>'],
};

function delimiters(mark: Mark): [string, string] {
  if (mark.name === 'link') return ['[', `](${destination(mark.href)})`];
  if (mark.name === 'code') return ['', ''];
  return OPEN[mark.name];
}

/** How the inline content of one block is written; a table cell and a heading each hold one line. */
interface Place {
  /** A cell of a table: a line break is `<br>` and a vertical bar is escaped in code too. */
  cell?: boolean;
  /** A heading: one line, and a `#` is escaped wherever it stands. */
  heading?: boolean;
}

/** The numbers footnotes take, in the order the markers are met, and what an image is written as. */
interface Context {
  notes: Map<string, number>;
  images: ReadonlyMap<string, string>;
}

const BREAK_PATTERN = /\r\n|[\n\r]/u;

/**
 * Inline content as Markdown, possibly over several lines (a line break is a backslash at the end of a line).
 * Adjacent runs that hold the same marks are one run; marks are nested in a fixed order and shared between
 * neighbours (one `**` over two runs that are both bold); and the white space at the edge of a run is put outside
 * the delimiters, since `** a **` is not bold.
 */
export function inlineMarkdown(content: readonly Inline[], context: Context, place: Place = {}): string {
  // A line end in text is a line break, as it would be to a reader of the editor's text; one in code is a space.
  const expanded = content.flatMap((each): Inline[] => {
    // A marker with no valid identifier is nothing.
    if (each.kind === 'note' && each.id === null) return [];
    if (
      each.kind !== 'text' ||
      each.marks.some((mark) => mark.name === 'code') ||
      !BREAK_PATTERN.test(each.text)
    ) {
      return [each];
    }
    return each.text
      .split(BREAK_PATTERN)
      .flatMap((part, at): Inline[] => [
        ...(at > 0 ? [{ kind: 'break' } as const] : []),
        ...(part === '' ? [] : [{ ...each, text: part }]),
      ]);
  });
  // Neighbours that hold the same marks are one run.
  const runs: Inline[] = [];
  for (const each of expanded) {
    const last = runs.at(-1);
    if (each.kind === 'text' && last?.kind === 'text' && sameMarks(last.marks, each.marks)) {
      runs[runs.length - 1] = { ...last, text: last.text + each.text };
    } else runs.push(each);
  }
  // A line break that begins or ends a block breaks nothing, and the backslash of one would be read as a character;
  // nor does white space that follows the last. (`isSpace` is declared below, with the other helpers of the file.)
  while (runs.length > 0 && (runs.at(-1)!.kind === 'break' || isSpace(runs.at(-1)!))) runs.pop();
  // (Blank lines at the start of a block are the same: white space and then a break, as often as there are.)
  for (
    let first = runs.findIndex((run) => run.kind !== 'text' || !isSpace(run));
    runs[first]?.kind === 'break';
  ) {
    runs.splice(0, first + 1);
    first = runs.findIndex((run) => run.kind !== 'text' || !isSpace(run));
  }

  let out = '';
  // Where a line begins a block: not in a heading or a cell, which stand after their own syntax.
  const oneLine = place.heading === true || place.cell === true;
  let lineStart = !oneLine;
  const open: Mark[] = [];

  const emit = (text: string) => {
    if (text === '') return;
    out += text;
    lineStart = false;
  };
  const lineBreak = () => {
    out += place.heading ? ' ' : place.cell ? '<br>' : '\\\n';
    lineStart = !oneLine;
  };
  // Closed before any trailing white space: `**a **` is not bold.
  const close = (count: number) => {
    if (count <= 0) return;
    const closing = open.splice(open.length - count, count).reverse();
    const tail = /[ \t]*$/u.exec(out)![0];
    out = out.slice(0, out.length - tail.length) + closing.map((mark) => delimiters(mark)[1]).join('') + tail;
  };
  const writeText = (text: string) => {
    text.split(BREAK_PATTERN).forEach((part, at) => {
      if (at > 0) lineBreak();
      if (part === '') return;
      let escaped = escapeText(part);
      if (place.heading) escaped = escaped.replace(/#/gu, '\\#');
      emit(lineStart ? atLineStart(escaped) : escaped);
    });
  };

  // How many runs from each one on carry each mark (white space alone is carried over): the marks that go on
  // longest are opened first, so that a mark that ends can be closed without closing those that go on.
  const spans: Map<string, number>[] = [];
  for (let at = runs.length - 1; at >= 0; at -= 1) {
    const run = runs[at]!;
    const next = spans[at + 1];
    const here = new Map<string, number>();
    if (run.kind === 'text' && isSpace(run)) next?.forEach((count, key) => here.set(key, count));
    else if (run.kind === 'text') {
      for (const mark of run.marks) here.set(keyOf(mark), 1 + (next?.get(keyOf(mark)) ?? 0));
    }
    spans[at] = here;
  }

  runs.forEach((run, at) => {
    if (run.kind === 'text') {
      const { text, marks } = run;
      const code = marks.some((mark) => mark.name === 'code');
      const outer = marks.filter((mark) => mark.name !== 'code');
      if (isSpace(run)) {
        // White space alone opens nothing and closes nothing: it stands inside the marks that are open.
        writeText(text);
        return;
      }
      // What stays open is what the run carries, up to the first open mark that it does not.
      let keep = 0;
      while (keep < open.length && outer.some((mark) => sameMark(mark, open[keep]!))) keep += 1;
      close(open.length - keep);
      const opening = outer
        .filter((mark) => !open.some((each) => sameMark(each, mark)))
        .sort((a, b) => (spans[at]!.get(keyOf(b)) ?? 0) - (spans[at]!.get(keyOf(a)) ?? 0));
      // The white space before the text stands outside the delimiters that open for it.
      const lead = code || opening.length === 0 ? '' : /^[ \t]*/u.exec(text)![0];
      if (lead) writeText(lead);
      for (const mark of opening) {
        emit(delimiters(mark)[0]);
        open.push(mark);
      }
      if (code) {
        const lines = text.split(BREAK_PATTERN);
        // A code span holds one line: a line break in it is a space.
        const span = codeSpan(lines.join(' '));
        emit(place.cell ? span.replace(/\|/gu, '\\|') : span);
      } else {
        writeText(text.slice(lead.length));
      }
    } else {
      close(open.length);
      if (run.kind === 'break') lineBreak();
      else if (run.id !== null) {
        const number = context.notes.get(run.id) ?? context.notes.size + 1;
        context.notes.set(run.id, number);
        emit(`[^${number}]`);
      }
    }
  });
  close(open.length);
  // The white space at the end of a block is nothing to Markdown, and a closed mark may have left some.
  return out.replace(/[ \t]+$/u, '');
}

// ── Blocks ──────────────────────────────────────────────────────────────────

const indented = (lines: string[], by: string) => lines.map((line) => (line === '' ? '' : by + line));
const quoted = (lines: string[]) => lines.map((line) => (line === '' ? '>' : `> ${line}`));

/** The lines of a sequence of blocks, a blank line between one and the next. */
function blocksMarkdown(blocks: readonly Block[], context: Context, depth: number): string[] {
  const out: string[] = [];
  let previous: Block | undefined;
  for (const block of blocks) {
    const lines = blockMarkdown(block, context, depth, previous);
    if (lines.length === 0) continue;
    if (out.length > 0) out.push('');
    out.push(...lines);
    previous = block;
  }
  return out;
}

function listMarkdown(
  block: Extract<Block, { kind: 'list' }>,
  context: Context,
  depth: number,
  previous: Block | undefined,
): string[] {
  // A list that follows another of its kind would be read as the same list: a different marker makes it a new one.
  const after = previous?.kind === 'list' && previous.ordered === block.ordered;
  const out: string[] = [];
  block.items.forEach((item, at) => {
    const marker = block.ordered ? `${block.start + at}${after ? ')' : '.'} ` : `${after ? '*' : '-'} `;
    const body = itemMarkdown(item, context, depth);
    const [first = '', ...rest] = body;
    out.push(`${marker}${first}`.replace(/[ \t]+$/u, ''), ...indented(rest, ' '.repeat(marker.length)));
  });
  return out;
}

/** The blocks of an item: a list inside it follows the words it belongs to with no blank line between. */
function itemMarkdown(item: readonly Block[], context: Context, depth: number): string[] {
  const out: string[] = [];
  let previous: Block | undefined;
  for (const block of item) {
    const lines = blockMarkdown(block, context, depth, previous);
    if (lines.length === 0) continue;
    const tight = previous !== undefined && block.kind === 'list' && previous.kind !== 'list';
    if (out.length > 0 && !tight) out.push('');
    out.push(...lines);
    previous = block;
  }
  return out;
}

function imageLines(block: Extract<Block, { kind: 'image' }>, context: Context): string[] {
  const alt = escapeText(block.alt.replace(/\r\n|[\n\r]/gu, ' '));
  const caption = block.caption ? paragraphLines(block.caption) : [];
  const path = block.id === null ? undefined : context.images.get(block.id);
  if (path === undefined) {
    // The image is not available (docs/plan/slice-21.md, S21-1): its words, and no link.
    return [...(alt ? paragraphLines(block.alt) : []), ...(alt && caption.length ? [''] : []), ...caption];
  }
  return [`![${alt}](${path})`, ...(caption.length ? ['', ...caption] : [])];
}

/** A paragraph of plain text: a caption, an alt text on its own. */
function paragraphLines(text: string): string[] {
  const written = inlineMarkdown([{ kind: 'text', text, marks: [] }], {
    notes: new Map(),
    images: new Map(),
  });
  return blank(written) ? [] : written.split('\n');
}

function blockMarkdown(block: Block, context: Context, depth: number, previous: Block | undefined): string[] {
  if (depth > MAX_ELEMENT_DEPTH + 1) return [];
  switch (block.kind) {
    case 'paragraph': {
      const text = inlineMarkdown(block.content, context);
      return blank(text) ? [] : text.split('\n');
    }
    case 'heading': {
      const text = inlineMarkdown(block.content, context, { heading: true });
      return blank(text) ? [] : [`${'#'.repeat(block.level)} ${stripped(text)}`];
    }
    case 'code': {
      const longest = Math.max(0, ...(block.text.match(/`+/gu) ?? []).map((run) => run.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      const code = block.text === '' ? [] : block.text.split(/\r\n|[\n\r]/u);
      return [`${fence}${block.language ?? ''}`, ...code, fence];
    }
    case 'rule':
      return ['---'];
    case 'quote':
      return quoted(blocksMarkdown(block.children, context, depth + 1));
    case 'callout': {
      const label = { note: 'Note', warning: 'Warning', tip: 'Tip' }[block.variant];
      const body = blocksMarkdown(block.children, context, depth + 1);
      return quoted([`**${label}**`, ...(body.length ? ['', ...body] : [])]);
    }
    case 'list':
      return listMarkdown(block, context, depth + 1, previous);
    case 'table':
      return tableMarkdown(block, context, depth);
    case 'image':
      return imageLines(block, context);
  }
}

// ── Tables ──────────────────────────────────────────────────────────────────

/** The lines a cell holds, in the order of the document, each block flattened to words: a cell is one line of a pipe table. */
function cellLines(blocks: readonly Block[], context: Context, depth: number): string[] {
  if (depth > MAX_ELEMENT_DEPTH + 1) return [];
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading': {
        const text = inlineMarkdown(block.content, context, { cell: true });
        if (!blank(text)) out.push(text);
        break;
      }
      case 'code':
        for (const line of block.text.split(/\r\n|[\n\r]/u))
          if (line !== '') out.push(codeSpan(line).replace(/\|/gu, '\\|'));
        break;
      case 'quote':
      case 'callout':
        out.push(...cellLines(block.children, context, depth + 1));
        break;
      case 'list':
        for (const item of block.items) out.push(...cellLines(item, context, depth + 1));
        break;
      case 'table':
        for (const row of block.rows)
          for (const cell of row) out.push(...cellLines(cell.children, context, depth + 1));
        if (block.caption) out.push(...paragraphLines(block.caption));
        break;
      case 'image':
        out.push(...imageLines(block, context).filter((line) => line !== ''));
        break;
      case 'rule':
        break;
    }
  }
  return out;
}

const cellText = (cell: Cell, context: Context, depth: number) =>
  cellLines(cell.children, context, depth + 1).join('<br>');

/** The grid of a table, a cell that spans written in its first square and the others left empty. */
function gridOf(
  rows: readonly Row[],
  context: Context,
  depth: number,
): { grid: string[][]; columns: number; header: boolean } {
  const grid: string[][] = rows.map(() => []);
  const taken = rows.map(() => new Set<number>());
  let columns = 0;
  rows.forEach((cells, r) => {
    let column = 0;
    for (const cell of cells) {
      while (taken[r]!.has(column)) column += 1;
      grid[r]![column] = cellText(cell, context, depth);
      for (let down = r; down < Math.min(rows.length, r + cell.rowspan); down += 1) {
        for (let across = column; across < column + cell.colspan; across += 1) taken[down]!.add(across);
      }
      column += cell.colspan;
      columns = Math.max(columns, column);
    }
  });
  const header = rows[0] !== undefined && rows[0].length > 0 && rows[0].every((cell) => cell.header);
  return { grid, columns, header };
}

function tableMarkdown(block: Extract<Block, { kind: 'table' }>, context: Context, depth: number): string[] {
  const { grid, columns, header } = gridOf(block.rows, context, depth);
  const caption = block.caption ? paragraphLines(block.caption) : [];
  if (columns === 0) return caption;
  const line = (row: readonly (string | undefined)[]) =>
    `|${Array.from({ length: columns }, (_, at) => (row[at] ? ` ${row[at]} ` : ' ')).join('|')}|`;
  const [first = [], ...rest] = header ? grid : [[], ...grid];
  return [
    line(first),
    `|${Array.from({ length: columns }, () => ' --- ').join('|')}|`,
    ...rest.map(line),
    ...(caption.length ? ['', ...caption] : []),
  ];
}

// ── The file ────────────────────────────────────────────────────────────────

/** The Markdown file of a document (FR-EX-36), as text. */
export function renderMarkdown({ title, id, now, document, images }: MarkdownInput): string {
  const context: Context = { notes: new Map(), images };
  const body = blocksMarkdown(document.body, context, 0);
  // The footnotes come after the body, in the order of their markers: the number of a footnote is its place among them.
  const definitions: string[] = [];
  for (const [noteId, number] of context.notes) {
    const written = inlineMarkdown(document.entries.get(noteId) ?? [], {
      notes: new Map(),
      images: new Map(),
    });
    const [first = '', ...rest] = written.split('\n');
    definitions.push(`[^${number}]:${first === '' ? '' : ` ${first}`}`, ...indented(rest, '    '));
  }
  const lines = [
    '---',
    `title: ${yamlString(title)}`,
    `date: ${now.toISOString().slice(0, 10)}`,
    `id: ${id}`,
    'draft: true',
    '---',
    '',
    `> ${DRAFT_NOTE}`,
    ...(body.length ? ['', ...body] : []),
    ...(definitions.length ? ['', ...definitions] : []),
    '',
  ];
  const text = lines.join('\n');
  // The length of the text in characters bounds the bytes from below, and three times it from above.
  if (text.length * 3 > MARKDOWN_MOST_BYTES && Buffer.byteLength(text) > MARKDOWN_MOST_BYTES) {
    throw new MarkdownTooLarge();
  }
  return text;
}
