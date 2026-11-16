// The width and height an image declares, read from its header and nothing else (NFR-SE-18, register D301, Q80;
// docs@da33e58): "an image is also held to a bound on its width and height in pixels, which an upload past it is
// refused for, as one over the byte limit is, so that a small file cannot be a very large picture". The owner's answer
// to Q80 is 12,000 pixels on each side and 50 megapixels in all.
//
// WHAT THIS DOES NOT DO: it decodes no picture. It reads a few bytes at the places each format keeps its size, so that
// the check costs the same for a file of 1 KB and one of 20 MB. It runs in `prepareImage` (./prepare.ts), after the
// container has been read to its end, which reads structure and never the picture, and before the image is stored or
// served, so before anything could decode it. Nothing of the application decodes a picture.
//
// Where a header cannot be read, the size is unknown and the image is not accepted (the caller refuses it as a file that
// is not an image of the four types). Where a file declares more than one size, the largest of each is taken: the
// bound is a bound on what any reader of the file may be made to allocate.
import type { ImageFormat } from './node.ts';

/** Q80, the owner's answer of 16 November 2026 (recorded as D rows by a docs pull request that was open when this was written): at most this on either side. */
export const IMAGE_MOST_SIDE = 12_000;
/** Q80: at most this in all, width times height: 50 megapixels, counted in millions of pixels as the owner said them. */
export const IMAGE_MOST_PIXELS = 50_000_000;

export interface Dimensions {
  width: number;
  height: number;
}

/** Whether a declared size is inside the bound: each side, and the pixels in all. A side of 0 is not a picture. */
export function withinBound({ width, height }: Dimensions): boolean {
  return (
    width >= 1 &&
    height >= 1 &&
    width <= IMAGE_MOST_SIDE &&
    height <= IMAGE_MOST_SIDE &&
    width * height <= IMAGE_MOST_PIXELS
  );
}

const be32 = (bytes: Uint8Array, at: number) =>
  ((bytes[at]! << 24) | (bytes[at + 1]! << 16) | (bytes[at + 2]! << 8) | bytes[at + 3]!) >>> 0;
const be16 = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!;
const le16 = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8);
const le24 = (bytes: Uint8Array, at: number) => bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16);
const le32 = (bytes: Uint8Array, at: number) => (le24(bytes, at) | (bytes[at + 3]! << 24)) >>> 0;
const tag = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));

/** PNG: the first chunk is IHDR, whose first two fields are the width and the height. */
function pngSize(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 24 || tag(bytes, 12) !== 'IHDR') return null;
  return { width: be32(bytes, 16), height: be32(bytes, 20) };
}

/** GIF: the logical screen descriptor, right after the six bytes of the signature. */
function gifSize(bytes: Uint8Array): Dimensions | null {
  if (bytes.length < 10) return null;
  return { width: le16(bytes, 6), height: le16(bytes, 8) };
}

/**
 * JPEG: the frame header (SOF0 to SOF15 but DHT, JPG and DAC), which comes before the first scan. Segments are walked
 * by their lengths, so the markers inside a thumbnail of an APP segment are never met. The largest of each side is taken.
 */
function jpegSize(bytes: Uint8Array): Dimensions | null {
  let at = 2;
  let found: Dimensions | null = null;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) return found;
    const marker = bytes[at + 1]!;
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return found; // end of image, or the first scan: no frame header follows
    const length = be16(bytes, at + 2);
    if (length < 2) return null;
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > bytes.length || length < 8) return null;
      const size = { height: be16(bytes, at + 5), width: be16(bytes, at + 7) };
      found = found
        ? { width: Math.max(found.width, size.width), height: Math.max(found.height, size.height) }
        : size;
    }
    at += 2 + length;
  }
  return found;
}

/**
 * WebP: the canvas of the extended header (VP8X: 24-bit sizes, minus one), and the size of the picture chunk (VP8:
 * 14-bit sizes after the frame tag; VP8L: 14-bit sizes, minus one, after the signature byte). Chunks are walked by
 * their lengths up to the first picture chunk; the largest of each side is taken.
 */
function webpSize(bytes: Uint8Array): Dimensions | null {
  let at = 12;
  let width = 0;
  let height = 0;
  let known = false;
  const note = (w: number, h: number) => {
    width = Math.max(width, w);
    height = Math.max(height, h);
    known = true;
  };
  while (at + 8 <= bytes.length) {
    const type = tag(bytes, at);
    const length = le32(bytes, at + 4);
    const data = at + 8;
    if (type === 'VP8X') {
      if (data + 10 > bytes.length) return null;
      note(le24(bytes, data + 4) + 1, le24(bytes, data + 7) + 1);
    } else if (type === 'VP8 ') {
      if (data + 10 > bytes.length) return null;
      note(le16(bytes, data + 6) & 0x3fff, le16(bytes, data + 8) & 0x3fff);
      return { width, height };
    } else if (type === 'VP8L') {
      if (data + 5 > bytes.length || bytes[data] !== 0x2f) return null;
      const bits = le32(bytes, data + 1);
      note((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      return { width, height };
    }
    at = data + length + (length % 2);
  }
  return known ? { width, height } : null;
}

const READERS: Record<ImageFormat, (bytes: Uint8Array) => Dimensions | null> = {
  png: pngSize,
  jpeg: jpegSize,
  gif: gifSize,
  webp: webpSize,
};

/** The size an image of this format declares in its header, or null where the header does not give one. */
export function declaredSize(bytes: Uint8Array, format: ImageFormat): Dimensions | null {
  return READERS[format](bytes);
}
