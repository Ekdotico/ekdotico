// A document written as Markdown (FR-EX-36, FR-EX-02; docs/plan/slice-21.md, section 6, which has the table of
// what each block becomes). CommonMark with the GitHub extensions a table and a strikethrough need, and the
// footnotes of GitHub and Pandoc.
//
// THE TEXT OF THE DOCUMENT IS TEXT. A character the user typed that Markdown would read as syntax is written after
// a backslash (or as a character reference where a backslash does not reach), so that it reads as it was written
// and so that no raw HTML, no link and no image the user did not make can come out of it (NFR-SE-06, NFR-SE-08).
// The only HTML in a file is the five elements of FR-EX-36 (`u`, `sup`, `sub`, `mark` around escaped text, and `br`
// in a table cell, which a cell has no other way to break a line with), and the only address is a link's, held to
// the editor's rule (src/lib/editor/link.ts) when it was read (./read.ts).
//
// WHAT IS NOT KEPT (NFR-I18-03: "no character is removed" of the user's text; register row S21-11). Every code point
// of a text is in the file, as it is or after a backslash. What Markdown has no way to hold is not: the spaces and
// tabs at the end of a block and at the edge of a heading, a block of nothing but spaces, a line end that begins or
// ends a block (a backslash there would be a character), a line end in inline code (a space), and, in a table cell,
// the line ends of a block (`<br>`).
//
// IT IS WRITTEN BY LOOPS, NOT BY SPREADS: `push(...lines)` and `Math.max(...runs)` are calls with an argument for
// each element, and a call with some 120,000 of them overflows the stack. And no step takes time as the square of a
// run of spaces (a regular expression anchored at the end does): the white space at the end of what is written is
// held apart, and cut by a loop (the review of pull request 59).
import { MAX_ELEMENT_DEPTH } from '../collab/state.ts';
import type { Block, Cell, Inline, Mark, ReadDocument, Row } from './read.ts';

/**
 * The most a file may be, in bytes. The Docs bound the images of an archive and not the text beside them (register
 * row S21-8), and a document of 5 MB can write a larger file (indentation, escapes, the cells of a table). Past it
 * the export fails before it sends a byte, and it is asked while the file is written (`spend`), so that a document
 * that would pass it is stopped and not built whole first.
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

/** The numbers footnotes take, in the order the markers are met; what an image is written as; and what has been written. */
interface Context {
  notes: Map<string, number>;
  images: ReadonlyMap<string, string>;
  /** The bytes written so far, as near as the steps count them: the file is refused past `MARKDOWN_MOST_BYTES`. */
  bytes: number;
}

/** Counts what a step writes, and stops the file where it passes the bound. */
function spend(context: Context, bytes: number): void {
  context.bytes += bytes;
  if (context.bytes > MARKDOWN_MOST_BYTES) throw new MarkdownTooLarge();
}

/** Adds the lines to the end of a list, by a loop (see the head of this file). */
function append(to: string[], lines: readonly string[]): void {
  for (const line of lines) to.push(line);
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

/** The longest run of backticks in a text, by one pass. */
function longestRun(text: string): number {
  let longest = 0;
  let run = 0;
  for (let at = 0; at < text.length; at += 1) {
    run = text.charCodeAt(at) === 96 ? run + 1 : 0;
    if (run > longest) longest = run;
  }
  return longest;
}

/** A text without the spaces and tabs at its end, by a loop: `/[ \t]+$/` takes time as the square of a run of them. */
function withoutTrailingBlanks(text: string): string {
  let end = text.length;
  while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}

/** A backtick span for the code, with a delimiter longer than any run of backticks in it. */
function codeSpan(code: string): string {
  const fence = '`'.repeat(longestRun(code) + 1);
  // A space is taken off each side of a span that has one on both; a span that begins or ends with a backtick
  // would run into its delimiter. Either way one space is put on each side to be taken off.
  const pad = /^[ `]|[ `]$/u.test(code) && !/^ +$/u.test(code) ? ' ' : '';
  return `${fence}${pad}${code}${pad}${fence}`;
}

/** An address as a link destination: nothing in it can end the link. It holds no space, control character or backslash (linkAddress). */
function destination(href: string, cell: boolean): string {
  // In a cell of a table a vertical bar ends the cell, whatever stands round it: it is written as the escape of an address.
  return href
    .replace(cell ? /[()<>"|]/gu : /[()<>"]/gu, (each) => `%${each.charCodeAt(0).toString(16).toUpperCase()}`)
    .replace(REFERENCE, '\\&');
}

/**
 * Nothing but what Markdown calls white space: a space, a tab, a line end. A no-break space is a character of the text
 * and is kept, which `trim` of the language would not (NFR-I18-03).
 */
const blank = (text: string) => /^[ \t\r\n]*$/u.test(text);
const stripped = (text: string) => withoutTrailingBlanks(text).replace(/^[ \t]+/u, '');
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

function delimiters(mark: Mark, cell: boolean): [string, string] {
  if (mark.name === 'link') return ['[', `](${destination(mark.href, cell)})`];
  if (mark.name === 'code') return ['', ''];
  return OPEN[mark.name];
}

/** How the inline content of one block is written; a table cell and a heading each hold one line. */
interface Place {
  /** A cell of a table: a line break is `<br>`, a vertical bar is escaped in code and in an address too. */
  cell?: boolean;
  /** A heading: one line, and a `#` is escaped wherever it stands. */
  heading?: boolean;
  /** The words of a footnote: a marker in them is nothing. */
  entry?: boolean;
}

const BREAK_PATTERN = /\r\n|[\n\r]/u;
const NO_SPANS: ReadonlyMap<string, number> = new Map();

/**
 * Inline content as Markdown, possibly over several lines (a line break is a backslash at the end of a line).
 * Adjacent runs that hold the same marks are one run; marks are nested in a fixed order and shared between
 * neighbours (one `**` over two runs that are both bold); and the white space at the edge of a run is put outside
 * the delimiters, since `** a **` is not bold.
 */
export function inlineMarkdown(content: readonly Inline[], context: Context, place: Place = {}): string {
  const cell = place.cell === true;
  // A line end in text is a line break, as it would be to a reader of the editor's text; one in code is a space.
  const expanded: Inline[] = [];
  for (const each of content) {
    // A marker with no valid identifier is nothing.
    if (each.kind === 'note' && (each.id === null || place.entry)) continue;
    if (
      each.kind !== 'text' ||
      each.marks.some((mark) => mark.name === 'code') ||
      !BREAK_PATTERN.test(each.text)
    ) {
      expanded.push(each);
      continue;
    }
    each.text.split(BREAK_PATTERN).forEach((part, at) => {
      if (at > 0) expanded.push({ kind: 'break' });
      if (part !== '') expanded.push({ ...each, text: part });
    });
  }
  // Neighbours that hold the same marks are one run.
  const runs: Inline[] = [];
  for (const each of expanded) {
    const last = runs.at(-1);
    if (each.kind === 'text' && last?.kind === 'text' && sameMarks(last.marks, each.marks)) {
      runs[runs.length - 1] = { ...last, text: last.text + each.text };
    } else runs.push(each);
  }
  // A line break that begins or ends a block breaks nothing, and the backslash of one would be read as a character;
  // nor does white space that follows the last.
  while (runs.length > 0 && (runs.at(-1)!.kind === 'break' || isSpace(runs.at(-1)!))) runs.pop();
  // (Blank lines at the start of a block are the same: white space and then a break, as often as there are. The
  // last break of the white space and breaks that open the block is where the block begins.)
  let begin = 0;
  for (let at = 0; at < runs.length; at += 1) {
    const run = runs[at]!;
    if (run.kind === 'break') begin = at + 1;
    else if (run.kind !== 'text' || !isSpace(run)) break;
  }
  const starts = begin === 0 ? runs : runs.slice(begin);

  // What is written is in `parts`, in order, and the white space at its end is held apart in `held`, written when
  // something follows it and dropped when nothing does: a mark that closes is written before it (`**a **` is not
  // bold), and the end of the block loses it, without a step that looks back over what was written.
  const parts: string[] = [];
  let held = '';
  // Where a line begins a block: not in a heading or a cell, which stand after their own syntax.
  const oneLine = place.heading === true || cell;
  let lineStart = !oneLine;
  const open: Mark[] = [];

  const emit = (text: string) => {
    if (text === '') return;
    lineStart = false;
    let end = text.length;
    while (end > 0 && (text.charCodeAt(end - 1) === 32 || text.charCodeAt(end - 1) === 9)) end -= 1;
    if (end === 0) {
      held += text;
      return;
    }
    if (held !== '') {
      parts.push(held);
      held = '';
    }
    parts.push(end === text.length ? text : text.slice(0, end));
    held = text.slice(end);
  };
  const lineBreak = () => {
    if (held !== '') {
      parts.push(held);
      held = '';
    }
    parts.push(place.heading ? ' ' : cell ? '<br>' : '\\\n');
    lineStart = !oneLine;
  };
  // Closed before any white space at the end.
  const close = (count: number) => {
    if (count <= 0) return;
    for (const mark of open.splice(open.length - count, count).reverse())
      parts.push(delimiters(mark, cell)[1]);
  };
  // A `!` just before a `[` makes the link that follows an image: the one before it is written `\!`.
  const beforeBracket = () => {
    if (held !== '' || parts.length === 0) return;
    const last = parts[parts.length - 1]!;
    if (last.endsWith('!')) parts[parts.length - 1] = `${last.slice(0, -1)}\\!`;
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
  const spans: ReadonlyMap<string, number>[] = [];
  for (let at = starts.length - 1; at >= 0; at -= 1) {
    const run = starts[at]!;
    const next = spans[at + 1] ?? NO_SPANS;
    if (run.kind !== 'text') spans[at] = NO_SPANS;
    else if (isSpace(run)) spans[at] = next;
    else if (run.marks.length === 0) spans[at] = NO_SPANS;
    else {
      const here = new Map<string, number>();
      for (const mark of run.marks) here.set(keyOf(mark), 1 + (next.get(keyOf(mark)) ?? 0));
      spans[at] = here;
    }
  }

  starts.forEach((run, at) => {
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
        if (mark.name === 'link') beforeBracket();
        emit(delimiters(mark, cell)[0]);
        open.push(mark);
      }
      if (code) {
        // A code span holds one line: a line break in it is a space.
        const span = codeSpan(text.split(BREAK_PATTERN).join(' '));
        emit(cell ? span.replace(/\|/gu, '\\|') : span);
      } else {
        writeText(text.slice(lead.length));
      }
    } else {
      close(open.length);
      if (run.kind === 'break') lineBreak();
      else if (run.id !== null) {
        const number = context.notes.get(run.id) ?? context.notes.size + 1;
        context.notes.set(run.id, number);
        beforeBracket();
        emit(`[^${number}]`);
      }
    }
  });
  close(open.length);
  // What is held is the white space at the end of the block: nothing to Markdown.
  const written = parts.join('');
  spend(context, Buffer.byteLength(written));
  return written;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

/** The lines with a prefix each, and the bytes of the prefixes counted. */
function indented(lines: string[], by: string, context: Context): string[] {
  spend(context, lines.length * by.length);
  return lines.map((line) => (line === '' ? '' : by + line));
}
function quoted(lines: string[], context: Context): string[] {
  spend(context, lines.length * 2);
  return lines.map((line) => (line === '' ? '>' : `> ${line}`));
}

/** The lines of a sequence of blocks, a blank line between one and the next. */
function blocksMarkdown(blocks: readonly Block[], context: Context, depth: number): string[] {
  const out: string[] = [];
  let previous: Block | undefined;
  for (const block of blocks) {
    const lines = blockMarkdown(block, context, depth, previous);
    if (lines.length === 0) continue;
    if (out.length > 0) out.push('');
    append(out, lines);
    previous = block;
  }
  return out;
}

/** The marker each list was written with, so that the list that follows one of its kind takes the other. */
const MARKERS = new WeakMap<Block, string>();

function listMarkdown(
  block: Extract<Block, { kind: 'list' }>,
  context: Context,
  depth: number,
  previous: Block | undefined,
): string[] {
  // A list that follows another of its kind would be read as the same list: a different marker makes it a new one,
  // and the third takes the first's again, since it is the second's that it must differ from.
  const before =
    previous?.kind === 'list' && previous.ordered === block.ordered ? MARKERS.get(previous) : undefined;
  const marker = block.ordered ? (before === '.' ? ')' : '.') : before === '-' ? '*' : '-';
  MARKERS.set(block, marker);
  const out: string[] = [];
  block.items.forEach((item, at) => {
    const own = `${block.ordered ? block.start + at : ''}${marker} `;
    const body = itemMarkdown(item, context, depth);
    out.push(withoutTrailingBlanks(`${own}${body[0] ?? ''}`));
    if (body.length > 1) append(out, indented(body.slice(1), ' '.repeat(own.length), context));
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
    append(out, lines);
    previous = block;
  }
  return out;
}

function imageLines(block: Extract<Block, { kind: 'image' }>, context: Context, place: Place = {}): string[] {
  const alt = escapeText(block.alt.replace(/\r\n|[\n\r]/gu, ' '));
  const caption = block.caption ? paragraphLines(block.caption, context, place) : [];
  const path = block.id === null ? undefined : context.images.get(block.id);
  if (path === undefined) {
    // The image is not available (docs/plan/slice-21.md, S21-1): its words, and no link.
    const words = alt ? paragraphLines(block.alt, context, place) : [];
    return [...words, ...(words.length && caption.length ? [''] : []), ...caption];
  }
  return [`![${alt}](${path})`, ...(caption.length ? ['', ...caption] : [])];
}

/** A paragraph of plain text: a caption, an alt text on its own. In a cell it is one line. */
function paragraphLines(text: string, context: Context, place: Place = {}): string[] {
  const written = inlineMarkdown([{ kind: 'text', text, marks: [] }], context, place);
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
      spend(context, Buffer.byteLength(block.text));
      const fence = '`'.repeat(Math.max(3, longestRun(block.text) + 1));
      const code = block.text === '' ? [] : block.text.split(/\r\n|[\n\r]/u);
      return [`${fence}${block.language ?? ''}`, ...code, fence];
    }
    case 'rule':
      return ['---'];
    case 'quote':
      return quoted(blocksMarkdown(block.children, context, depth + 1), context);
    case 'callout': {
      const label = { note: 'Note', warning: 'Warning', tip: 'Tip' }[block.variant];
      const body = blocksMarkdown(block.children, context, depth + 1);
      return quoted([`**${label}**`, ...(body.length ? ['', ...body] : [])], context);
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
  const here: Place = { cell: true };
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case 'paragraph':
      case 'heading': {
        const text = inlineMarkdown(block.content, context, here);
        if (!blank(text)) out.push(text);
        break;
      }
      case 'code':
        spend(context, Buffer.byteLength(block.text));
        for (const line of block.text.split(/\r\n|[\n\r]/u))
          if (line !== '') out.push(codeSpan(line).replace(/\|/gu, '\\|'));
        break;
      case 'quote':
      case 'callout':
        append(out, cellLines(block.children, context, depth + 1));
        break;
      case 'list':
        for (const item of block.items) append(out, cellLines(item, context, depth + 1));
        break;
      case 'table':
        for (const row of block.rows)
          for (const cell of row) append(out, cellLines(cell.children, context, depth + 1));
        if (block.caption) append(out, paragraphLines(block.caption, context, here));
        break;
      case 'image':
        append(
          out,
          imageLines(block, context, here).filter((line) => line !== ''),
        );
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
  const caption = block.caption ? paragraphLines(block.caption, context) : [];
  if (columns === 0) return caption;
  const line = (row: readonly (string | undefined)[]) =>
    `|${Array.from({ length: columns }, (_, at) => (row[at] ? ` ${row[at]} ` : ' ')).join('|')}|`;
  const out: string[] = [];
  out.push(line(header ? (grid[0] ?? []) : []));
  out.push(`|${Array.from({ length: columns }, () => ' --- ').join('|')}|`);
  for (const row of header ? grid.slice(1) : grid) out.push(line(row));
  if (caption.length) {
    out.push('');
    append(out, caption);
  }
  return out;
}

// ── Footnotes ───────────────────────────────────────────────────────────────

/**
 * Whether the words of a footnote, on the line of its label, could be read by a renderer that has no footnotes as the
 * rest of a link reference definition: `[^1]: https://evil.example/x` is one, and every `[^1]` is then a link to it
 * (the review of pull request 59). A definition is a label, a destination (one word) and, after it, nothing or a
 * title; so the line is safe where it holds a second word that does not begin a title. Otherwise the words go on
 * the lines below, indented, after a blank one (register row S21-10): the footnotes of GitHub, Pandoc and
 * `markdown-it-footnote` take them as the footnote's, and a renderer without footnotes sees an empty definition,
 * which is none, and a block of code.
 */
function couldBeDefinition(first: string): boolean {
  const words = first.trim().split(/[ \t]+/u);
  return words.length === 1 || /^["'(]/u.test(words[1]!);
}

function definitionLines(
  number: number,
  written: string,
  context: Context,
): { lines: string[]; loose: boolean } {
  const label = `[^${number}]:`;
  if (written === '') return { lines: [label], loose: false };
  const words = written.split('\n');
  const lines: string[] = [];
  if (couldBeDefinition(words[0]!)) {
    lines.push(label, '');
    append(lines, indented(words, '    ', context));
    // A blank line follows it, or the next entry would be read as a line of its last paragraph.
    return { lines, loose: true };
  }
  lines.push(`${label} ${words[0]}`);
  append(lines, indented(words.slice(1), '    ', context));
  return { lines, loose: false };
}

// ── The file ────────────────────────────────────────────────────────────────

/** The Markdown file of a document (FR-EX-36), as text. */
export function renderMarkdown({ title, id, now, document, images }: MarkdownInput): string {
  const context: Context = { notes: new Map(), images, bytes: 0 };
  const body = blocksMarkdown(document.body, context, 0);
  // The footnotes come after the body, in the order of their markers: the number of a footnote is its place among them.
  const definitions: string[] = [];
  let loose = false;
  for (const [noteId, number] of context.notes) {
    const written = inlineMarkdown(document.entries.get(noteId) ?? [], context, { entry: true });
    const entry = definitionLines(number, written, context);
    if (loose) definitions.push('');
    append(definitions, entry.lines);
    loose = entry.loose;
  }
  const lines: string[] = [
    '---',
    `title: ${yamlString(title)}`,
    `date: ${now.toISOString().slice(0, 10)}`,
    `id: ${id}`,
    'draft: true',
    '---',
    '',
    `> ${DRAFT_NOTE}`,
  ];
  if (body.length) {
    lines.push('');
    append(lines, body);
  }
  if (definitions.length) {
    lines.push('');
    append(lines, definitions);
  }
  lines.push('');
  const text = lines.join('\n');
  // The steps counted what they wrote; this is what the file came to.
  if (text.length * 3 > MARKDOWN_MOST_BYTES && Buffer.byteLength(text) > MARKDOWN_MOST_BYTES) {
    throw new MarkdownTooLarge();
  }
  return text;
}
