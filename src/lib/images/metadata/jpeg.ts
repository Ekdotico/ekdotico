// Removes the metadata of a JPEG file without compressing it again: the
// segments are read to the end of the image, and a new file is written from
// those the picture needs; the entropy-coded data of every scan is copied byte
// for byte.
//
// A WHITELIST of markers. Kept: the segments the picture is made of (the frame
// headers SOF0 to SOF15 but DHT, JPG and DAC aside, the tables DQT, DHT and
// DAC, DRI, DNL, EXP, the scans SOS and their data, RSTn); APP14 "Adobe",
// which says how to read the colours; the JFIF header of APP0 with the
// thumbnail it may carry taken out; and, by the policy, the ICC profile
// (APP2 "ICC_PROFILE"). Dropped: APP1 (Exif, with the location, the time, the
// device and a thumbnail; and XMP), APP13 (Photoshop and IPTC), APP2 of the
// multi-picture format (a second, hidden image), APP0 "JFXX" (thumbnails),
// every other APPn, COM, and everything after the last EOI.
//
// Where the policy keeps the orientation, an Exif segment of that one tag is
// written in place of the one that is removed.
import { orientationOf, orientationTiff } from './orientation.ts';
import type { RemovalPolicy } from './policy.ts';

const EXIF_ID = Buffer.from('Exif\0\0', 'latin1');
const ICC_ID = Buffer.from('ICC_PROFILE\0', 'latin1');
const JFIF_ID = Buffer.from('JFIF\0', 'latin1');
const ADOBE_ID = Buffer.from('Adobe', 'latin1');
/** What an APP14 "Adobe" segment holds: the five letters, a version of two bytes, two flags of two, and the transform of one. */
const ADOBE_BYTES = 12;

// Markers with no length, and the markers of the picture that are kept with theirs.
const NO_LENGTH = (marker: number) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);
const PICTURE = (marker: number) =>
  (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || // SOF0 to SOF15, DHT (C4) and DAC (CC) included; C8 is reserved
  marker === 0xdb || // DQT
  marker === 0xdd || // DRI
  marker === 0xdc || // DNL
  marker === 0xdf; // EXP
const SOF = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

const startsWith = (data: Buffer, id: Buffer) =>
  data.length >= id.length && data.subarray(0, id.length).equals(id);

/** The file without its metadata, or null where it is not a JPEG file that is whole. */
export function removeJpegMetadata(bytes: Uint8Array, policy: RemovalPolicy): Buffer | null {
  const file = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (file.length < 4 || file[0] !== 0xff || file[1] !== 0xd8) return null;
  const parts: { jfif: boolean; bytes: Buffer }[] = [];
  let orientation: number | null = null;
  let frame = false;
  let scanned = false;
  let ended = false;
  let at = 2;
  while (at < file.length && !ended) {
    if (file[at] !== 0xff) return null;
    // Any number of fill bytes may come before a marker.
    while (file[at + 1] === 0xff) at += 1;
    const marker = file[at + 1];
    if (marker === undefined) return null;
    if (marker === 0xd9) {
      ended = true;
      break;
    }
    if (NO_LENGTH(marker)) {
      // SOI again, or a restart marker outside a scan: not a file this reads.
      return null;
    }
    // A marker that is reserved is not one this reads (0x00 is no marker at all).
    if (marker === 0x00 || (marker >= 0x02 && marker <= 0xbf) || marker === 0xc8) return null;
    if (at + 4 > file.length) return null;
    const length = file.readUInt16BE(at + 2);
    if (length < 2 || at + 2 + length > file.length) return null;
    const segment = file.subarray(at, at + 2 + length);
    const data = file.subarray(at + 4, at + 2 + length);

    if (marker === 0xda) {
      // The scan: its header, then its data to the next marker that is not part of it.
      if (!frame) return null;
      let end = at + 2 + length;
      for (;;) {
        const found = file.indexOf(0xff, end);
        if (found < 0 || found + 1 >= file.length) return null;
        const next = file[found + 1]!;
        // 0xFF 0x00 is a stuffed byte, 0xFF D0 to D7 a restart, 0xFF 0xFF a fill byte.
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) {
          end = found + (next === 0xff ? 1 : 2);
          continue;
        }
        end = found;
        break;
      }
      parts.push({ jfif: false, bytes: file.subarray(at, end) });
      scanned = true;
      at = end;
      continue;
    }

    if (PICTURE(marker)) {
      if (SOF(marker)) frame = true;
      parts.push({ jfif: false, bytes: segment });
    } else if (marker === 0xe0 && startsWith(data, JFIF_ID) && data.length >= 14) {
      // The JFIF header, and no thumbnail: its width and height are set to 0 and the data cut off.
      const header = Buffer.from(segment.subarray(0, 4 + 14));
      header.writeUInt16BE(16, 2);
      header[4 + 12] = 0;
      header[4 + 13] = 0;
      parts.push({ jfif: true, bytes: header });
    } else if (marker === 0xee && startsWith(data, ADOBE_ID) && data.length >= ADOBE_BYTES) {
      // The 12 bytes the segment is defined to hold ("Adobe", a version, two flags, the transform), and no
      // more: what a writer put after them is dropped, whatever length the segment declares.
      const adobe = Buffer.from(segment.subarray(0, 4 + ADOBE_BYTES));
      adobe.writeUInt16BE(2 + ADOBE_BYTES, 2);
      parts.push({ jfif: false, bytes: adobe });
    } else if (marker === 0xe2 && policy.keepColour && startsWith(data, ICC_ID)) {
      parts.push({ jfif: false, bytes: segment });
    } else if (
      marker === 0xe1 &&
      policy.keepOrientation &&
      orientation === null &&
      startsWith(data, EXIF_ID)
    ) {
      orientation = orientationOf(data.subarray(EXIF_ID.length));
    }
    at += 2 + length;
  }
  if (!ended || !frame || !scanned) return null;
  const exif: { jfif: boolean; bytes: Buffer }[] = [];
  if (orientation !== null) {
    const tiff = orientationTiff(orientation);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(0xffe1, 0);
    head.writeUInt16BE(2 + EXIF_ID.length + tiff.length, 2);
    exif.push({ jfif: false, bytes: Buffer.concat([head, EXIF_ID, tiff]) });
  }
  // The JFIF header stays first, as that format has it; the Exif segment follows it.
  const first = parts[0]?.jfif ? 1 : 0;
  const all = [...parts.slice(0, first), ...exif, ...parts.slice(first)];
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...all.map((each) => each.bytes),
    Buffer.from([0xff, 0xd9]),
  ]);
}
