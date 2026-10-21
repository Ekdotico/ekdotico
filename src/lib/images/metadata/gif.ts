// Removes the metadata of a GIF file without compressing it again: the blocks
// are read to the trailer, and a new file is written from those the picture
// needs; the data of every frame is copied byte for byte.
//
// A WHITELIST. Kept: the header, the screen descriptor, the colour tables, the
// image descriptors with their data, the graphic control extension (the delay
// and the transparency of a frame), and the application extension that carries
// the loop count of an animation (NETSCAPE2.0). Dropped: comment extensions,
// plain text extensions, every other application extension (an XMP packet is
// one), and everything after the trailer. A GIF carries no Exif and no colour
// profile, so the policy has nothing to say of it.
import type { RemovalPolicy } from './policy.ts';

const LOOP_ID = Buffer.from('NETSCAPE2.0', 'latin1');

/** Where the sub-blocks that begin at `at` end, after their terminator, or -1 where the file ends first. */
function afterSubBlocks(file: Buffer, at: number): number {
  let next = at;
  for (;;) {
    if (next >= file.length) return -1;
    const size = file[next]!;
    next += 1 + size;
    if (size === 0) return next <= file.length ? next : -1;
  }
}

/** The file without its metadata, or null where it is not a GIF file that is whole. */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- the policy is the same for the four, and a GIF has no part of it to keep
export function removeGifMetadata(bytes: Uint8Array, _policy: RemovalPolicy): Buffer | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (file.length < 13) return null;
  const header = file.toString('latin1', 0, 6);
  if (header !== 'GIF87a' && header !== 'GIF89a') return null;
  let at = 13;
  const screen = file[10]!;
  if (screen & 0x80) at += 3 * 2 ** ((screen & 7) + 1);
  if (at > file.length) return null;
  const parts: Buffer[] = [file.subarray(0, at)];
  // The graphic control extension that waits for the frame it belongs to.
  let control: Buffer | null = null;
  let frames = 0;
  while (at < file.length) {
    const introducer = file[at]!;
    if (introducer === 0x3b) {
      if (frames === 0) return null;
      parts.push(Buffer.from([0x3b]));
      return Buffer.concat(parts);
    }
    if (introducer === 0x21) {
      const label = file[at + 1];
      if (label === undefined) return null;
      const end = afterSubBlocks(file, at + 2);
      if (end < 0) return null;
      const block = file.subarray(at, end);
      if (label === 0xf9) {
        // The four bytes of the graphic control (a flag, the delay, the transparent colour) and the end of the
        // block, written afresh: a sub-block that follows them is not kept. One that is not four bytes is no control.
        control = block[2] === 4 ? Buffer.concat([block.subarray(0, 7), Buffer.from([0])]) : null;
      } else if (label === 0xff) {
        // The first sub-block is 11 bytes: the application and its code. Of NETSCAPE2.0 the three bytes of the loop
        // count are kept (a sub-block of 3 that begins with 1) and nothing after them.
        if (block[2] === 11 && block.subarray(3, 14).equals(LOOP_ID) && block[14] === 3 && block[15] === 1) {
          parts.push(Buffer.concat([block.subarray(0, 18), Buffer.from([0])]));
        }
      } else if (label === 0x01) {
        // A plain text extension is a graphic block the control extension before it belongs to.
        control = null;
      }
      at = end;
      continue;
    }
    if (introducer === 0x2c) {
      if (at + 10 > file.length) return null;
      const packed = file[at + 9]!;
      let data = at + 10;
      if (packed & 0x80) data += 3 * 2 ** ((packed & 7) + 1);
      // The minimum code size, then the sub-blocks of the data.
      if (data >= file.length) return null;
      const end = afterSubBlocks(file, data + 1);
      if (end < 0) return null;
      if (control) parts.push(control);
      control = null;
      parts.push(file.subarray(at, end));
      frames += 1;
      at = end;
      continue;
    }
    return null;
  }
  return null;
}
