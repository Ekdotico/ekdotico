// The syntax colours near the view (D193): code-colours.ts. Each test names
// the rule it holds; the colours of the whole block, the oracle, are
// lowlight's, as the library's own plugin coloured before.
import { readFileSync } from 'node:fs';
import { getExtensionField, getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { EditorState, type Plugin } from '@tiptap/pm/state';
import HighlightJS from 'highlight.js/lib/core';
import { common, createLowlight } from 'lowlight';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import {
  CODE_COLOURS_FROM_POINT_MOST,
  CODE_COLOURS_LONGEST,
  CODE_COLOURS_MARGIN,
  CODE_COLOURS_STEP_MOST,
  CODE_COLOURS_WINDOW_MOST,
  CODE_NOT_COLOURED,
  clock,
  codeColours,
  codeColoursKey,
  codeHighlighter,
  collectAll,
  colour,
  linesAfter,
  type Meta,
} from '../../src/app/(app)/documents/[id]/code-colours.ts';
import { closeSchema, codeLanguage, extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';

const all = extensions(new Y.Doc());
const schema: Schema = closeSchema(getSchema(all));
const plugin = codeColours(codeLanguage);
const lowlight = createLowlight(common);

// Real code: the editor library's own build, with its comments, regular expressions and template literals.
const SOURCE = readFileSync('node_modules/@tiptap/core/dist/index.js', 'utf8');
function code(size: number) {
  let text = '';
  while (text.length < size) text += SOURCE;
  return text.slice(0, text.lastIndexOf('\n', size) + 1);
}

const blockNode = (language: string, text: string) =>
  schema.node('codeBlock', { language }, text ? [schema.text(text)] : []);
const open = (...blocks: [string, string][]) =>
  EditorState.create({
    schema,
    doc: schema.node(
      'doc',
      null,
      blocks.map(([language, text]) => blockNode(language, text)),
    ),
    plugins: [plugin],
  });
const blocks = (state: EditorState) => codeColoursKey.getState(state)!.blocks;
const meta = (state: EditorState, given: Meta) => state.apply(state.tr.setMeta(codeColoursKey, given));
/** The visible part of block `index` is `lines` lines from its line `line`. */
function see(state: EditorState, index: number, line: number, lines = 40) {
  const block = blocks(state)[index]!;
  const from = linesAfter(block.text, 0, line);
  return meta(state, { visible: [{ pos: block.pos, from, to: linesAfter(block.text, from, lines) }] });
}
/** The idle work, done to its end, and the windows it reaches settled. */
function settled(state: EditorState) {
  collectAll(state);
  return meta(state, { settle: true });
}
/** `inserted` typed at `offset` in block `index`. */
function typed(state: EditorState, index: number, offset: number, inserted: string) {
  const at = blocks(state)[index]!.pos + 1 + offset;
  return state.apply(state.tr.insertText(inserted, at));
}
/** The same document with block `index` as `text`, as a change from another client arrives: the whole document replaced. */
function remote(state: EditorState, index: number, text: string) {
  const nodes: ReturnType<typeof blockNode>[] = [];
  state.doc.forEach((node, _, at) => nodes.push(at === index ? blockNode(node.attrs.language, text) : node));
  return state.apply(state.tr.replaceWith(0, state.doc.content.size, nodes));
}

/** The classes painted on each character of block `index`, from the decorations. */
function painted(state: EditorState, index: number) {
  const block = blocks(state)[index]!;
  const start = block.pos + 1;
  const out: string[] = Array.from({ length: block.text.length }, () => '');
  for (const each of codeColoursKey.getState(state)!.decorations.find(start, start + block.text.length)) {
    const classes = (each as unknown as { type: { attrs: { class?: string } } }).type.attrs.class;
    if (classes) out.fill(classes, each.from - start, each.to - start);
  }
  return out;
}
interface Hast {
  type: string;
  value?: string;
  children?: Hast[];
  properties?: { className?: string[] };
}
/** The classes of each character as lowlight colours the whole text. */
function oracle(language: string, text: string) {
  const out: string[] = Array.from({ length: text.length }, () => '');
  let at = 0;
  const walk = (nodes: Hast[], classes: string[]) => {
    for (const node of nodes) {
      if (node.type === 'text') {
        if (classes.length) out.fill(classes.join(' '), at, at + node.value!.length);
        at += node.value!.length;
      } else walk(node.children ?? [], [...classes, ...(node.properties?.className ?? [])]);
    }
  };
  walk(lowlight.highlight(language, text).children as Hast[], []);
  return out;
}
/** Where two paintings differ within [from, to), as a count. */
const wrong = (a: string[], b: string[], from: number, to: number) => {
  let count = 0;
  for (let at = from; at < to; at += 1) if (a[at] !== b[at]) count += 1;
  return count;
};
/** Records the code each colouring is given. */
function watchColourings() {
  const given: string[] = [];
  const highlight = codeHighlighter.highlight.bind(codeHighlighter);
  vi.spyOn(codeHighlighter, 'highlight').mockImplementation(((text: string, options: never) => {
    given.push(text);
    return highlight(text, options);
  }) as never);
  return given;
}
afterEach(() => vi.restoreAllMocks());

// D193: "highlight.js is pinned, with a test on the internal detail that the design relies on."
describe('the internals of highlight.js that the colours rely on', () => {
  it('are those of the version pinned', () => {
    // A new version is read again against this file before it is taken.
    expect(HighlightJS.versionString).toBe('11.11.2');
  });

  it('say whether a colouring ends in the top mode of its language (`_top` without a parent)', () => {
    expect(colour('javascript', 'const a = 1;\n', 0, 13).top).toBe(true);
    expect(colour('javascript', 'const a = `open\n', 0, 16).top).toBe(false);
    expect(colour('javascript', '/* open\n', 0, 8).top).toBe(false);
    expect(colour('python', 'x = """open\n', 0, 12).top).toBe(false);
    expect(colour('xml', '<script>\nlet a;\n', 0, 16).top).toBe(false);
  });

  it('keep the tree of scopes, which gives the classes lowlight gives', () => {
    const text = 'const a = `b${c}`; // d\nclass E extends F {}\n';
    const spans = colour('javascript', text, 0, text.length).spans;
    const mine: string[] = Array.from({ length: text.length }, () => '');
    for (const [from, to, classes] of spans) mine.fill(classes, from, to);
    expect(mine).toEqual(oracle('javascript', text));
    expect(spans.some(([, , classes]) => classes === 'hljs-title class_')).toBe(true);
  });

  it('let a colouring from a point in the top mode carry on exactly as one colouring of the whole', () => {
    const text = code(200_000);
    const whole = oracle('javascript', text);
    let checked = 0;
    for (let line = 64; line < 4000; line += 97) {
      const point = linesAfter(text, 0, line);
      if (!colour('javascript', text, 0, point, false).top) continue;
      const rest = colour('javascript', text, point, linesAfter(text, point, 300));
      const mine: string[] = whole.slice();
      mine.fill('', point, rest.spans.at(-1)![1]);
      for (const [from, to, classes] of rest.spans) mine.fill(classes, from, to);
      expect(wrong(mine, whole, point, rest.spans.at(-1)![1] - 200)).toBe(0);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('the colours of a code block', () => {
  it('are exact at every window, as one colouring of the whole block, once the points are collected', () => {
    const text = code(400_000);
    let state = settled(open(['javascript', text]));
    const whole = oracle('javascript', text);
    const lines = text.split('\n').length;
    let naiveWrong = 0;
    for (let at = 0; at < 40; at += 1) {
      state = see(state, 0, Math.floor((lines * (at + 0.5)) / 40));
      const block = blocks(state)[0]!;
      expect(block.exact).toBe(true);
      // The last characters: a token cut at the window's end.
      expect(wrong(painted(state, 0), whole, block.from, block.to - 200)).toBe(0);
      // The same window coloured from its own first line is wrong somewhere, or the check proves nothing.
      const naive: string[] = Array.from({ length: text.length }, () => '');
      for (const [from, to, classes] of colour('javascript', text, block.from, block.to).spans)
        naive.fill(classes, from, to);
      if (wrong(naive, whole, block.from, block.to - 200)) naiveWrong += 1;
    }
    expect(naiveWrong).toBeGreaterThan(5);
  });

  it(`are given to the visible lines and ${CODE_COLOURS_MARGIN} either side, and the window moves when the visible lines come within 50 of its edge`, () => {
    const text = 'const a = "b"; // c\n'.repeat(5000);
    let state = open(['javascript', text]);
    const line = (at: number) => linesAfter(text, 0, at);
    const window = () => [blocks(state)[0]!.from, blocks(state)[0]!.to];
    // Opened: the first 200 lines, as if the top were seen.
    expect(window()).toEqual([0, line(200)]);
    const first = blocks(state)[0];
    state = see(state, 0, 0);
    state = see(state, 0, 100);
    expect(blocks(state)[0]).toBe(first);
    // Lines 120 to 160 seen: 160 is within 50 of 200.
    state = see(state, 0, 120);
    expect(window()).toEqual([line(20), line(260)]);
    state = see(state, 0, 3000);
    expect(window()).toEqual([line(2900), line(3140)]);
    // Coloured there, and nowhere else.
    const shown = painted(state, 0);
    expect(shown.slice(line(2900), line(3140)).filter(Boolean).length).toBeGreaterThan(1000);
    expect(shown.slice(0, line(2900)).filter(Boolean)).toHaveLength(0);
    expect(shown.slice(line(3140)).filter(Boolean)).toHaveLength(0);
    // Back up within 50 lines of the top edge.
    state = see(state, 0, 2920);
    expect(window()).toEqual([line(2820), line(3060)]);
  });

  it('are coloured again only in the block a key is typed in', () => {
    const a = 'const a1 = "a1";\n'.repeat(150);
    const b = 'const b2 = "b2";\n'.repeat(150);
    const c = 'const c3 = "c3";\n'.repeat(150);
    let state = settled(open(['javascript', a], ['javascript', b], ['javascript', c]));
    const given = watchColourings();
    for (const key of 'xyz') state = typed(state, 1, 170, key);
    expect(given.length).toBeGreaterThan(0);
    for (const text of given) {
      expect(text).toContain('b2');
      expect(text).not.toMatch(/a1|c3/);
    }
    expect(painted(state, 1)).toEqual(oracle('javascript', blocks(state)[1]!.text));
    expect(painted(state, 0)).toEqual(oracle('javascript', a));
    expect(painted(state, 2)).toEqual(oracle('javascript', c));
  });

  it('are not coloured again in the window for a change from another client outside it', () => {
    const text = code(400_000);
    let state = see(settled(open(['javascript', text])), 0, 3000);
    const before = blocks(state)[0]!;
    const given = watchColourings();
    // After the window: only the code from the point before the edit to the point after it.
    const late = linesAfter(text, 0, 6000) + 3;
    state = remote(state, 0, `${text.slice(0, late)}xx${text.slice(late)}`);
    expect(given).toHaveLength(1);
    expect(given[0]!.length).toBeLessThan(20_000);
    expect(blocks(state)[0]!.spans).toBe(before.spans);
    // Before the window, the grammar back in its top mode before it: the same colours, moved.
    given.length = 0;
    const early = linesAfter(text, 0, 100) + 3;
    state = remote(
      state,
      0,
      `${blocks(state)[0]!.text.slice(0, early)}yyy${blocks(state)[0]!.text.slice(early)}`,
    );
    expect(given).toHaveLength(1);
    expect(given[0]!.length).toBeLessThan(20_000);
    const now = blocks(state)[0]!;
    expect(now.from).toBe(before.from + 3);
    expect(wrong(painted(state, 0), oracle('javascript', now.text), now.from, now.to - 200)).toBe(0);
  });

  it('are shown at once where the points have not reached, and settle to exact when they do', () => {
    // Plain lines first, with a stray end of comment on line 200, which a
    // comment opened at the top runs to.
    const plain = 'let y = 1; // w\n'.repeat(200);
    const text = `${plain}*/\n${plain}${code(400_000)}`;
    const whole = oracle('javascript', text);
    let state = see(open(['javascript', text]), 0, 7000);
    let block = blocks(state)[0]!;
    expect(block.exact).toBe(false);
    expect(painted(state, 0).slice(block.from, block.to).filter(Boolean).length).toBeGreaterThan(1000);
    state = settled(state);
    block = blocks(state)[0]!;
    expect(block.exact).toBe(true);
    expect(wrong(painted(state, 0), whole, block.from, block.to - 200)).toBe(0);
    // A comment opened at the top by another client, running 200 lines: the
    // points after the edit are dropped, so provisional again, then exact.
    const opened = `/*${text}`;
    state = remote(state, 0, opened);
    expect(blocks(state)[0]!.exact).toBe(false);
    state = settled(state);
    block = blocks(state)[0]!;
    expect(block.exact).toBe(true);
    expect(wrong(painted(state, 0), oracle('javascript', opened), block.from, block.to - 200)).toBe(0);
  });

  // The review of pull request 40: a local key above the window that changes
  // the grammar's state there left the window's old colours, marked exact.
  it('are coloured again in the window for a key above it that changes what follows', () => {
    const text = `${'const a = 1; // x\n'.repeat(150)}*/\n${'const b = 2; // y\n'.repeat(400)}`;
    let state = see(settled(open(['javascript', text])), 0, 200);
    expect(blocks(state)[0]!.from).toBeGreaterThan(0);
    state = typed(state, 0, 0, '/*');
    const exactly = (at: EditorState) => {
      const block = blocks(at)[0]!;
      if (block.exact)
        expect(wrong(painted(at, 0), oracle('javascript', block.text), block.from, block.to - 200)).toBe(0);
    };
    exactly(state);
    state = settled(state);
    expect(blocks(state)[0]!.exact).toBe(true);
    exactly(state);
    expect(painted(state, 0)[blocks(state)[0]!.from + 5]).toBe('hljs-comment');
  });

  // The review of pull request 40: the window was bounded in lines and not
  // characters, a window was coloured from its restart point however far
  // back, an edit coloured the whole stretch between its points, and an idle
  // step could be the whole block.
  it('do not colour all of a long paste from another client at once, above the window or in it', () => {
    const text = code(400_000);
    let state = see(settled(open(['javascript', text])), 0, 3000);
    const given = watchColourings();
    const above = linesAfter(text, 0, 100);
    state = remote(state, 0, text.slice(0, above) + code(200_000) + text.slice(above));
    const now = blocks(state)[0]!;
    const inside = Math.floor((now.from + now.to) / 2);
    state = remote(state, 0, now.text.slice(0, inside) + code(200_000) + now.text.slice(inside));
    expect(given.length).toBeGreaterThan(0);
    expect(Math.max(...given.map((each) => each.length))).toBeLessThanOrEqual(CODE_COLOURS_FROM_POINT_MOST);
  });

  it('never colour more than a bounded number of characters at once, nor take long for a key, whatever the code', () => {
    const json = `[${Array.from({ length: 60_000 }, (_, at) => `{"a":${at},"b":"c${at}"}`).join(',')}]`;
    const hostile: [string, string, string][] = [
      ['one line of JSON, 1.3 MB', 'json', json],
      ['NDJSON lines of 400 characters', 'json', `${json.slice(1, 401)}\n`.repeat(2500)],
      // A comment of two lines across every 64th line, to defeat the doubled stride.
      [
        'comments across the strides',
        'javascript',
        Array.from({ length: 16_000 }, (_, at) =>
          at % 64 === 63 ? '/* a\n' : at % 64 === 0 && at ? 'b */ let x = 1;\n' : 'let y = "z"; // w\n',
        ).join(''),
      ],
      ['a comment that never closes', 'javascript', `/*\n${'let y = "z"; // w\n'.repeat(50_000)}`],
      [
        'HTML with an inline script of 500 KB',
        'xml',
        `<p>a</p>\n<script>\n${'let y = "z"; // w\n'.repeat(28_000)}</script>\n<p>b</p>\n`,
      ],
    ];
    for (const [name, language, text] of hostile) {
      const given = watchColourings();
      let t = performance.now();
      let state = open([language, text]);
      const opening = performance.now() - t;
      expect(Math.max(...given.map((each) => each.length)), `${name}: opening`).toBeLessThanOrEqual(
        CODE_COLOURS_FROM_POINT_MOST,
      );
      given.length = 0;
      collectAll(state);
      expect(Math.max(0, ...given.map((each) => each.length)), `${name}: an idle step`).toBeLessThanOrEqual(
        CODE_COLOURS_STEP_MOST,
      );
      state = meta(state, { settle: true });
      const lines = text.split('\n').length;
      state = see(state, 0, Math.floor(lines / 2));
      if (lines < 3) {
        const block = blocks(state)[0]!;
        state = meta(state, {
          visible: [{ pos: block.pos, from: text.length / 2, to: text.length / 2 + 200 }],
        });
      }
      const middle = Math.floor((blocks(state)[0]!.from + blocks(state)[0]!.to) / 2);
      const times: number[] = [];
      for (let key = 0; key < 10; key += 1) {
        given.length = 0;
        t = performance.now();
        state = typed(state, 0, middle + key, 'q');
        times.push(performance.now() - t);
        expect(Math.max(0, ...given.map((each) => each.length)), `${name}: a key`).toBeLessThanOrEqual(
          CODE_COLOURS_FROM_POINT_MOST,
        );
        // And the idle work after it, a step at a time.
        given.length = 0;
        collectAll(state);
        expect(
          Math.max(0, ...given.map((each) => each.length)),
          `${name}: idle after a key`,
        ).toBeLessThanOrEqual(CODE_COLOURS_STEP_MOST);
      }
      times.sort((a, b) => a - b);
      console.log(
        `${name}: open ${opening.toFixed(1)} ms, key median ${times[5]!.toFixed(1)} ms, worst ${times[9]!.toFixed(1)} ms`,
      );
      expect(times[5], name).toBeLessThan(60);
      expect(blocks(state)[0]!.to - blocks(state)[0]!.from).toBeLessThanOrEqual(CODE_COLOURS_WINDOW_MOST);
      vi.restoreAllMocks();
    }
  });

  it('cost a bounded time per key in a block of 200 KB and of 1 MB', () => {
    for (const size of [200_000, 1_000_000]) {
      const text = code(size);
      let t = performance.now();
      let state = open(['javascript', text]);
      const opening = performance.now() - t;
      t = performance.now();
      collectAll(state);
      const collecting = performance.now() - t;
      state = see(meta(state, { settle: true }), 0, Math.floor(text.split('\n').length / 2));
      const middle = blocks(state)[0]!.from + 5000;
      const times: number[] = [];
      for (let key = 0; key < 30; key += 1) {
        t = performance.now();
        state = typed(state, 0, middle + key, 'x');
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      console.log(
        `${size / 1000} KB: open ${opening.toFixed(1)} ms, points ${collecting.toFixed(0)} ms (idle), key median ${times[15]!.toFixed(2)} ms, worst ${times[29]!.toFixed(2)} ms`,
      );
      // Generous, for a loaded machine: the library coloured 1 MB in about 1.8 s at each key.
      expect(times[15]).toBeLessThan(50);
      expect(opening).toBeLessThan(200);
      expect(blocks(state)[0]!.exact).toBe(true);
    }
  });

  it('are given in full to ordinary small blocks, as before, and kept so while they are typed in', () => {
    const samples: [string, string][] = [
      ['javascript', SOURCE.split('\n').slice(0, 150).join('\n')],
      [
        'xml',
        '<html>\n<style>p { color: red; }</style>\n<script>let a = `b`;</script>\n<p class="c">d</p>\n</html>\n',
      ],
      ['python', 'def f(x):\n    """Doc."""\n    return x ** 2  # square\n'.repeat(20)],
      ['css', '@media (min-width: 1px) { a:hover { color: #fff; } }\n'.repeat(20)],
      ['markdown', '# Title\n\nSome *text* and `code`.\n\n```js\nlet a;\n```\n'.repeat(10)],
      ['diff', '--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n'.repeat(10)],
      ['sql', "SELECT a, b FROM c WHERE d = 'e';\n".repeat(20)],
      ['plaintext', 'Nothing to colour.\n'],
    ];
    let state = open(...samples);
    samples.forEach(([language, text], at) =>
      expect(painted(state, at), language).toEqual(oracle(language, text)),
    );
    // A line typed at the end of each.
    samples.forEach(([, text], at) => (state = typed(state, at, text.length, 'let more = 1; // end\n')));
    samples.forEach(([language], at) =>
      expect(painted(state, at), language).toEqual(oracle(language, blocks(state)[at]!.text)),
    );
  });
});

// D183 as D193 reduces it: a colouring of a code block that fails shows the block without syntax colours.
describe('a code block whose grammar throws', () => {
  /** The grammar's regular expressions (global and multiline) throw on code that holds THROWS, as a faulty grammar would: highlight.js catches it and says so in its result. */
  function faulty() {
    const exec = RegExp.prototype.exec;
    vi.spyOn(RegExp.prototype, 'exec').mockImplementation(function (this: RegExp, given: string) {
      if (this.global && this.multiline && typeof given === 'string' && given.includes('THROWS'))
        throw new Error('A fault put in by the test.');
      return exec.call(this, given);
    });
  }
  const failedMark = (state: EditorState, index: number) => {
    const block = blocks(state)[index]!;
    return codeColoursKey
      .getState(state)!
      .decorations.find(block.pos + 1, block.pos + 1 + block.text.length)
      .some((each) => (each.spec as { codeColoursFailed?: boolean }).codeColoursFailed);
  };

  it('is said in words of its own', () => {
    // Written out here, and not taken from the code under test. The owner's to approve (C1).
    expect(CODE_NOT_COLOURED).toBe(
      'Syntax colours are not shown in this code block. Colouring its code took too long or could not complete. Reopen the document to try again.',
    );
  });

  it('is shown without colours and marked for its header; the other blocks keep theirs, and it is not tried again as it is typed in', () => {
    faulty();
    const honest = 'const a = "b" + 1; // c\n'.repeat(50);
    let state: EditorState | undefined;
    expect(
      () => (state = open(['javascript', honest], ['javascript', 'function f() { return "THROWS"; }\n'])),
    ).not.toThrow();
    expect(blocks(state!)[1]!.failed).toBe(true);
    expect(failedMark(state!, 1)).toBe(true);
    expect(painted(state!, 1).filter(Boolean)).toHaveLength(0);
    expect(failedMark(state!, 0)).toBe(false);
    expect(painted(state!, 0)).toEqual(oracle('javascript', honest));
    const given = watchColourings();
    state = typed(state!, 1, 3, 'x');
    expect(given).toHaveLength(0);
    expect(failedMark(state, 1)).toBe(true);
  });

  it('far below the window is found by the idle work, and the block then falls back', () => {
    faulty();
    const text = `${'const a = 1;\n'.repeat(3000)}"THROWS"\n`;
    let state = open(['javascript', text]);
    expect(blocks(state)[0]!.failed).toBe(false);
    expect(painted(state, 0).filter(Boolean).length).toBeGreaterThan(100);
    state = settled(state);
    expect(blocks(state)[0]!.failed).toBe(true);
    expect(failedMark(state, 0)).toBe(true);
    expect(painted(state, 0).filter(Boolean)).toHaveLength(0);
  });

  // The review of pull request 40: blocks paired by their order took the mark
  // of a failing block to the block that took its place.
  it('keeps its mark when the blocks are put in another order, and gives it to no other block', () => {
    faulty();
    const honest = 'const a = "b" + 1; // c\n'.repeat(50);
    const thrown = 'function f() { return "THROWS"; }\n';
    let state = open(['javascript', honest], ['javascript', thrown]);
    state = state.apply(
      state.tr.replaceWith(0, state.doc.content.size, [
        blockNode('javascript', thrown),
        blockNode('javascript', honest),
      ]),
    );
    expect(blocks(state).map((block) => block.failed)).toEqual([true, false]);
    expect(failedMark(state, 1)).toBe(false);
    expect(painted(state, 1)).toEqual(oracle('javascript', honest));
  });

  // D183 as D193 keeps it, and the review of pull request 40: a grammar slow
  // on what it is given would cost its time at every key.
  it(`or takes longer than ${CODE_COLOURS_LONGEST} ms is shown without colours and marked, and not tried again`, () => {
    // A clock the test holds: code that holds SLOW takes 300 ms on it.
    let time = 0;
    vi.spyOn(clock, 'now').mockImplementation(() => time);
    const highlight = codeHighlighter.highlight.bind(codeHighlighter);
    let slow = 0;
    vi.spyOn(codeHighlighter, 'highlight').mockImplementation(((text: string, options: never) => {
      if (text.includes('SLOW')) {
        time += CODE_COLOURS_LONGEST + 100;
        slow += 1;
      }
      return highlight(text, options);
    }) as never);
    const honest = 'const a = "b" + 1; // c\n'.repeat(50);
    let state = open(['javascript', honest], ['javascript', 'let s = "SLOW";\n']);
    expect(blocks(state).map((block) => block.failed)).toEqual([false, true]);
    expect(failedMark(state, 1)).toBe(true);
    expect(painted(state, 0)).toEqual(oracle('javascript', honest));
    expect(slow).toBe(1);
    state = typed(state, 1, 3, 'x');
    state = typed(state, 0, 3, 'y');
    expect(slow).toBe(1);
    expect(failedMark(state, 1)).toBe(true);
  });
});

describe('the editor’s own code block', () => {
  it('colours with the plugin near the view, and no longer with the library’s plugin', () => {
    const block = all.find((each) => each.name === 'codeBlock')!;
    const add = getExtensionField<() => Plugin[]>(block, 'addProseMirrorPlugins', {
      name: block.name,
      options: block.options,
      storage: {},
      editor: {} as never,
      type: schema.nodes.codeBlock!,
    });
    const keys = add().map((each) => (each as unknown as { key: string }).key);
    expect(keys.some((key) => key.startsWith('codeColours$'))).toBe(true);
    expect(keys.some((key) => key.startsWith('lowlight$'))).toBe(false);
  });
});
