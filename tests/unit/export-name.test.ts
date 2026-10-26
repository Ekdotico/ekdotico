// The name of a draft export and the header that carries it (FR-EX-36; docs/plan/slice-21.md, section 5).
// "A title could carry a path into the archive or into the download header": every test here is a way that
// would happen, and each fails when its clause of the rule is taken out.
import { describe, expect, it } from 'vitest';
import { FALLBACK_NAME, contentDisposition, exportName } from '../../src/lib/export/name.ts';

const MAX = 100;
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
    expect(name('C:\\Windows\\x')).toBe('C:Windowsx');
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
