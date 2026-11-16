// What an upload becomes before anything is stored (NFR-SE-18), in the order
// the clauses are checked: the size, the type from the content, and the
// metadata removed from a container that parses to its end. The upload route
// calls this and nothing of its own decides any of the three.
import { declaredSize, isAnimated, withinBound } from './dimensions.ts';
import { removeJpegMetadata } from './metadata/jpeg.ts';
import { removePngMetadata } from './metadata/png.ts';
import { REMOVAL_POLICY, type RemovalPolicy } from './metadata/policy.ts';
import { removeWebpMetadata } from './metadata/webp.ts';
import { IMAGE_MOST_BYTES, IMAGE_TYPES, type ImageFormat } from './node.ts';
import { isGif, sniffImage } from './sniff.ts';

export type Prepared =
  | { ok: true; format: ImageFormat; contentType: string; bytes: Buffer }
  /**
   * `too_large`: over 20 MB (413). `too_many_pixels`: a width or height, or a number of pixels, over the bound of
   * NFR-SE-18 (413). `gif`: any GIF (415; D310). `animated`: an animated WebP or PNG (415; D309, D310).
   * `not_accepted`: none of the three types, one that does not parse, or one whose header gives no size (415; D308).
   */
  | { ok: false; reason: 'too_large' | 'too_many_pixels' | 'gif' | 'animated' | 'not_accepted' };

const REMOVERS: Record<ImageFormat, (bytes: Uint8Array, policy: RemovalPolicy) => Buffer | null> = {
  png: removePngMetadata,
  jpeg: removeJpegMetadata,
  webp: removeWebpMetadata,
};

/** The bytes that are stored for an upload, with the type the server established, or the reason it is refused. */
export function prepareImage(bytes: Uint8Array, policy: RemovalPolicy = REMOVAL_POLICY): Prepared {
  if (bytes.length > IMAGE_MOST_BYTES) return { ok: false, reason: 'too_large' };
  // D310: every GIF, still or not, by its first bytes and nothing else; no GIF is parsed.
  if (isGif(bytes)) return { ok: false, reason: 'gif' };
  const format = sniffImage(bytes);
  if (!format) return { ok: false, reason: 'not_accepted' };
  // NFR-SE-18, D306, D308: the size the header declares, read from the header alone, BEFORE the step that removes the
  // metadata and before anything decodes a picture; a header that cannot be read is refused. The removal below is
  // held to the same limit by being asked only after it.
  const size = declaredSize(bytes, format);
  // A header that gives a side of 0 gives no size that a picture has: it is as unreadable as no header (D308).
  if (!size || size.width < 1 || size.height < 1) return { ok: false, reason: 'not_accepted' };
  if (!withinBound(size)) return { ok: false, reason: 'too_many_pixels' };
  // D309, D310: an animated WebP or PNG, from its chunks and no pixel.
  if (isAnimated(bytes, format)) return { ok: false, reason: 'animated' };
  // The container must parse to its end (the removal of metadata, which reads the structure and never the picture).
  const clean = REMOVERS[format](bytes, policy);
  if (!clean) return { ok: false, reason: 'not_accepted' };
  return { ok: true, format, contentType: IMAGE_TYPES[format], bytes: clean };
}
