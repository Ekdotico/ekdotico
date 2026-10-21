// Removes the metadata of a PNG file without compressing it again: the chunks
// are read to the end, and a new file is written from those that the image
// needs; the data of the image (every IDAT) is copied byte for byte.
//
// A WHITELIST. Kept: the chunks that the picture is made of (IHDR, PLTE, tRNS,
// IDAT, IEND), the chunks of an animation (acTL, fcTL, fdAT), and, by the
// policy, the colour chunks. Everything else is dropped, whatever it is called:
// tEXt, zTXt and iTXt (an XMP packet is an iTXt), eXIf (where the location
// is), tIME, pHYs, sBIT, bKGD, hIST, sPLT, every chunk that is private or
// unknown, and anything after IEND.
import { crc32 } from 'node:zlib';
import { orientationOf, orientationTiff } from './orientation.ts';
import type { RemovalPolicy } from './policy.ts';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PICTURE = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND', 'acTL', 'fcTL', 'fdAT']);
const COLOUR = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'cICP']);

function chunk(type: string, data: Uint8Array): Buffer {
  const made = Buffer.alloc(12 + data.length);
  made.writeUInt32BE(data.length, 0);
  made.write(type, 4, 'latin1');
  made.set(data, 8);
  made.writeUInt32BE(crc32(made.subarray(4, 8 + data.length)), 8 + data.length);
  return made;
}

/**
 * Whether a chunk of this type and length is of a length that the format gives it: `keep`; `drop`, for an
 * optional part that is the wrong length or has no place in this kind of image; or `refuse`, for a part of the
 * picture whose length makes the file no PNG file. `data` chunks (IDAT, fdAT) and the colour profile (iCCP) are
 * the picture and the profile and are kept whole, as the owner decided (S19-2).
 */
function sizeOf(type: string, length: number, colourType: number | undefined): 'keep' | 'drop' | 'refuse' {
  switch (type) {
    case 'IEND':
      // Of no data. One that holds some is read as the end all the same, and written again without them.
      return 'keep';
    case 'PLTE':
      return length % 3 === 0 && length >= 3 && length <= 768 ? 'keep' : 'refuse';
    case 'tRNS':
      // One grey value, one colour, or an alpha for each entry of a palette; no other kind of image has one.
      if (colourType === 0) return length === 2 ? 'keep' : 'drop';
      if (colourType === 2) return length === 6 ? 'keep' : 'drop';
      if (colourType === 3) return length >= 1 && length <= 256 ? 'keep' : 'drop';
      return 'drop';
    case 'acTL':
      return length === 8 ? 'keep' : 'refuse';
    case 'fcTL':
      return length === 26 ? 'keep' : 'refuse';
    case 'gAMA':
    case 'cICP':
      return length === 4 ? 'keep' : 'drop';
    case 'cHRM':
      return length === 32 ? 'keep' : 'drop';
    case 'sRGB':
      return length === 1 ? 'keep' : 'drop';
    default:
      return 'keep';
  }
}

/** The file without its metadata, or null where it is not a PNG file that is whole. */
export function removePngMetadata(bytes: Uint8Array, policy: RemovalPolicy): Buffer | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (file.length < 8 + 12 || !file.subarray(0, 8).equals(SIGNATURE)) return null;
  const kept: { type: string; whole: Buffer }[] = [];
  let orientation: number | null = null;
  let at = 8;
  let ended = false;
  while (at + 12 <= file.length && !ended) {
    const length = file.readUInt32BE(at);
    // A length is at most 2^31 - 1 (the specification); and the chunk lies inside the file.
    if (length > 0x7fffffff || at + 12 + length > file.length) return null;
    const type = file.toString('latin1', at + 4, at + 8);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    const whole = file.subarray(at, at + 12 + length);
    const wanted = PICTURE.has(type) || (policy.keepColour && COLOUR.has(type));
    // What the chunk may be as long as: a chunk of a fixed length that is longer holds something else, and
    // is no part of the picture whatever its name (the review of pull request 52).
    const size = sizeOf(type, length, kept[0]?.type === 'IHDR' ? kept[0].whole[8 + 9] : undefined);
    if (wanted && size === 'refuse') return null;
    if (wanted && size === 'keep') {
      // The check value of a chunk that is kept: a file that is cut or written over is refused.
      if (whole.readUInt32BE(8 + length) !== crc32(whole.subarray(4, 8 + length))) return null;
      // The end of the file is a chunk of no data, written afresh: nothing that was in the one that came is kept.
      kept.push({ type, whole: type === 'IEND' ? chunk('IEND', Buffer.alloc(0)) : whole });
    } else if (type === 'eXIf' && policy.keepOrientation && orientation === null) {
      orientation = orientationOf(file.subarray(at + 8, at + 8 + length));
    }
    ended = type === 'IEND';
    at += 12 + length;
  }
  // The first chunk is IHDR, 13 bytes; the last kept is IEND; at least one IDAT.
  if (!ended || kept[0]?.type !== 'IHDR' || kept[0].whole.readUInt32BE(0) !== 13) return null;
  if (!kept.some((each) => each.type === 'IDAT')) return null;
  const parts: Buffer[] = [SIGNATURE];
  for (const each of kept) {
    // The orientation goes before the first IDAT, where the specification allows an eXIf.
    if (each.type === 'IDAT' && orientation !== null) {
      parts.push(chunk('eXIf', orientationTiff(orientation)));
      orientation = null;
    }
    parts.push(each.whole);
  }
  return Buffer.concat(parts);
}
