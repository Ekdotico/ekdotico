// Removes the metadata of a WebP file without compressing it again: the chunks
// of the RIFF container are read to its end, and a new container is written
// from those the picture needs; the data of every frame is copied byte for byte.
//
// A WHITELIST. Kept: VP8, VP8L, VP8X, ALPH, ANIM and ANMF (a frame, with what
// it holds), and, by the policy, ICCP. Dropped: EXIF (where the location is),
// "XMP ", every chunk that is unknown, and everything after the length the
// RIFF header gives. The VP8X header has a flag for each of the parts it
// announces, and the flags are written again for what the new file holds. The
// RIFF size is written again.
import { orientationOf, orientationTiff } from './orientation.ts';
import type { RemovalPolicy } from './policy.ts';

const PICTURE = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF']);
const ICC_FLAG = 0x20;
const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;

function chunk(type: string, data: Uint8Array): Buffer {
  const padded = data.length + (data.length % 2);
  const made = Buffer.alloc(8 + padded);
  made.write(type, 0, 'latin1');
  made.writeUInt32LE(data.length, 4);
  made.set(data, 8);
  return made;
}

/** The file without its metadata, or null where it is not a WebP file that is whole. */
export function removeWebpMetadata(bytes: Uint8Array, policy: RemovalPolicy): Buffer | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    file.length < 12 ||
    file.toString('latin1', 0, 4) !== 'RIFF' ||
    file.toString('latin1', 8, 12) !== 'WEBP'
  ) {
    return null;
  }
  const end = 8 + file.readUInt32LE(4);
  // The container is the length it says, and not longer than the file: what is after it is dropped.
  if (end > file.length || end < 12) return null;
  let extended: Buffer | null = null;
  let icc: Buffer | null = null;
  let orientation: number | null = null;
  const body: Buffer[] = [];
  let pictures = 0;
  let at = 12;
  while (at < end) {
    if (at + 8 > end) return null;
    const type = file.toString('latin1', at, at + 4);
    const length = file.readUInt32LE(at + 4);
    const next = at + 8 + length + (length % 2);
    // A chunk lies inside the container, with its padding byte to an even length.
    if (next > end) return null;
    const data = file.subarray(at + 8, at + 8 + length);
    if (type === 'VP8X') {
      if (extended || length < 10 || body.length > 0) return null;
      extended = Buffer.from(data.subarray(0, 10));
    } else if (type === 'ICCP') {
      if (policy.keepColour && !icc) icc = chunk(type, data);
    } else if (type === 'EXIF') {
      if (policy.keepOrientation && orientation === null) {
        // Some writers put the identifier of the JPEG form before the TIFF structure.
        const tiff =
          data.length >= 6 && data.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? data.subarray(6) : data;
        orientation = orientationOf(tiff);
      }
    } else if (PICTURE.has(type)) {
      if (type === 'VP8 ' || type === 'VP8L' || type === 'ANMF') pictures += 1;
      body.push(file.subarray(at, next));
    }
    at = next;
  }
  if (pictures === 0) return null;
  // Simple files have no VP8X, and no flags to write; where they have it, it comes first (above).
  const parts: Buffer[] = [];
  if (extended) {
    let flags = extended[0]! & ~(ICC_FLAG | EXIF_FLAG | XMP_FLAG);
    if (icc) flags |= ICC_FLAG;
    if (orientation !== null) flags |= EXIF_FLAG;
    extended[0] = flags;
    parts.push(chunk('VP8X', extended));
    if (icc) parts.push(icc);
  }
  parts.push(...body);
  // An orientation can only have come from a file that has a VP8X, and that has one to carry the flag.
  if (orientation !== null && extended) parts.push(chunk('EXIF', orientationTiff(orientation)));
  const container = Buffer.concat(parts);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(4 + container.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, container]);
}
