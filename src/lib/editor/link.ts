// The addresses a hyperlink of a document may hold (FR-ED-02; NFR-SE-06, A03).
//
// PROVISIONAL: the Docs name no scheme. A link whose address ran as script
// would run in the session of whoever opened the document, so the list is the
// shortest that serves writing: `https` and `http` with a host, and `mailto`,
// and nothing else. It is reported to the owner as a row for the register;
// when the Docs state a list, this function changes and nothing else does.
const SCHEMES = /^(https?:\/\/[^/?#]|mailto:)/i;
// What no address is written with, and what a browser's parser and this
// language's `trim` disagree about: white space of any kind (U+FEFF, U+00A0,
// U+2028 and U+2029 among it), a control character, and a backslash, which the
// parser reads as a slash.
const NEVER = /[\s\u0000-\u001f\u007f-\u009f\\]/;

/**
 * The address as a link stores it, or null where it is not one a link may
 * hold: `javascript:`, `data:`, `vbscript:`, `file:`, an address relative to
 * the page (`https:example` is one), and anything the platform's own parser
 * does not read as an address at all.
 *
 * The test is of the text as it is stored and rendered, character for
 * character: nothing is trimmed and nothing mended, so what is admitted is
 * exactly what reaches the `href`. A writing that a browser would mend (a tab
 * inside the scheme, a character before it that only some parsers drop) is
 * refused. The platform's parser must then agree: one of the three schemes,
 * and for `http` and `https` a host. A form trims what a person typed before
 * it asks here.
 */
export function linkAddress(given: unknown): string | null {
  if (typeof given !== 'string' || !SCHEMES.test(given) || NEVER.test(given)) return null;
  if (!URL.canParse(given)) return null;
  const { protocol, hostname } = new URL(given);
  if (protocol === 'mailto:') return given;
  return (protocol === 'https:' || protocol === 'http:') && hostname !== '' ? given : null;
}
