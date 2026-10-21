// What a footnote is, and what its two nodes in a document may hold (FR-ED-05,
// NFR-SE-06, NFR-SE-08). Nothing here is of Next.js or reads the database: the
// editor's schema and the collaboration server both import it, so that the
// browser and the server hold one rule (src/app/(app)/documents/[id]/extensions.tsx,
// src/lib/collab/shape.ts), as for an image (src/lib/images/node.ts).
//
// A footnote is two nodes that share an identifier: the marker, an inline node
// in the text (`footnoteReference`), and the entry, a block in the list at the
// end of the document (`footnote`, in `footnotes`). Each holds that identifier
// and nothing else. The number of a footnote is stored nowhere: it is the place
// of its marker among the markers (docs/plan/slice-20.md, section 3).

/**
 * The identifier of a footnote: 24 characters of `0-9a-f`, made in the browser
 * from 12 random bytes (`newFootnoteId`). It names a marker and its entry and
 * no row, no object and no address, so any string of this form is as good as
 * another, and the server holds a client to the form and to no more.
 */
export const FOOTNOTE_ID = /^[0-9a-f]{24}$/;

/** The attributes of a marker and of an entry, and no others. */
export const FOOTNOTE_ATTRIBUTES: readonly string[] = ['id'];

/** The names of the nodes the rule is for, which the server reads attributes of by name. */
export const FOOTNOTE_NODES: ReadonlySet<string> = new Set(['footnoteReference', 'footnote']);

/** Whether a value is an identifier of a footnote. */
export const isFootnoteId = (value: unknown): value is string =>
  typeof value === 'string' && FOOTNOTE_ID.test(value);

/**
 * Whether the value of one attribute of a marker or an entry is one it may
 * hold: an identifier, or null, which is what a node made without one holds.
 * Anything else, and every other name, is refused, a shared type, binary data
 * and a number among them.
 */
export function footnoteAttributeAllowed(key: string, value: unknown): boolean {
  if (!FOOTNOTE_ATTRIBUTES.includes(key)) return false;
  return value === null || isFootnoteId(value);
}

/** A new identifier: 12 random bytes in lower-case hexadecimal. */
export function newFootnoteId(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
