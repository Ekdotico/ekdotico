// The name of a draft export and the header that carries it (FR-EX-36; docs/plan/slice-21.md, section 5).
// "A title could carry a path into the archive or into the download header": every test here is a way that
// would happen, and each fails when its clause of the rule is taken out.
import { describe, expect, it } from 'vitest';
import { FALLBACK_NAME, STEM_MOST_BYTES, contentDisposition, exportName } from '../../src/lib/export/name.ts';
import { checkEntryName } from '../../src/lib/export/zip.ts';

const MAX = 100;
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const name = (title: string, max = MAX) => exportName(title, max);

describe('the name derived from a title', () => {
  it('is the title where nothing in it is removed', () => {
    expect(name('My thesis, chapter 1')).toBe('My thesis, chapter 1');
    expect(name('Εκδοτικό — 論文 — بحث — 📚')).toBe('Εκδοτικό — 論文 — بحث — 📚');
    expect(name("Writer's guide")).toBe("Writer's guide");
  });

  it('removes path separators', () => {
    expect(name('a/b')).toBe('ab');
    expect(name('a\\b')).toBe('ab');
    expect(name('/etc/passwd')).toBe('etcpasswd');
    expect(name('C:\\Windows\\x')).toBe('C_Windowsx');
  });

  it('removes a sequence of two full stops, however long, and leaves no sequence behind', () => {
    expect(name('a..b')).toBe('ab');
    expect(name('a...b')).toBe('ab');
    expect(name('..')).toBe(FALLBACK_NAME);
    expect(name('../../x')).toBe('x');
    // What is removed can join two full stops that stood apart: the sequences go last.
    expect(name('a./.b')).toBe('ab');
    expect(name('a.\u0000.b')).toBe('ab');
    expect(name('a."."b')).toBe('ab');
    expect(name('a.\u202E.b')).toBe('ab');
    // A single full stop stays.
    expect(name('v1.2 notes')).toBe('v1.2 notes');
  });

  it('removes control characters, and the controls of bidirectional text', () => {
    expect(name('a\u0000b\u0007c\u001fd\u007fe\u0085f\u009fg')).toBe('abcdefg');
    expect(name('a\nb\rc\td')).toBe('abcd');
    // `report` + RLO + `gpj.exe` would read as `reportexe.jpg`.
    expect(name('report\u202Egpj.exe')).toBe('reportgpj.exe');
    expect(name('x\u202A\u202B\u202C\u202D\u2066\u2067\u2068\u2069y')).toBe('xy');
  });

  it('removes quotation marks', () => {
    expect(name('say "hello"')).toBe('say hello');
    expect(name('\u201Cquoted\u201D \u201Ea\u201F')).toBe('quoted a');
  });

  it('cuts to 100 characters by code point, and splits no pair', () => {
    const long = 'x'.repeat(250);
    expect(Array.from(name(long))).toHaveLength(100);
    // 99 letters and an emoji of two units: the whole emoji is in, and the cut is at 100 characters and not 100 units.
    const emoji = `${'a'.repeat(99)}📚${'b'.repeat(20)}`;
    expect(name(emoji)).toBe(`${'a'.repeat(99)}📚`);
    expect(name(emoji).isWellFormed()).toBe(true);
    // The cut follows the removal, not the other way about: 100 characters are kept after the separators went.
    expect(Array.from(name(`/${'y'.repeat(150)}`))).toHaveLength(100);
    expect(name('abcdef', 3)).toBe('abc');
  });

  // The review of pull request 59: names the rule passed and the archive then refused, after a 200.
  it('is a name the archive takes, for every title the rule gave one it refused', () => {
    const titles = [
      'Q: notes',
      'X:',
      '研究'.repeat(60),
      '📚'.repeat(70),
      '研究'.repeat(30),
      'a'.repeat(300),
      'é'.repeat(200),
      'CON',
      'con.txt',
      'Aux. notes',
      'NUL',
      'lpt1',
      'COM9.md',
      'a:b*c?d<e>f|g',
    ];
    for (const title of titles) {
      for (const max of [100, 200]) {
        const stem = name(title, max);
        expect(() => checkEntryName(`${stem}.md`), `${title.slice(0, 12)} / ${max}`).not.toThrow();
        expect(Buffer.byteLength(stem), `${title.slice(0, 12)} / ${max}`).toBeLessThanOrEqual(
          STEM_MOST_BYTES,
        );
        expect(stem).not.toMatch(RESERVED);
      }
    }
  });

  it('writes what Windows does not keep as `_`, and puts `_` before a name it reserves', () => {
    expect(name('Q: notes')).toBe('Q_ notes');
    expect(name('a:b*c?d<e>f|g')).toBe('a_b_c_d_e_f_g');
    expect(name('CON')).toBe('_CON');
    expect(name('con.txt')).toBe('_con.txt');
    expect(name('Console')).toBe('Console');
    expect(name('LPT9')).toBe('_LPT9');
    expect(name('LPT10')).toBe('LPT10');
  });

  it('cuts to 250 bytes of UTF-8 as well as to the characters, on a code point', () => {
    // 3 bytes each: 83 of them are 249 bytes, and the 84th would be 252.
    expect(Array.from(name('研'.repeat(200), 200))).toHaveLength(83);
    // 4 bytes each: 62 are 248.
    expect(Array.from(name('📚'.repeat(200), 200))).toHaveLength(62);
    expect(name('📚'.repeat(200), 200).isWellFormed()).toBe(true);
    // Under the characters' own limit, that one governs.
    expect(Array.from(name('研'.repeat(200), 10))).toHaveLength(10);
  });

  it('is `document` where nothing is left, or only white space', () => {
    expect(name('')).toBe(FALLBACK_NAME);
    expect(name('"')).toBe(FALLBACK_NAME);
    expect(name('///')).toBe(FALLBACK_NAME);
    expect(name('   ')).toBe(FALLBACK_NAME);
    expect(name('\u0000\u0001')).toBe(FALLBACK_NAME);
    expect(name('.')).toBe(FALLBACK_NAME);
  });

  it('does not end in a full stop or white space, which the extension would join', () => {
    expect(`${name('report.')}.zip`).toBe('report.zip');
    expect(`${name('report. ')}.md`).toBe('report.md');
    expect(name('  indented')).toBe('indented');
    expect(name(`${'a'.repeat(99)} b`)).toBe('a'.repeat(99));
  });

  it('holds for any title: no separator, no pair of full stops, no control, no quotation mark, 100 at most, never empty', () => {
    // A fixed seed: the same titles on every run.
    let seed = 20261026;
    const next = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed;
    };
    const pieces = [
      '.',
      '..',
      '/',
      '\\',
      '"',
      '\u201C',
      "'",
      '\u0000',
      '\n',
      '\u202E',
      ' ',
      ';',
      '%',
      '*',
      ':',
      '📚',
      'é',
      '論',
      'a',
      'zip',
      '.zip',
      '../',
      '%2e%2e',
      '\u200B',
      '\uFEFF',
    ];
    for (let n = 0; n < 4000; n += 1) {
      const title = Array.from({ length: next() % 40 }, () => pieces[next() % pieces.length]).join('');
      const result = name(title);
      expect(result, JSON.stringify(title)).not.toMatch(/[/\\]/u);
      expect(result, JSON.stringify(title)).not.toContain('..');
      expect(`${result}.zip`, JSON.stringify(title)).not.toContain('..');
      expect(result, JSON.stringify(title)).not.toMatch(/[\p{Cc}\u202A-\u202E\u2066-\u2069"\u201C-\u201F]/u);
      expect(Array.from(result).length).toBeLessThanOrEqual(100);
      expect(result.length).toBeGreaterThan(0);
      // And the archive takes what the rule gave: a name it refuses after the response has begun cannot be a statement.
      expect(() => checkEntryName(`${result}.md`), JSON.stringify(title)).not.toThrow();
      expect(Buffer.byteLength(result)).toBeLessThanOrEqual(STEM_MOST_BYTES);
      expect(result).not.toMatch(/[:*?<>|]/u);
      expect(result).not.toMatch(RESERVED);
      expect(result.isWellFormed()).toBe(true);
    }
  });
});

describe('the Content-Disposition header (RFC 6266)', () => {
  const parts = (header: string) => {
    const match = /^attachment; filename="([^"]*)"; filename\*=UTF-8''([A-Za-z0-9!#$&+\-.^_`|~%]*)$/u.exec(
      header,
    );
    expect(match, header).not.toBeNull();
    return { ascii: match![1]!, encoded: match![2]! };
  };

  it('has an ASCII form and an encoded form of the same name', () => {
    const { ascii, encoded } = parts(contentDisposition('My thesis.zip'));
    expect(ascii).toBe('My thesis.zip');
    expect(decodeURIComponent(encoded)).toBe('My thesis.zip');
  });

  it('encodes what is not ASCII, and what RFC 5987 does not allow, and falls back to a plain form', () => {
    const header = contentDisposition("Εκδοτικό 論文 📚 (a) 'b' *c*.zip");
    const { ascii, encoded } = parts(header);
    expect(decodeURIComponent(encoded)).toBe("Εκδοτικό 論文 📚 (a) 'b' *c*.zip");
    expect(encoded).not.toMatch(/['()*]/u);
    expect(ascii).toMatch(/^[\x20-\x7e]*$/u);
    // One underscore for each character, an emoji included.
    expect(ascii).toBe("________ __ _ (a) 'b' *c*.zip");
  });

  it('cannot be ended, extended, or broken by what a name holds', () => {
    // These never come from `exportName`, which removed the first; the header holds without it.
    for (const hostile of [
      'a"; filename="b',
      'a\r\nSet-Cookie: x=1',
      'a\\"b',
      'a;b',
      'a%22b',
      'a\nb',
      '\u0000',
    ]) {
      const header = contentDisposition(hostile);
      expect(header, JSON.stringify(hostile)).not.toMatch(/[\r\n\u0000]/u);
      const { ascii, encoded } = parts(header);
      expect(ascii).not.toMatch(/["\\%]/u);
      expect(decodeURIComponent(encoded)).toBe(hostile);
      // `parts` matched the whole header: `attachment`, the quoted `filename` whose quote is the form's own
      // (the ASCII form holds none), and the encoded one.
      expect(ascii.includes('"')).toBe(false);
    }
  });

  it('survives a lone surrogate', () => {
    expect(() => contentDisposition('a\ud800b')).not.toThrow();
    expect(decodeURIComponent(parts(contentDisposition('a\ud800b.zip')).encoded)).toBe('a\ufffdb.zip');
  });
});
