// Q49 (1): the pseudonym that stands for a hidden title, "Flying Hippos — {display
// name}", made with the platform's cryptographic random source from short lists
// of neutral words.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  newPseudonym,
  newPseudonymAvoiding,
  PSEUDONYM_ADJECTIVES,
  PSEUDONYM_ANIMALS,
} from '../../src/lib/documents/pseudonym.ts';

const source = readFileSync('src/lib/documents/pseudonym.ts', 'utf8')
  .replaceAll(/\/\*[\s\S]*?\*\//g, '')
  .replaceAll(/(^|[^:])\/\/.*$/gm, '$1');

describe('the words', () => {
  it('are two lists of single capitalised words, each with no repeat', () => {
    for (const list of [PSEUDONYM_ADJECTIVES, PSEUDONYM_ANIMALS]) {
      expect(list.length).toBeGreaterThanOrEqual(32);
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});

describe('a pseudonym', () => {
  it('is an adjective, an animal, a dash and the display name of the sender', () => {
    expect(newPseudonym('Ada Owner', () => 0)).toBe(
      `${PSEUDONYM_ADJECTIVES[0]} ${PSEUDONYM_ANIMALS[0]} — Ada Owner`,
    );
    expect(newPseudonym('Ada Owner', (n) => n - 1)).toBe(
      `${PSEUDONYM_ADJECTIVES.at(-1)} ${PSEUDONYM_ANIMALS.at(-1)} — Ada Owner`,
    );
    expect(newPseudonym('Ada Owner', () => 3)).toBe(
      `${PSEUDONYM_ADJECTIVES[3]} ${PSEUDONYM_ANIMALS[3]} — Ada Owner`,
    );
  });

  it('asks for a choice among each list and no more, one for the adjective and one for the animal', () => {
    const asked: number[] = [];
    newPseudonym('Ada Owner', (n) => {
      asked.push(n);
      return 0;
    });
    expect(asked).toEqual([PSEUDONYM_ADJECTIVES.length, PSEUDONYM_ANIMALS.length]);
  });

  it('is drawn again where the words are in use, and kept after the draws are used up (weakening: no draw again)', () => {
    const first = newPseudonym('X', () => 0);
    const second = newPseudonym('X', () => 1);
    const draws = [0, 0, 0, 0, 1, 1]; // the first pair twice, then the second pair
    let at = 0;
    const pick = () => draws[at++]!;
    expect(newPseudonymAvoiding('X', new Set([first]), pick)).toBe(second);
    expect(at).toBe(6);
    // Nothing is in use: the first draw stands.
    expect(newPseudonymAvoiding('X', new Set(), () => 0)).toBe(first);
    // Everything is in use: one is kept, after a bounded number of draws.
    let drawn = 0;
    expect(
      newPseudonymAvoiding('X', new Set([first]), () => {
        drawn += 1;
        return 0;
      }),
    ).toBe(first);
    expect(drawn).toBe(64);
  });

  it('can be any pair of the lists, with the platform’s own source', () => {
    const seen = new Set<string>();
    for (let n = 0; n < 4000; n += 1) seen.add(newPseudonym('X'));
    // 1024 pairs, 4000 draws: a source that favoured a few words would show here.
    expect(seen.size).toBeGreaterThan(900);
    for (const made of seen) expect(made).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ — X$/);
  });

  it('is made with the cryptographic random source and never Math.random (weakening: Math.random)', () => {
    expect(source).toMatch(/import \{ randomInt \} from 'node:crypto';/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).toMatch(/pick: \(n: number\) => number = randomInt/);
  });
});
