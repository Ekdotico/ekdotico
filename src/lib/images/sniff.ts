// NFR-SE-18: "An uploaded image shall be accepted only where its content, read
// by the server, is a PNG, JPEG, GIF, or WebP image; the file name and the
// declared type are not evidence. Any other content, an SVG file included, is
// refused." This reads the first bytes and nothing else: there is no parameter
// for a name or a type, so neither can be taken for evidence.
import type { ImageFormat } from './node.ts';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const starts = (bytes: Uint8Array, at: number, ...expected: (number | string)[]) =>
  expected.every((each, index) => {
    const found = bytes[at + index];
    return typeof each === 'number' ? found === each : found === each.charCodeAt(0);
  });

/**
 * The format of an image by its content, or null where the content is none of
 * the four. The signature only: whether the whole parses is the question of
 * `removeMetadata`, which reads each format to its end.
 */
export function sniffImage(bytes: Uint8Array): ImageFormat | null {
  if (bytes.length >= 8 && starts(bytes, 0, ...PNG)) return 'png';
  if (bytes.length >= 3 && starts(bytes, 0, 0xff, 0xd8, 0xff)) return 'jpeg';
  if (bytes.length >= 6 && (starts(bytes, 0, ...'GIF87a') || starts(bytes, 0, ...'GIF89a'))) return 'gif';
  if (bytes.length >= 12 && starts(bytes, 0, ...'RIFF') && starts(bytes, 8, ...'WEBP')) return 'webp';
  return null;
}
