// The one tag of Exif that the removal may keep, Orientation (./policy.ts,
// register row S19-2): read from the Exif block that is being removed, and
// written back as a block of that tag alone.

const ORIENTATION_TAG = 0x0112;
const SHORT = 3;

/**
 * The orientation of an image from the TIFF structure of an Exif block, 2 to 8
 * (1 is the image as stored, and a value outside 1 to 8 means nothing), or
 * null where there is none to keep. Every read is checked against the length:
 * the block is hostile.
 */
export function orientationOf(tiff: Uint8Array): number | null {
  if (tiff.length < 8) return null;
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const order = String.fromCharCode(tiff[0]!, tiff[1]!);
  if (order !== 'II' && order !== 'MM') return null;
  const little = order === 'II';
  if (view.getUint16(2, little) !== 42) return null;
  const first = view.getUint32(4, little);
  if (first + 2 > tiff.length) return null;
  const entries = view.getUint16(first, little);
  for (let index = 0; index < entries; index += 1) {
    const at = first + 2 + index * 12;
    if (at + 12 > tiff.length) return null;
    if (view.getUint16(at, little) !== ORIENTATION_TAG) continue;
    if (view.getUint16(at + 2, little) !== SHORT || view.getUint32(at + 4, little) !== 1) return null;
    const value = view.getUint16(at + 8, little);
    return value >= 2 && value <= 8 ? value : null;
  }
  return null;
}

/**
 * The TIFF structure of an Exif block that holds one tag, Orientation, and
 * nothing else: a header, one directory of one entry, and no next directory.
 */
export function orientationTiff(orientation: number): Buffer {
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(ORIENTATION_TAG, 10);
  tiff.writeUInt16LE(SHORT, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  // Bytes 20 to 21 pad the value to four; 22 to 25 are the offset of the next directory, none.
  return tiff;
}
