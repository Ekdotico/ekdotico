// The syntax colours of code blocks (FR-ED-03), shown however long the block
// (the owner's decision of 18 October 2026, register row D193, which retires
// the limit of D133 and reduces the fallback of D183 to a grammar that throws).
//
// Only the lines near the visible part of a block are coloured: its window,
// the visible lines and `CODE_COLOURS_MARGIN` lines either side. highlight.js
// cannot resume a colouring, but a colouring that ends in the language's top
// mode (`!result._top.parent`) ends where a fresh start is exact. Such restart
// points are collected from the start of each block, about every
// `CODE_COLOURS_EVERY` lines, in idle slices; a window is coloured from the
// point before it, and so as a colouring of the whole block would colour it.
// Until the points reach a window it is coloured from its own first line, and
// those provisional colours settle when they do.
//
// A key colours again only its own block: the points after the edit are
// dropped, the code from the point before it to the next point is coloured
// again, and if the grammar is back in its top mode there the later points
// stand, moved by the edit; then the window. A change from another client
// (which replaces the whole document) is found again by the order of the code
// blocks and by comparing their text, and leaves a window alone when it lies
// outside it.
//
// The colours are inline decorations with the classes highlight.js writes
// (`hljs-*`), so the design package's code.css colours them as before.
import HighlightJS from 'highlight.js/lib/core';
import { common } from 'lowlight';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';

/**
 * The colourer: highlight.js, pinned exactly (D193), with the languages of
 * lowlight's common set (D46). Exported for the tests, which watch it.
 */
export const codeHighlighter = HighlightJS.newInstance();
for (const [name, grammar] of Object.entries(common)) codeHighlighter.registerLanguage(name, grammar);

/** Lines coloured either side of the visible lines (D193, the owner's V1). */
export const CODE_COLOURS_MARGIN = 100;
/** The window moves when the visible lines come within this many lines of its edge. */
export const CODE_COLOURS_NEAR = 50;
/** Lines between restart points, at least. */
export const CODE_COLOURS_EVERY = 64;
/** The time of one slice of idle work, in milliseconds. */
export const CODE_COLOURS_SLICE = 8;
/**
 * A block longer than this, in characters, moves its window only when
 * scrolling stops (D193, V1, "in a very large block"). The row gives no
 * number: chosen here, the owner's to approve, as the length past which
 * drawing a moved window takes longer than a frame in the measurements.
 */
export const CODE_COLOURS_VERY_LARGE = 100_000;
/** How long scrolling has been still before it counts as stopped, in milliseconds. */
const SCROLL_STOPPED = 150;

/**
 * What the header of a code block says while its colours are not shown
 * because its grammar threw (D183 as D193 reduces it). Adapted from the
 * owner's words of 18 October 2026 (C1), with "took too long" removed now
 * that nothing is abandoned for its time; the owner's to approve.
 */
export const CODE_NOT_COLOURED =
  'Syntax colours are not shown in this code block. Colouring its code could not complete. Reopen the document to try again.';

/** A coloured piece: from, to (offsets in the block's text), and its classes. */
export type Span = readonly [number, number, string];

// ── Lines ───────────────────────────────────────────────────────────────────

/** The start of the line `lines` lines after the one holding `at`, or the end of the text. */
export function linesAfter(text: string, at: number, lines: number) {
  for (let i = 0; i < lines; i += 1) {
    const end = text.indexOf('\n', at);
    if (end === -1) return text.length;
    at = end + 1;
  }
  return at;
}

/** The start of the line `lines` lines before the one holding `at`. */
export function linesBefore(text: string, at: number, lines: number) {
  at = text.lastIndexOf('\n', at - 1) + 1;
  for (let i = 0; i < lines && at > 0; i += 1) at = text.lastIndexOf('\n', at - 2) + 1;
  return at;
}

// ── Colouring ───────────────────────────────────────────────────────────────

// What highlight.js keeps of a colouring, which its types do not show: the
// tree of scopes, and the mode it ended in. The tests hold both to what is
// relied on here.
interface TokenNode {
  scope?: string;
  children: (string | TokenNode)[];
}
interface Inside {
  _top: { parent?: unknown };
  _emitter: { rootNode: TokenNode };
  errorRaised?: Error;
}

// The classes of a scope as lowlight writes them: `title.function` is
// `hljs-title function_`, and code of another language inside is named by it.
const classesOf = (scope: string) =>
  scope.startsWith('language:')
    ? scope.slice('language:'.length)
    : scope
        .split('.')
        .map((part, at) => (at ? part + '_'.repeat(at) : `hljs-${part}`))
        .join(' ');

function walk(node: TokenNode, at: number, classes: string, out: Span[]): number {
  for (const child of node.children) {
    if (typeof child !== 'string') {
      at = walk(child, at, child.scope ? `${classes} ${classesOf(child.scope)}`.trim() : classes, out);
      continue;
    }
    const last = out[out.length - 1];
    if (classes && child.length) {
      // One piece for text of the same classes that follows on.
      if (last && last[1] === at && last[2] === classes)
        out[out.length - 1] = [last[0], at + child.length, classes];
      else out.push([at, at + child.length, classes]);
    }
    at += child.length;
  }
  return at;
}

/**
 * Colours `text` from `from` to `to` in `language`, as a colouring that starts
 * at `from` in the top mode. `top`: whether it ends in the top mode. Throws
 * where the grammar threw: highlight.js catches it and says so in the result.
 */
export function colour(language: string, text: string, from: number, to: number, spans = true) {
  const result = codeHighlighter.highlight(text.slice(from, to), {
    language,
    ignoreIllegals: true,
  }) as unknown as Inside;
  if (result.errorRaised) throw result.errorRaised;
  const out: Span[] = [];
  if (spans) walk(result._emitter.rootNode, from, '', out);
  return { spans: out, top: !result._top.parent };
}

// ── Restart points ──────────────────────────────────────────────────────────

/**
 * The restart points of one text in one language: offsets of line starts
 * where a colouring from the start of the text is in the top mode, so that a
 * colouring from there is exact. Collected from the start, a step at a time;
 * a cache of the text, so shared by every state that holds the same text.
 */
export class Restarts {
  points = [0];
  done = false;
  failed = false;
  // Lines in the next step: doubled while the grammar is not back in its top
  // mode, so that a long comment costs its length twice and not its square.
  private stride = CODE_COLOURS_EVERY;
  readonly language: string;
  readonly text: string;
  constructor(language: string, text: string) {
    this.language = language;
    this.text = text;
    if (!text.length) this.done = true;
  }
  /** The last point at or before `at`. */
  before(at: number) {
    const { points } = this;
    let low = 0;
    let high = points.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (points[mid]! <= at) low = mid;
      else high = mid - 1;
    }
    return points[low]!;
  }
  /** Whether the points have reached `at`. */
  reached(at: number) {
    return this.done || this.points[this.points.length - 1]! >= at;
  }
  /** Collects towards the next point. */
  step() {
    if (this.done || this.failed) return;
    const from = this.points[this.points.length - 1]!;
    const to = linesAfter(this.text, from, this.stride);
    try {
      const { top } = colour(this.language, this.text, from, to, false);
      if (to === this.text.length) this.done = true;
      else if (top) {
        this.points.push(to);
        this.stride = CODE_COLOURS_EVERY;
      } else this.stride *= 2;
    } catch {
      this.failed = true;
    }
  }
  /**
   * The points of `text`, which is this text with [start, oldEnd) replaced by
   * [start, newEnd). The points up to the edit stand; the code from the point
   * before it to the next point after it is coloured again, and if the grammar
   * is back in its top mode there, the later points stand too, moved. Throws
   * where the grammar threw.
   */
  edited(text: string, start: number, oldEnd: number, newEnd: number) {
    const next = new Restarts(this.language, text);
    const shift = newEnd - oldEnd;
    const kept = this.points.filter((point) => point <= start);
    // A point is a line start: the first after the edit that still is one.
    const after = this.points.findIndex((point) => point > oldEnd);
    next.points = kept;
    next.done = false;
    next.stride = this.stride;
    if (after === -1) return { restarts: next, back: Infinity };
    const back = this.points[after]! + shift;
    if (!colour(this.language, text, kept[kept.length - 1]!, back, false).top) {
      next.stride = CODE_COLOURS_EVERY;
      return { restarts: next, back: Infinity };
    }
    next.points = kept.concat(this.points.slice(after).map((point) => point + shift));
    next.done = this.done;
    return { restarts: next, back };
  }
}

// ── The blocks ──────────────────────────────────────────────────────────────

/** What is known of one code block: its text, its points, and its coloured window. */
export interface Block {
  readonly pos: number;
  readonly language: string;
  readonly text: string;
  readonly restarts: Restarts;
  /** The window, offsets of line starts (or the end) in the text. */
  readonly from: number;
  readonly to: number;
  readonly spans: readonly Span[];
  /** Whether the window was coloured from a restart point. */
  readonly exact: boolean;
  /** Whether a colouring threw: no colours until the document is opened again. */
  readonly failed: boolean;
}

/** Colours a block's window from the point before it, or, where the points are far from it, from its own start. */
function coloured(block: Omit<Block, 'spans' | 'exact'>): Block {
  if (block.failed || block.language === 'plaintext') return { ...block, spans: [], exact: true };
  const { restarts, from, to, text } = block;
  // A point that far before the window is near enough: the cost is that of
  // a window more.
  const exact = restarts.reached(from - (to - from));
  const start = exact ? restarts.before(from) : from;
  try {
    const { spans } = colour(block.language, text, start, to);
    return { ...block, spans: spans.filter((span) => span[1] > from), exact };
  } catch {
    return { ...block, failed: true, spans: [], exact: true };
  }
}

/** A block first met: its first lines, as if the top of it were seen. */
function fresh(pos: number, language: string, text: string): Block {
  return coloured({
    pos,
    language,
    text,
    restarts: new Restarts(language, text),
    from: 0,
    to: linesAfter(text, 0, 2 * CODE_COLOURS_MARGIN),
    failed: false,
  });
}

/** The block `was`, its text now `text`: the edit found by the text the two share at their ends. */
function edited(was: Block, pos: number, text: string): Block {
  // A block whose grammar threw is not coloured again until the document is opened again.
  if (was.failed) return { ...was, pos, text, restarts: new Restarts(was.language, text) };
  const old = was.text;
  const most = Math.min(old.length, text.length);
  let start = 0;
  while (start < most && old.charCodeAt(start) === text.charCodeAt(start)) start += 1;
  let end = 0;
  while (
    end < most - start &&
    old.charCodeAt(old.length - 1 - end) === text.charCodeAt(text.length - 1 - end)
  )
    end += 1;
  const oldEnd = old.length - end;
  const newEnd = text.length - end;
  const shift = newEnd - oldEnd;
  let restarts: Restarts;
  let back: number;
  try {
    ({ restarts, back } = was.restarts.edited(text, start, oldEnd, newEnd));
  } catch {
    return { ...was, pos, text, restarts: new Restarts(was.language, text), spans: [], failed: true };
  }
  const base = { pos, language: was.language, text, restarts, failed: was.failed || restarts.failed };
  // After the window, which does not reach the end: nothing of it changes.
  if (start >= was.to && was.to < old.length) return { ...was, ...base };
  // Before it, and the grammar back in its top mode before it: the same
  // colours, moved.
  if (oldEnd <= was.from && start < was.from) {
    const from = was.from + shift;
    const to = was.to + shift;
    if (back <= from) {
      const spans = was.spans.map(([a, b, classes]): Span => [a + shift, b + shift, classes]);
      return { ...base, from, to, spans, exact: was.exact };
    }
    return coloured({ ...base, from, to });
  }
  // In it: the window stays where it was, and is coloured again. (It does
  // not grow to hold an edit that runs past it: the page measures what is
  // visible after every change, and moves it.)
  const from = linesBefore(text, Math.min(was.from, text.length), 0);
  const to =
    was.to === old.length
      ? text.length
      : linesBefore(text, Math.min(text.length, Math.max(from, was.to + shift)), 0);
  return coloured({ ...base, from, to });
}

/** Where the window of `block` goes for the visible lines [seenFrom, seenTo), or null where it stays. */
export function moved(block: Block, seenFrom: number, seenTo: number): [number, number] | null {
  const { text } = block;
  const near = [linesBefore(text, seenFrom, CODE_COLOURS_NEAR), linesAfter(text, seenTo, CODE_COLOURS_NEAR)];
  if (block.from <= near[0]! && block.to >= near[1]!) return null;
  return [linesBefore(text, seenFrom, CODE_COLOURS_MARGIN), linesAfter(text, seenTo, CODE_COLOURS_MARGIN)];
}

// ── The plugin ──────────────────────────────────────────────────────────────

/** What a transaction may tell the plugin. */
export type Meta =
  /** The visible part of blocks, as offsets in each block's text. */
  | { visible: { pos: number; from: number; to: number }[] }
  /** The idle work collected points: settle provisional windows that they reach. */
  | { settle: true };

export interface CodeColoursState {
  readonly blocks: readonly Block[];
  readonly decorations: DecorationSet;
}

export const codeColoursKey = new PluginKey<CodeColoursState>('codeColours');

/** The code blocks of a document, in order. */
function codeBlocks(doc: PMNode) {
  const found: { pos: number; node: PMNode }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') found.push({ pos, node });
    return !node.isTextblock;
  });
  return found;
}

function decorationsOf(block: Block, size: number) {
  const start = block.pos + 1;
  if (block.failed) return [Decoration.node(block.pos, block.pos + size, {}, { codeColoursFailed: true })];
  return block.spans.map(([from, to, classes]) =>
    Decoration.inline(start + from, start + to, { class: classes }),
  );
}

/** Whether a step of the transaction touched the range [from, to) of the document before it. */
function touched(tr: Transaction, from: number, to: number) {
  for (const map of tr.mapping.maps) {
    let hit = false;
    map.forEach((oldStart, oldEnd) => {
      if (oldStart <= to && oldEnd >= from) hit = true;
    });
    if (hit) return true;
    from = map.map(from, 1);
    to = map.map(to, -1);
  }
  return false;
}

/**
 * The plugin, given how a block's language is read from its attribute
 * (`language`, which names one of the list or `plaintext`).
 */
export function codeColours(language: (given: unknown) => string) {
  const read = (node: PMNode) => ({ language: language(node.attrs.language), text: node.textContent });

  function rematch(prev: CodeColoursState, tr: Transaction) {
    const now = codeBlocks(tr.doc);
    const old = prev.blocks;
    const pairs = new Array<Block | undefined>(now.length);
    if (now.length === old.length) now.forEach((_, at) => (pairs[at] = old[at]));
    else {
      // Blocks added or taken away: the same text first, then by order.
      const left = new Set(old);
      const byText = new Map<string, Block[]>();
      for (const block of old) byText.set(block.text, [...(byText.get(block.text) ?? []), block]);
      now.forEach(({ node }, at) => {
        const same = byText.get(node.textContent)?.find((block) => left.has(block));
        if (same) left.delete((pairs[at] = same));
      });
      const rest = [...left];
      now.forEach((_, at) => (pairs[at] ??= rest.shift()));
    }
    let decorations = prev.decorations.map(tr.mapping, tr.doc);
    const blocks = now.map(({ pos, node }, at): Block => {
      const was = pairs[at];
      const { language, text } = read(node);
      let block: Block;
      if (!was || was.language !== language) block = fresh(pos, language, text);
      else if (was.text === text) {
        block = was.pos === pos ? was : { ...was, pos };
        if (!touched(tr, was.pos, was.pos + node.nodeSize)) return block;
      } else block = edited(was, pos, text);
      decorations = redraw(decorations, tr.doc, block, node.nodeSize);
      return block;
    });
    return { blocks, decorations };
  }

  function redraw(decorations: DecorationSet, doc: PMNode, block: Block, size: number) {
    const stale = decorations.find(block.pos + 1, block.pos + size - 1);
    return decorations.remove(stale).add(doc, decorationsOf(block, size));
  }

  return new Plugin<CodeColoursState>({
    key: codeColoursKey,
    state: {
      init(_, state) {
        const blocks = codeBlocks(state.doc).map(({ pos, node }) => {
          const { language: lang, text } = read(node);
          return fresh(pos, lang, text);
        });
        const decorations = DecorationSet.create(
          state.doc,
          blocks.flatMap((block) => decorationsOf(block, state.doc.nodeAt(block.pos)!.nodeSize)),
        );
        return { blocks, decorations };
      },
      apply(tr, prev) {
        const meta = tr.getMeta(codeColoursKey) as Meta | undefined;
        if (!tr.docChanged && !meta) return prev;
        let { blocks, decorations } = tr.docChanged ? rematch(prev, tr) : prev;
        if (!meta) return { blocks, decorations };
        const size = (block: Block) => tr.doc.nodeAt(block.pos)!.nodeSize;
        blocks = blocks.map((block) => {
          let next = block;
          if ('settle' in meta) {
            if (block.restarts.failed && !block.failed) next = { ...block, failed: true, spans: [] };
            else if (!block.exact && block.restarts.reached(block.from - (block.to - block.from)))
              next = coloured(block);
          } else {
            const seen = meta.visible.find((each) => each.pos === block.pos);
            const to = seen && moved(block, seen.from, seen.to);
            if (to) next = coloured({ ...block, from: to[0], to: to[1] });
          }
          if (next !== block) decorations = redraw(decorations, tr.doc, next, size(next));
          return next;
        });
        return { blocks, decorations };
      },
    },
    props: {
      decorations: (state) => codeColoursKey.getState(state)!.decorations,
    },
    view: (view) => watch(view),
  });
}

// ── The page: what is visible, and the idle work ────────────────────────────

/** Runs every step of the idle work at once (for the tests: the page runs it in slices). */
export function collectAll(state: EditorState) {
  for (const block of codeColoursKey.getState(state)!.blocks)
    while (!block.failed && !block.restarts.done && !block.restarts.failed) block.restarts.step();
}

function watch(view: EditorView) {
  let frame = 0;
  let stopped: ReturnType<typeof setTimeout> | undefined;
  let idle = 0;
  const idleCallbacks = typeof requestIdleCallback === 'function';

  /** Tells the plugin of the visible part of each block whose window should move. */
  function measure(still: boolean) {
    frame = 0;
    const height = window.innerHeight;
    const visible: { pos: number; from: number; to: number }[] = [];
    for (const block of codeColoursKey.getState(view.state)!.blocks) {
      if (block.text.length > CODE_COLOURS_VERY_LARGE && !still) continue;
      const element = view.nodeDOM(block.pos);
      const code = element instanceof HTMLElement ? (element.querySelector('code') ?? element) : null;
      if (!code) continue;
      const box = code.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, height);
      if (bottom <= top) continue;
      const first = view.posAtCoords({ left: box.left + 1, top: top + 1 });
      const last = view.posAtCoords({ left: box.right - 1, top: bottom - 1 });
      if (!first || !last) continue;
      const inside = (pos: number) => Math.min(Math.max(pos - block.pos - 1, 0), block.text.length);
      const seen = { pos: block.pos, from: inside(first.pos), to: inside(last.pos) };
      if (moved(block, seen.from, seen.to)) visible.push(seen);
    }
    if (visible.length) view.dispatch(view.state.tr.setMeta(codeColoursKey, { visible } satisfies Meta));
  }
  const soon = () => (frame ||= requestAnimationFrame(() => measure(false)));
  function scrolled() {
    soon();
    clearTimeout(stopped);
    stopped = setTimeout(() => measure(true), SCROLL_STOPPED);
  }

  /** One slice of collecting points, the blocks whose windows are provisional first. */
  function work() {
    idle = 0;
    const until = performance.now() + CODE_COLOURS_SLICE;
    const blocks = [...codeColoursKey.getState(view.state)!.blocks].sort(
      (a, b) => Number(a.exact) - Number(b.exact),
    );
    for (const block of blocks) {
      while (!block.failed && !block.restarts.done && !block.restarts.failed && performance.now() < until)
        block.restarts.step();
    }
    const settle = blocks.some(
      (block) =>
        (block.restarts.failed && !block.failed) ||
        (!block.exact && block.restarts.reached(block.from - (block.to - block.from))),
    );
    if (settle) view.dispatch(view.state.tr.setMeta(codeColoursKey, { settle: true } satisfies Meta));
    later();
  }
  function later() {
    if (idle) return;
    const left = codeColoursKey
      .getState(view.state)!
      .blocks.some((block) => !block.restarts.done && !block.restarts.failed && !block.failed);
    if (!left) return;
    idle = idleCallbacks ? requestIdleCallback(work, { timeout: 1000 }) : window.setTimeout(work, 1);
  }

  window.addEventListener('scroll', scrolled, { capture: true, passive: true });
  window.addEventListener('resize', scrolled, { passive: true });
  soon();
  later();
  return {
    update(_: EditorView, prev: EditorState) {
      if (view.state.doc !== prev.doc) soon();
      later();
    },
    destroy() {
      window.removeEventListener('scroll', scrolled, { capture: true });
      window.removeEventListener('resize', scrolled);
      cancelAnimationFrame(frame);
      clearTimeout(stopped);
      if (idleCallbacks) cancelIdleCallback(idle);
      else clearTimeout(idle);
    },
  };
}
