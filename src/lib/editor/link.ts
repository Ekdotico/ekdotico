// The addresses a hyperlink of a document may hold (FR-ED-02; NFR-SE-06, A03).
//
// PROVISIONAL: the Docs name no scheme. A link whose address ran as script
// would run in the session of whoever opened the document, so the list is the
// shortest that serves writing: `https` and `http` with a host, and `mailto`,
// and nothing else. It is reported to the owner as a row for the register;
// when the Docs state a list, this expression changes and nothing else does.
const ALLOWED = /^(https?:\/\/|mailto:)/i;

/**
 * The address as a link stores it, or null where it is not one a link may
 * hold: `javascript:`, `data:`, `vbscript:`, `file:`, an address relative to
 * the page (`https:example` is one), and anything the platform's own parser
 * does not read as an address at all.
 *
 * The test is of the text as it is stored, from its first character: a
 * writing of a scheme that a browser would mend (a tab inside it, a control
 * character before it) does not begin with one of the three, and is refused
 * rather than mended. What is returned is the text that was given, trimmed.
 */
export function linkAddress(given: unknown): string | null {
  if (typeof given !== 'string') return null;
  const text = given.trim();
  return ALLOWED.test(text) && URL.canParse(text) ? text : null;
}
