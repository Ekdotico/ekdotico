// What an upload becomes before anything is stored (NFR-SE-18), in the order
// the clauses are checked: the size, the type from the content, and the
// metadata removed from a container that parses to its end. The upload route
// calls this and nothing of its own decides any of the three.
import { declaredSize, withinBound } from './dimensions.ts';
import { removeGifMetadata } from './metadata/gif.ts';
import { removeJpegMetadata } from './metadata/jpeg.ts';
import { removePngMetadata } from './metadata/png.ts';
import { REMOVAL_POLICY, type RemovalPolicy } from './metadata/policy.ts';
import { removeWebpMetadata } from './metadata/webp.ts';
import { IMAGE_MOST_BYTES, IMAGE_TYPES, type ImageFormat } from './node.ts';
import { sniffImage } from './sniff.ts';

export type Prepared =
  | { ok: true; format: ImageFormat; contentType: string; bytes: Buffer }
  /**
   * `too_large`: over 20 MB (413). `too_many_pixels`: a width or height, or a number of pixels, over the bound of
   * NFR-SE-18 (413). `not_accepted`: none of the four types, one that does not parse, or one whose header gives no
   * size (415).
   */
  | { ok: false; reason: 'too_large' | 'too_many_pixels' | 'not_accepted' };

const REMOVERS: Record<ImageFormat, (bytes: Uint8Array, policy: RemovalPolicy) => Buffer | null> = {
  png: removePngMetadata,
  jpeg: removeJpegMetadata,
  gif: removeGifMetadata,
  webp: removeWebpMetadata,
};

/** The bytes that are stored for an upload, with the type the server established, or the reason it is refused. */
export function prepareImage(bytes: Uint8Array, policy: RemovalPolicy = REMOVAL_POLICY): Prepared {
  if (bytes.length > IMAGE_MOST_BYTES) return { ok: false, reason: 'too_large' };
  const format = sniffImage(bytes);
  if (!format) return { ok: false, reason: 'not_accepted' };
  // The container must parse to its end (the removal of metadata, which reads the structure and never the picture),
  // so that a file that is not an image of its type is told as one before its size is.
  const clean = REMOVERS[format](bytes, policy);
  if (!clean) return { ok: false, reason: 'not_accepted' };
  // NFR-SE-18, D301, Q80: the size the header declares, read from the header alone, before the image is stored, served
  // or handed to anything that decodes a picture, so that a small file cannot be a very large picture.
  const size = declaredSize(bytes, format);
  if (!size) return { ok: false, reason: 'not_accepted' };
  if (!withinBound(size)) return { ok: false, reason: 'too_many_pixels' };
  return { ok: true, format, contentType: IMAGE_TYPES[format], bytes: clean };
}
