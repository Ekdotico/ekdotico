// The reference document of NFR-IC-14 for the two editor rows of NFR-PE-01 (procedure 1): 5,000 words of body
// text in headings and paragraphs, with no citation, no LaTeX block and no Mermaid block (the build-phases page
// narrows "up to 50 citations, 5 LaTeX blocks and 3 Mermaid blocks" to none for these rows). Made the same way
// every time from a fixed seed, so that two runs of the procedure measure one document.
//
//   node tests/fixtures/reference-document.ts      writes tests/fixtures/reference-document.json
//
// A word is a run of characters between spaces in a text node; headings count. The committed file is the
// fixture; tests/unit/reference-document.test.ts holds it to this generator and to the editor's schema.
import { writeFileSync } from 'node:fs';

export const WORDS = 5000;
/** The second run of procedure 1 (NFR-IC-14, register D296): the same document, made longer. */
export const WORDS_LARGE = 50000;

type Node = { type: string; attrs?: Record<string, unknown>; content?: Node[]; text?: string };
export type ReferenceDocument = { type: 'doc'; content: Node[] };

const VOCABULARY = (
  'archive argument author balance bibliography chapter claim classical commentary concept context contrast ' +
  'critical culture debate decade definition detail discipline discourse edition editor element empirical ' +
  'essay evidence example field figure finding footnote form framework genre history hypothesis idea image ' +
  'influence interpretation journal knowledge language layer lecture letter library manuscript margin meaning ' +
  'method model narrative note observation order paper passage pattern period philosophy practice premise ' +
  'principle problem process publication question reading record reference reform relation research response ' +
  'review revision scholar section sequence society source standard statement structure study survey tension ' +
  'term text theory thesis tradition translation treatise variant version volume witness writing year'
).split(' ');
const LINKS =
  'the of and to in that with for from by on as at is are was were which this these those its their'.split(
    ' ',
  );

function stream(seed: number) {
  let state = seed;
  const next = (below: number) => {
    // A linear congruential generator: the same numbers on every machine.
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
  const word = (at: number) =>
    at % 3 === 0 ? LINKS[next(LINKS.length)]! : VOCABULARY[next(VOCABULARY.length)]!;
  /** `count` words in sentences of 8 to 18, the first of each capitalised and the last ended by a full stop. */
  const prose = (count: number): string => {
    const out: string[] = [];
    let left = 0;
    for (let at = 0; at < count; at++) {
      if (left === 0) left = Math.min(8 + next(11), count - at);
      let w = word(at);
      if (out.length === 0 || /\.$/.test(out[out.length - 1]!)) w = w[0]!.toUpperCase() + w.slice(1);
      left--;
      out.push(left === 0 ? `${w}.` : w);
    }
    return out.join(' ');
  };
  return { next, prose };
}

export function referenceDocument(words = WORDS): ReferenceDocument {
  const { next, prose } = stream(20261026);
  const lengths: ['h1' | 'h2' | 'p', number][] = [['h1', 4]];
  let left = words - 4;
  while (left > 0) {
    const heading = Math.min(2 + next(3), left);
    lengths.push(['h2', heading]);
    left -= heading;
    for (let each = 2 + next(3); each > 0 && left > 0; each--) {
      const words = left < 160 ? left : Math.min(60 + next(60), left - 1);
      lengths.push(['p', words]);
      left -= words;
    }
  }
  const content: Node[] = lengths.map(([kind, words]) => {
    const text = prose(words);
    return kind === 'p'
      ? { type: 'paragraph', content: [{ type: 'text', text }] }
      : {
          type: 'heading',
          attrs: { level: kind === 'h1' ? 1 : 2 },
          content: [{ type: 'text', text: text.replace(/\.$/, '') }],
        };
  });
  return { type: 'doc', content };
}

/** The words of a document: the runs between spaces, in every text node. */
export function countWords(node: { text?: string; content?: unknown[] }): number {
  const own = node.text ? node.text.split(/\s+/).filter(Boolean).length : 0;
  return own + (node.content ?? []).reduce<number>((sum, child) => sum + countWords(child as never), 0);
}

if (import.meta.main) {
  const path = new URL('./reference-document.json', import.meta.url);
  writeFileSync(path, `${JSON.stringify(referenceDocument(), null, 1)}\n`);
  console.log(`${path.pathname}: ${countWords(referenceDocument())} words`);
}
