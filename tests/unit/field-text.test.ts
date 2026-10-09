// The one rule of a name (FR-AU-90) and the one spelling and rule of an email
// address (FR-AU-02, FR-AU-03, FR-AU-89), as the owner decided them on
// 9 October 2026. Every character that matters is written by its code point,
// so that no editor and no formatter can change what is tested.
import { describe, expect, it } from 'vitest';
import { acceptedAddress, acceptedName, addressSpelling, enteredAddress } from '../../src/lib/field-text.ts';

const ZWNJ = '\u{200c}';
const ZWJ = '\u{200d}';
/** Text from code points written in hexadecimal, with spaces between. */
const of = (points: string) =>
  String.fromCodePoint(...points.split(' ').map((point) => Number.parseInt(point, 16)));

describe('the spelling of an email address (FR-AU-02)', () => {
  // The capital sigma lowers to its final form at the end of a word and to the other elsewhere.
  it('writes the three spellings of a Greek address that ends its local part in sigma as one', () => {
    const upper = `${of('39f 394 39f 3a3')}@example.gr`;
    const finalSigma = `${of('3bf 3b4 3bf 3c2')}@example.gr`;
    const sigma = `${of('3bf 3b4 3bf 3c3')}@example.gr`;
    expect(upper.toLowerCase()).toBe(finalSigma);
    for (const address of [upper, finalSigma, sigma]) {
      expect(addressSpelling(address)).toBe(sigma);
      expect(acceptedAddress(address)).toBe(sigma);
      expect(enteredAddress(address)).toBe(sigma);
    }
    // In the domain too, and in the middle of a word as at its end.
    expect(addressSpelling(`a@${of('3a3 39f 3a3')}.${of('3a3 3a3')}.gr`)).toBe(
      `a@${of('3c3 3bf 3c3')}.${of('3c3 3c3')}.gr`,
    );
  });

  it('writes the composed and the decomposed spelling of a letter as one, the composed', () => {
    const composed = 'andr\u{e9}@example.com';
    const decomposed = 'andre\u{301}@example.com';
    expect(decomposed).not.toBe(composed);
    for (const address of [composed, decomposed, 'ANDRE\u{301}@Example.COM', 'ANDR\u{c9}@example.com']) {
      expect(addressSpelling(address)).toBe(composed);
      expect(acceptedAddress(address)).toBe(composed);
    }
    // Greek with tonos, typed as a base and a mark.
    expect(addressSpelling('\u{3b1}\u{301}@example.gr')).toBe('\u{3ac}@example.gr');
  });

  it('is its own spelling: a spelling that is spelt again does not change', () => {
    for (const address of [
      'Plain.Address+tag@Example.com',
      `${of('39f 394 39f 3a3')}@example.gr`,
      'ANDRE\u{301}@example.com',
      // J with caron has a composed form in lower case alone.
      'J\u{30c}@example.com',
      // The dotted capital I lowers to i and a mark.
      '\u{130}stanbul@example.com',
    ]) {
      const once = addressSpelling(address);
      expect(addressSpelling(once), address).toBe(once);
      expect(once.normalize('NFC')).toBe(once);
    }
    expect(addressSpelling('J\u{30c}@example.com')).toBe('\u{1f0}@example.com');
  });

  it('leaves an ordinary address as its lower case, and maps no domain', () => {
    expect(addressSpelling('Ada.Lovelace@Example.COM')).toBe('ada.lovelace@example.com');
    // A domain in full-width letters is not made the plain one: the rule refuses it.
    expect(addressSpelling('ada@\u{ff45}xample.com')).toBe('ada@\u{ff45}xample.com');
    expect(acceptedAddress('ada@\u{ff45}xample.com')).toBeNull();
  });

  it('bounds what was entered where an address is looked up, a long decomposed address included', () => {
    expect(enteredAddress('x'.repeat(5000))).toHaveLength(255);
    // 133 characters once composed, more than 255 as typed.
    const typed = `${'e\u{301}'.repeat(121)}@example.com`;
    expect(typed.length).toBeGreaterThan(250);
    expect(enteredAddress(typed)).toBe(`${'\u{e9}'.repeat(121)}@example.com`);
    expect(enteredAddress(typed)).toBe(acceptedAddress(typed));
    // The longest address there is, typed in the decomposed form.
    const longest = `${'e\u{301}'.repeat(242)}@example.com`;
    expect(acceptedAddress(longest)).toHaveLength(254);
    expect(enteredAddress(longest)).toBe(acceptedAddress(longest));
  });
});

describe('the rule of an email address (FR-AU-03, FR-AU-89)', () => {
  it.each([
    ['plus-addressing', 'ada+ekdotico@example.com'],
    ['dots', 'ada.b.lovelace@example.com'],
    ['hyphens', 'ada-lovelace@my-university.example'],
    ['digits', 'ada1815@example2.com'],
    ['subdomains', 'ada@mail.dept.example.ac.uk'],
    ['an underscore and an apostrophe', "o'brien_ada@example.com"],
    ['letters that are not ASCII', 'm\u{fc}ller@b\u{fc}cher.example'],
    ['Greek letters', `${of('3b1 3bd 3bd 3b1')}@${of('3c0 3b1 3c1 3ac 3b4 3b5 3b9 3b3 3bc 3b1')}.gr`],
    ['the other characters of a local part', 'a!#$%&*/=?^`{|}~b@example.com'],
  ])('accepts an address with %s', (_what, address) => {
    expect(acceptedAddress(address)).toBe(address);
  });

  // The characters with which a header writes a list, a group, a comment, a
  // route, a quoted name, or a literal host.
  const REFUSED = ['<', '>', '(', ')', ',', ';', ':', '"', '[', ']', '\\'];
  it.each(REFUSED)('refuses an address with %s in either part', (character) => {
    expect(acceptedAddress(`ada${character}b@example.com`), 'local part').toBeNull();
    expect(acceptedAddress(`ada@exam${character}ple.com`), 'domain').toBeNull();
    expect(acceptedAddress(`ada@example.co${character}m`), 'last label').toBeNull();
    expect(acceptedAddress(`${character}ada@example.com`), 'first').toBeNull();
    expect(acceptedAddress(`ada@example.com${character}`), 'last').toBeNull();
  });

  it('refuses the forms of a header that carry a second address', () => {
    for (const address of [
      'x<attacker@evil.example>',
      'a@b.example,c',
      '"a"@b.example',
      'a@b.example;c@d.example',
      'group:a@b.example',
      'a@[127.0.0.1]',
      'a(comment)@b.example',
      `a${REFUSED.at(-1)}@b.example`,
    ]) {
      expect(acceptedAddress(address), address).toBeNull();
    }
  });

  it('still refuses what it refused: no address, a space, a control character, more than 254 characters', () => {
    const [nul, feed, del, nextLine] = [of('0'), of('a'), of('7f'), of('85')];
    for (const address of [
      '',
      'no-at.example.com',
      'two@@example.com',
      'a b@example.com',
      `a${nul}@example.com`,
      `a${feed}@example.com`,
      `a@exa${del}mple.com`,
      `a${nextLine}@example.com`,
    ]) {
      expect(acceptedAddress(address), address).toBeNull();
    }
    expect(acceptedAddress(7)).toBeNull();
    expect(acceptedAddress(`${'a'.repeat(242)}@example.com`)).toHaveLength(254);
    expect(acceptedAddress(`${'a'.repeat(243)}@example.com`)).toBeNull();
  });
});

// The owner's decision of 9 October 2026: "refuse any address whose domain is
// not plain lower-case ASCII, or a Unicode label that survives normalisation
// unchanged. The address is refused, not mapped."
describe('the domain of an email address (FR-AU-02, FR-AU-03, FR-AU-89)', () => {
  const GREEK = `${of('3c0 3b1 3c1 3ac 3b4 3b5 3b9 3b3 3bc 3b1')}.${of('3b5 3bb')}`;
  it.each([
    ['an ordinary domain', 'example.com'],
    ['subdomains', 'mail.dept.example.ac.uk'],
    ['hyphens inside a label', 'my-university.ex-ample.org'],
    ['digits, first and last in a label too', '1example2.3com'],
    ['a label of one character', 'a.b.io'],
    ['a label of 63 characters', `${'a'.repeat(63)}.com`],
    ['a Greek domain in lower case', GREEK],
    ['a Greek label that ends in sigma', `${of('3bf 3b4 3bf 3c3')}.gr`],
    ['letters with marks, composed', 'b\u{fc}cher.example'],
    ['a letter with a mark that has no composed form', 'x\u{301}y.example'],
    ['Chinese', `${of('4f8b 5b50')}.${of('4e2d 56fd')}`],
    ['a punycode domain, as it was typed', 'xn--bcher-kva.example'],
    ['a punycode last label', 'example.xn--qxam'],
  ])('accepts %s', (_what, domain) => {
    expect(acceptedAddress(`ada@${domain}`)).toBe(`ada@${domain}`);
  });

  it('accepts a domain typed in capitals as its lower case, which is one address (FR-AU-02)', () => {
    expect(acceptedAddress('Ada@Example.COM')).toBe('ada@example.com');
    expect(acceptedAddress('ada@XN--BCHER-KVA.example')).toBe('ada@xn--bcher-kva.example');
    expect(acceptedAddress(`ada@${GREEK.toUpperCase()}`)).toBe(`ada@${GREEK}`);
  });

  it('does not make a punycode label and its Unicode form one address', () => {
    expect(acceptedAddress('ada@xn--bcher-kva.example')).not.toBe(acceptedAddress('ada@b\u{fc}cher.example'));
  });

  // Each of these is changed by the compatibility normalisation (NFKC).
  it.each([
    ['a full-width letter', '\u{ff45}xample.com'],
    ['a full-width letter in the last label', 'example.c\u{ff4f}m'],
    ['a full-width capital', '\u{ff25}xample.com'],
    ['a full-width digit', 'example\u{ff11}.com'],
    ['a superscript digit', 'example\u{b2}.com'],
    ['a ligature', 'of\u{fb01}ce.example'],
    ['a circled letter', '\u{24d0}xample.com'],
    ['a capital that has no lower case of its own: the upsilon with a hook', `${of('3d2')}.gr`],
    ['a capital that has no lower case of its own: a mathematical bold A', `${of('1d400')}.example`],
    ['a letter that is its capital and the next letter in one', `${of('1c5')}emal.example`],
    ['the micro sign, which is not the Greek letter', '\u{b5}.example'],
    ['a half-width katakana letter', `${of('ff76')}.example`],
  ])('refuses a domain with %s', (_what, domain) => {
    expect(domain.normalize('NFKC')).not.toBe(domain);
    expect(acceptedAddress(`ada@${domain}`)).toBeNull();
    // Refused, and the plain domain it would be mapped to is not put in its place.
    expect(acceptedAddress(`ada@sub.${domain}`)).toBeNull();
  });

  // The shape of a label. None of these is changed by NFKC or by lower case.
  it.each([
    ['an empty label', 'example..com'],
    ['an empty first label', '.example.com'],
    ['an empty last label', 'example.com.'],
    ['a label that starts with a hyphen', '-example.com'],
    ['a label that ends with a hyphen', 'example-.com'],
    ['a last label that starts with a hyphen', 'example.-com'],
    ['a Greek label that ends with a hyphen', `${of('3c0 3b1')}-.gr`],
    ['a label of 64 characters', `${'a'.repeat(64)}.com`],
    ['a Greek label of 64 characters', `${of('3b1').repeat(64)}.gr`],
    ['an underscore', 'ex_ample.com'],
    ['a symbol', 'ex\u{2665}ample.com'],
    ['an emoji', `${of('1f600')}.example`],
    ['a punctuation mark', 'ex!ample.com'],
    ['a zero-width joiner', `exam${ZWJ}ple.com`],
    ['a soft hyphen', 'exam\u{ad}ple.com'],
    ['an ideographic full stop between labels', `example${of('3002')}com.example`],
  ])('refuses a domain with %s', (_what, domain) => {
    expect(domain.normalize('NFKC').toLowerCase(), 'not for its form').toBe(domain);
    expect(acceptedAddress(`ada@${domain}`)).toBeNull();
  });

  it('refuses a domain of 254 characters, and one too long for an address of 254', () => {
    const label = 'a'.repeat(62);
    // Four labels of 62 and their dots, and a last label: 254 in all.
    const domain = `${`${label}.`.repeat(4)}${'b'.repeat(2)}`;
    expect(domain).toHaveLength(254);
    expect(acceptedAddress(`a@${domain}`)).toBeNull();
    // The longest that fits beside a local part of one character: 252.
    const longest = domain.slice(2);
    expect(acceptedAddress(`a@${longest}`)).toBe(`a@${longest}`);
    expect(acceptedAddress(`a@${longest}`)).toHaveLength(254);
  });

  it('judges the local part as before: it is not held to the rule of a domain', () => {
    for (const address of ['a_b@example.com', '-ada-@example.com', `${'a'.repeat(64)}@example.com`]) {
      expect(acceptedAddress(address)).toBe(address);
    }
  });
});

describe('the rule of a name (FR-AU-90)', () => {
  it.each([
    ['Latin', 'Ada Lovelace'],
    ['an apostrophe', "O'Brien"],
    ['a typographic apostrophe', 'O\u{2019}Brien'],
    ['a hyphen', 'Jean-Luc'],
    [
      'Greek with tonos',
      `${of('39c 3b1 3c1 3af 3b1')} ${of('3a0 3b1 3c0 3b1 3b4 3bf 3c0 3bf 3cd 3bb 3bf 3c5')}`,
    ],
    ['Greek with tonos as a mark', of('39c 3b1 3c1 3b9 301 3b1')],
    ['Arabic', `${of('645 62d 645 62f')} ${of('639 644 64a')}`],
    ['Persian with a zero-width non-joiner', `${of('645 6cc')}${ZWNJ}${of('62e 648 627 647 645')}`],
    [
      'Devanagari with a zero-width joiner',
      `${of('915 94d')}${ZWJ}${of('937')} ${of('936 930 94d 92e 93e')}`,
    ],
    ['Chinese', of('738b 5c0f 660e')],
    ['Japanese', `${of('5c71 7530')} ${of('592a 90ce')}`],
    ['Korean', of('ae40 bbfc c900')],
    ['Hebrew', `${of('5d3 5d5 5d3')} ${of('5db 5d4 5df')}`],
    ['Thai, with marks above', of('e2a e21 e0a e32 e22')],
    ['an emoji of several joined beside letters', `Ada ${of('1f469')}${ZWJ}${of('1f4bb')}`],
    ['an emoji with a variation selector', `Ada ${of('2764 fe0f')}`],
    ['one letter', 'A'],
    ['one emoji', of('1f600')],
    ['a no-break space inside', `Ada${of('a0')}Lovelace`],
    ['markup, which is text', '<b>Ada</b>'],
  ])('accepts a name in %s', (_what, name) => {
    expect(acceptedName(name)).toBe(name);
  });

  it('takes the white space from the two ends, and nothing between', () => {
    expect(acceptedName(`  Ada  Lovelace ${of('a')}`)).toBe('Ada  Lovelace');
    expect(acceptedName(`${of('2028')}Ada${of('2029')}`)).toBe('Ada');
  });

  it.each([
    ['NUL', '0'],
    ['a tab', '9'],
    ['a line feed', 'a'],
    ['the last of C0', '1f'],
    ['DEL', '7f'],
    ['the first of C1', '80'],
    ['the next line, of C1', '85'],
    ['the last of C1', '9f'],
  ])('refuses a name that holds a control character: %s', (_what, point) => {
    expect(acceptedName(`Ada${of(point)}Lovelace`)).toBeNull();
  });

  it.each([
    ['the left-to-right mark', '200e'],
    ['the right-to-left mark', '200f'],
    ['the Arabic letter mark', '61c'],
    ['an embedding, left to right', '202a'],
    ['an embedding, right to left', '202b'],
    ['the pop of a direction', '202c'],
    ['an override, left to right', '202d'],
    ['an override, right to left', '202e'],
    ['an isolate, left to right', '2066'],
    ['an isolate, right to left', '2067'],
    ['the first strong isolate', '2068'],
    ['the pop of an isolate', '2069'],
  ])('refuses a name that holds a direction control: %s', (_what, point) => {
    expect(acceptedName(`Ada${of(point)}Lovelace`)).toBeNull();
    expect(acceptedName(`${of(point)}evil`)).toBeNull();
    expect(acceptedName(`live${of(point)}`)).toBeNull();
  });

  it.each([
    ['the line separator', '2028'],
    ['the paragraph separator', '2029'],
  ])('refuses a name that holds %s between its ends', (_what, point) => {
    expect(acceptedName(`a${of(point)}b`)).toBeNull();
  });

  it.each([
    ['a zero-width space', '200b'],
    ['a zero-width joiner', '200d'],
    ['a zero-width non-joiner', '200c'],
    ['a word joiner', '2060'],
    ['a soft hyphen', 'ad'],
    ['joiners around an ideographic space', '200d 3000 200c'],
    ['a combining mark on nothing', '301'],
    ['an enclosing mark on nothing', '20dd'],
    ['a variation selector', 'fe0f'],
    ['the blank Braille pattern', '2800'],
    ['the Hangul filler', '3164'],
    ['the Hangul choseong filler', '115f'],
    ['the Hangul jungseong filler', '1160'],
    ['the half-width Hangul filler', 'ffa0'],
    ['blank letters and joiners together', '2800 200d 3164 200b ffa0'],
    ['spaces alone', '20 20'],
  ])('refuses a name with no character to see: %s', (_what, points) => {
    expect(acceptedName(of(points))).toBeNull();
  });

  it('refuses no name at all, and counts a character as one code point, 1 to 100 of them', () => {
    expect(acceptedName('')).toBeNull();
    expect(acceptedName(7)).toBeNull();
    expect(acceptedName(of('1f600').repeat(100))).toHaveLength(200);
    expect(acceptedName(of('1f600').repeat(101))).toBeNull();
    expect(acceptedName('x'.repeat(101))).toBeNull();
  });
});
