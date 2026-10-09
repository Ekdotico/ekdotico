// The one rule of a short text a person types into a field: the name of an
// account (FR-AU-90) and the title of a document (FR-ED-35; the owner's
// decision of 8 October 2026, which amends NFR-SE-08 for it). And the one
// spelling and rule of an email address (FR-AU-02).

/**
 * What was typed without the white space at its two ends, and how many
 * characters that is, a character being one Unicode code point. Nothing
 * between the ends is touched.
 */
export function fieldText(value: string): { text: string; characters: number } {
  const text = value.trim();
  return { text, characters: [...text].length };
}

// Text for a person (the owner's answer to Q6 of the plan; revised with the
// rule on 9 October 2026, for the owner's approval).
export const NAME_REFUSAL =
  'A name has 1 to 100 characters, at least one of which can be seen, and holds no control character and no character that changes the direction of text. Enter a name of that kind.';

// The owner's decision of 9 October 2026 (its register row is pending), for a
// name alone; the title of a document keeps its own rule (documents.ts).
// Never in a name: a control character, C1 among them (PostgreSQL cannot
// store the first of them); a character that sets or overrides the direction
// of text, which would reorder what stands beside the name on a page (the
// Arabic letter mark, the two marks, the embeddings and overrides with their
// pop, the isolates with theirs); and the separators of lines and of
// paragraphs. Each is written by its code point: none can be seen here.
const NOT_IN_A_NAME = /[\p{Cc}\u{61c}\u{200e}\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}\u{2028}\u{2029}]/u;
// A name of these alone shows nothing: format characters, spaces, marks that
// stand on no letter, and the letters that are drawn blank (the blank Braille
// pattern and the four Hangul fillers). Inside a name that also has a
// character to see, a joiner stays: Persian, the Indic scripts and the
// sequences of emoji need them.
const NOTHING_TO_SEE = /^[\p{Cf}\p{Zs}\p{Zl}\p{Zp}\p{Mn}\p{Me}\u{2800}\u{3164}\u{115f}\u{1160}\u{ffa0}]*$/u;

/**
 * FR-AU-90: "a name, of 1 to 100 characters", as it is stored, or null where
 * what was given is none. The one rule of a name, at sign-up and at its change
 * in the account settings.
 */
export function acceptedName(value: unknown): string | null {
  const { text, characters } = fieldText(typeof value === 'string' ? value : '');
  if (characters < 1 || characters > 100) return null;
  return NOT_IN_A_NAME.test(text) || NOTHING_TO_SEE.test(text) ? null : text;
}

// The two lower-case forms of the Greek capital sigma: the final one, which
// ends a word, and the one that stands anywhere else.
const FINAL_SIGMA = /\u{3c2}/gu;
const SIGMA = String.fromCodePoint(0x3c3);

/**
 * The one spelling of an email address (FR-AU-02: "two addresses that differ
 * only by case are one address and cannot belong to two accounts"). It judges
 * nothing: `acceptedAddress` does. Every place that stores an address or
 * compares one goes through here, and through nothing else: the sign-in, the
 * request for a reset, the change of an address, an admission invitation, and
 * both sides of the comparison with the list of the founding team.
 *
 * The owner's decisions of 9 October 2026 (their register rows are pending):
 * - the composed form (NFC), so that a letter typed as one code point and the
 *   same letter typed as a base and a mark are one address;
 * - lower case;
 * - one sigma: the lower case of the Greek capital sigma is its final form at
 *   the end of a word and the other form elsewhere, so an address typed in
 *   capitals lowers to the final form while the same address typed in small
 *   letters may hold the other, and the two would be two accounts.
 * Composed once more at the end: the lower case of a base with a mark can
 * have a composed form where its upper case has none, and the spelling of a
 * spelling must be itself.
 *
 * No domain is mapped to another form here or anywhere: an address whose
 * domain is written in a form that would need it is refused by
 * `acceptedAddress`, and where an address is only looked up it finds no
 * account.
 */
export function addressSpelling(value: string): string {
  return value.normalize('NFC').toLowerCase().replace(FINAL_SIGMA, SIGMA).normalize('NFC');
}

/**
 * What was entered where an address is asked for and looked up, as
 * `addressSpelling` writes it, and bounded whatever was sent: no address is
 * longer than 254 characters. The first bound is wide enough for an address
 * of that length typed in the decomposed form.
 */
export function enteredAddress(value: string): string {
  return addressSpelling(value.slice(0, 1024)).slice(0, 255);
}

// What an address must look like. The requirements say "an email address" and
// no more; this refuses what could not be one, and anything that could break a
// header of a message. The owner's decision of 9 October 2026: none of the
// characters with which a header writes a list, a group, a comment, a route,
// a quoted name or a literal host is in either part.
const PART = String.raw`[^\s@\p{Cc}<>(),;:"[\]\\]+`;
const ADDRESS = new RegExp(`^${PART}@${PART}\\.${PART}$`, 'u');

// The owner's decision of 9 October 2026 (its register row is pending): "refuse
// any address whose domain is not plain lower-case ASCII, or a Unicode label
// that survives normalisation unchanged. The address is refused, not mapped."
// Otherwise a domain in full-width letters, or in any other compatibility
// form of a letter or a digit, would be an address of its own beside the
// plain one: a second account, and one that the list of the founding team
// does not match.
//
// The shape of a label: 1 to 63 letters, marks, digits and hyphens, with no
// hyphen first or last. The letters of ASCII are among them, in lower case by
// the time this is asked, so a label in punycode (`xn--…`) passes as it was
// typed: it is not decoded, and not compared with its Unicode form.
const LABEL = /^(?!-)[\p{L}\p{M}\p{N}-]{1,63}(?<!-)$/u;

/** Whether the domain of a spelt address is one that is stored. It changes nothing. */
function domainAccepted(domain: string): boolean {
  return (
    domain.length <= 253 &&
    domain.split('.').every(
      (label) =>
        LABEL.test(label) &&
        // No compatibility form: full-width, superscript, ligature, and every
        // capital that has no lower case of its own.
        label.normalize('NFKC') === label &&
        // Always so after `addressSpelling`, which is the only way here; it is
        // asked so that the rule stands whole should the spelling change.
        label.toLowerCase() === label,
    )
  );
}

/**
 * An email address as it is stored, in its one spelling (FR-AU-02), or null
 * where what was given could not be one, is longer than an address can be
 * (254 characters), or has a domain that is not stored (above). The one rule
 * of an address, for an admission invitation (FR-AU-89), for the change of an
 * account's address (FR-AU-03), and for an entry of the list of the founding
 * team (src/lib/settings.ts).
 */
export function acceptedAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = addressSpelling(value);
  if (email.length > 254 || !ADDRESS.test(email)) return null;
  return domainAccepted(email.slice(email.lastIndexOf('@') + 1)) ? email : null;
}
