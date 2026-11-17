// What an image is, and what its block in a document may hold (FR-ED-08,
// NFR-SE-18, NFR-SE-06 A01). Nothing here reads the database or is of Next.js:
// the editor's schema and the collaboration server both import it, so that the
// browser and the server hold one rule (src/app/(app)/documents/[id]/extensions.tsx,
// src/lib/collab/shape.ts).

/** FR-ED-08: "The maximum upload size per image shall be 20 MB", counted in bytes of 1,024 as every limit of the application is. */
export const IMAGE_MOST_BYTES = 20 * 1024 * 1024;

/** The four types an image may be, by what the server finds in its content (NFR-SE-18), with the type each is stored and served as. */
export const IMAGE_TYPES = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
} as const;
export type ImageFormat = keyof typeof IMAGE_TYPES;

/**
 * The attributes of an image block, and no others. There is none that could
 * hold an address: the block holds the identifier of an uploaded image and the
 * words that go with it, and never a `src`, an `href`, or a `data:` value
 * (FR-ED-08, NFR-SE-06 A01). The server refuses an update that gives an image
 * element any other attribute.
 */
export const IMAGE_ATTRIBUTES: readonly string[] = ['id', 'alt', 'caption', 'width'];

/**
 * The identifier of an uploaded image, as the database issues it (a cuid, 25
 * characters of a to z and 0 to 9, the first a `c`). A block holds this and
 * nothing else of an image; the object key names its document and stays in
 * the database (docs/plan/slice-19.md, S19-7).
 */
export const IMAGE_ID = /^c[a-z0-9]{24}$/;

// Register row S19-3, recommended and not yet answered: the Docs give no bound
// for the words of a block or for its width. The server keeps these, in the
// text's UTF-16 units, so that a client cannot fill the 5 MB of a document
// with one attribute; a change of the answer is a change to these four lines.
/** The longest alt text of an image. */
export const IMAGE_ALT_MOST = 1000;
/** The longest caption of an image. */
export const IMAGE_CAPTION_MOST = 500;
/** The narrowest and the widest an image block may be, in percent of the line. */
export const IMAGE_WIDTH_LEAST = 10;
export const IMAGE_WIDTH_MOST = 100;

/**
 * Whether the value of one attribute of an image block is one the block may
 * hold. `null` is allowed for each: it is the default the editor writes for an
 * attribute that has no value yet, and a block whose `id` is null shows that
 * its image is not available. Anything that is not text, a whole number
 * in its bounds, or null is refused, a number written as text among it.
 */
export function imageAttributeAllowed(key: string, value: unknown): boolean {
  if (value === null) return IMAGE_ATTRIBUTES.includes(key);
  switch (key) {
    case 'id':
      return typeof value === 'string' && IMAGE_ID.test(value);
    case 'alt':
      return typeof value === 'string' && value.length <= IMAGE_ALT_MOST;
    case 'caption':
      return typeof value === 'string' && value.length <= IMAGE_CAPTION_MOST;
    case 'width':
      return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= IMAGE_WIDTH_LEAST &&
        value <= IMAGE_WIDTH_MOST
      );
    default:
      return false;
  }
}
