// The name of a draft export, derived from the title by one rule (FR-EX-36), and the header that carries it
// (RFC 6266). The same stem names the download (`<stem>.zip`) and the Markdown file inside it (`<stem>.md`).
//
// FR-EX-36: "path separators, a sequence of two full stops, control characters, and quotation marks are removed;
// the result is cut to 100 characters (an initial value); and an empty result is replaced by the fixed name
// `document`". The words left open are read as docs/plan/slice-21.md, S21-2, has them; each is one line below.
import { settings } from '../settings.ts';

/** The name an empty result is replaced by (FR-EX-36). */
export const FALLBACK_NAME = 'document';

// Path separators: the two that any platform reads as one.
const SEPARATORS = /[/\\]/gu;
// Control characters: Unicode `Cc`, and the controls of bidirectional text, which could make `x.zip` read as another name.
const CONTROLS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
// Quotation marks: the one that ends a quoted header parameter, and the typographic double marks.
const QUOTES = /["\u201C-\u201F]/gu;
// A sequence of two full stops or more: removed whole, so that none is left.
const DOTS = /\.{2,}/gu;
// What Windows does not keep in a file name, and a drive-like start (`C:`) that a zip tool reads as a path. Written
// as the one character `_` (register row S21-2: the rule gives these no word, and a name the archive refuses after
// the response has begun is a download that cannot succeed).
const UNSAFE = /[:*?<>|]/gu;
const REPLACEMENT = '_';
// The names Windows reserves, with or without an extension: `CON`, `con.txt`.
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
/**
 * The most bytes of a stem: an entry name over 255 bytes is refused by the archive (./zip.ts), and `.md` is 3, so
 * 252 would do; 250 leaves room. A title of 85 characters of Chinese is 255 bytes before it is cut to 100 characters.
 */
export const STEM_MOST_BYTES = 250;

/**
 * The stem of the names derived from a title: the rule of FR-EX-36, in the order that leaves no sequence of two
 * full stops behind (a separator, a control character or a quotation mark between two full stops joins them when
 * it goes, so the sequences are removed after the others); then what Windows does not keep is written `_`. The cut
 * is by code point, so that no pair is split, to `maxChars` characters and to `STEM_MOST_BYTES` bytes in UTF-8,
 * whichever comes first. A stem does not end in a full stop or in white space, or the extension would join it into
 * `..`; a stem that is nothing but white space is empty; a name Windows reserves has `_` put before it.
 */
export function exportName(title: string, maxChars: number = settings().exportNameMaxChars): string {
  const kept = title
    .toWellFormed()
    .replace(SEPARATORS, '')
    .replace(CONTROLS, '')
    .replace(QUOTES, '')
    .replace(DOTS, '')
    .replace(UNSAFE, REPLACEMENT);
  let cut = '';
  let characters = 0;
  let bytes = 0;
  for (const each of kept) {
    bytes += Buffer.byteLength(each);
    characters += 1;
    if (characters > maxChars || bytes > STEM_MOST_BYTES) break;
    cut += each;
  }
  const stem = cut.replace(/[.\s]+$/u, '').trimStart();
  if (stem === '') return FALLBACK_NAME;
  return RESERVED.test(stem) ? `${REPLACEMENT}${stem}` : stem;
}

/**
 * `Content-Disposition` for a download, as RFC 6266 gives it: an ASCII `filename` for a client that reads no other,
 * and `filename*` in UTF-8 as RFC 5987 encodes it, which a client that reads both prefers. The ASCII form replaces
 * everything outside printable ASCII, and `%`, `"` and `\`, with `_`; the encoded form leaves only the characters
 * RFC 5987 calls attr-char, so that neither can end its parameter, start another, or hold a line break.
 */
export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]|[%"\\]/gu, '_');
  const encoded = encodeURIComponent(filename.toWellFormed()).replace(
    /['()*]/g,
    (each) => `%${each.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
