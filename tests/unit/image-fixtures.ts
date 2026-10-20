// Images built from bytes, for the tests of the removal of metadata
// (src/lib/images/metadata/): no binary file is committed, and each kind of
// metadata is a part that a test names, so that what a remover keeps or drops
// can be read off the result. The pictures are one pixel; what matters to a
// remover is the container, and the data of the picture is copied untouched,
// which each test shows by finding the same bytes in what comes out.
import { crc32, deflateSync } from 'node:zlib';

/** What the tests look for in an output: text that must never survive the removal. */
export const SECRET = 'Secret-Phone-Model-1234';
export const GPS_MARK = 'GPSLatitudeRefTag';

// ── Exif ─────────────────────────────────────────────────────────────────────

/**
 * The TIFF structure of an Exif block of a photograph taken with a phone: the
 * make of the device (text), the orientation, and a pointer to the location
 * directory. Little-endian, or big-endian where `big` is true.
 */
export function exifTiff(orientation: number | null, big = false): Buffer {
  const write16 = (buffer: Buffer, value: number, at: number) =>
    big ? buffer.writeUInt16BE(value, at) : buffer.writeUInt16LE(value, at);
  const write32 = (buffer: Buffer, value: number, at: number) =>
    big ? buffer.writeUInt32BE(value, at) : buffer.writeUInt32LE(value, at);
  const entries = orientation === null ? 2 : 3;
  const ifdLength = 2 + entries * 12 + 4;
  const text = Buffer.from(`${SECRET}\0`, 'latin1');
  const textAt = 8 + ifdLength;
  const gpsAt = textAt + text.length + (text.length % 2);
  const gps = Buffer.alloc(2 + 12 + 4);
  write16(gps, 1, 0);
  write16(gps, 1, 2); // GPSLatitudeRef
  write16(gps, 2, 4); // ASCII
  write32(gps, 2, 6);
  gps.write('N\0', 10, 'latin1');
  const tiff = Buffer.alloc(gpsAt + gps.length);
  tiff.write(big ? 'MM' : 'II', 0, 'latin1');
  write16(tiff, 42, 2);
  write32(tiff, 8, 4);
  write16(tiff, entries, 8);
  let at = 10;
  const entry = (tag: number, type: number, count: number, value: (to: number) => void) => {
    write16(tiff, tag, at);
    write16(tiff, type, at + 2);
    write32(tiff, count, at + 4);
    value(at + 8);
    at += 12;
  };
  entry(0x010f, 2, text.length, (to) => write32(tiff, textAt, to));
  if (orientation !== null) entry(0x0112, 3, 1, (to) => write16(tiff, orientation, to));
  entry(0x8825, 4, 1, (to) => write32(tiff, gpsAt, to));
  text.copy(tiff, textAt);
  gps.copy(tiff, gpsAt);
  return Buffer.concat([tiff, Buffer.from(GPS_MARK, 'latin1')]);
}

// ── PNG ──────────────────────────────────────────────────────────────────────

export function pngChunk(type: string, data: Uint8Array = Buffer.alloc(0), crc?: number): Buffer {
  const made = Buffer.alloc(12 + data.length);
  made.writeUInt32BE(data.length, 0);
  made.write(type, 4, 'latin1');
  made.set(data, 8);
  made.writeUInt32BE(crc ?? crc32(made.subarray(4, 8 + data.length)), 8 + data.length);
  return made;
}

/** The data of the picture: one pixel, as a decoder would read it. Tests look for this chunk in the output. */
export const PNG_IDAT = pngChunk('IDAT', deflateSync(Buffer.from([0, 200, 100, 50])));

export function png(
  parts: { before?: Buffer[]; after?: Buffer[]; tail?: Buffer; ihdr?: Buffer } = {},
): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    parts.ihdr ?? pngChunk('IHDR', header),
    ...(parts.before ?? []),
    PNG_IDAT,
    ...(parts.after ?? []),
    pngChunk('IEND'),
    parts.tail ?? Buffer.alloc(0),
  ]);
}

// ── JPEG ─────────────────────────────────────────────────────────────────────

export function jpegSegment(marker: number, payload: Uint8Array): Buffer {
  const made = Buffer.alloc(4 + payload.length);
  made[0] = 0xff;
  made[1] = marker;
  made.writeUInt16BE(2 + payload.length, 2);
  made.set(payload, 4);
  return made;
}

export const JFIF_THUMBNAIL = Buffer.from('THUMBNAIL-RGB-DATA-HERE!', 'latin1');
export function jfif(thumbnail = false): Buffer {
  const head = Buffer.from([
    0x4a,
    0x46,
    0x49,
    0x46,
    0,
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    thumbnail ? 2 : 0,
    thumbnail ? 4 : 0,
  ]);
  return jpegSegment(0xe0, thumbnail ? Buffer.concat([head, JFIF_THUMBNAIL]) : head);
}

/** The scan: its header and entropy-coded data with a stuffed byte and a restart marker in it. Tests look for this in the output. */
export const JPEG_SCAN = Buffer.concat([
  jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0x00, 0x78]),
]);

const FRAME = Buffer.concat([
  jpegSegment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 16)])),
  jpegSegment(0xc0, Buffer.from([8, 0, 1, 0, 1, 1, 1, 0x11, 0])),
  jpegSegment(
    0xc4,
    Buffer.concat([Buffer.from([0]), Buffer.from([1, ...Array(15).fill(0)]), Buffer.from([0])]),
  ),
]);
export const JPEG_FRAME = FRAME;

export function jpeg(
  parts: { first?: Buffer[]; before?: Buffer[]; after?: Buffer[]; tail?: Buffer } = {},
): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(parts.first ?? []),
    ...(parts.before ?? []),
    FRAME,
    ...(parts.after ?? []),
    JPEG_SCAN,
    Buffer.from([0xff, 0xd9]),
    parts.tail ?? Buffer.alloc(0),
  ]);
}

export const exifSegment = (tiff: Buffer) =>
  jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]));
export const xmpSegment = () =>
  jpegSegment(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${SECRET}</x:xmpmeta>`, 'latin1'));
export const iccSegment = () =>
  jpegSegment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01PROFILE-BYTES', 'latin1'));
export const adobeSegment = () => jpegSegment(0xee, Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1'));

// ── GIF ──────────────────────────────────────────────────────────────────────

export const GIF_FRAME = Buffer.concat([
  Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0]), // image descriptor, no local table
  Buffer.from([2, 2, 0x44, 0x01, 0]), // minimum code size, one sub-block, terminator
]);
export const GIF_CONTROL = Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0, 0]);

/** An extension block: label, then the sub-blocks of `data` (at most 255 bytes), then the terminator. */
export function gifExtension(label: number, data: Buffer, first?: Buffer): Buffer {
  const blocks = [first, data].filter((each): each is Buffer => each !== undefined);
  return Buffer.concat([
    Buffer.from([0x21, label]),
    ...blocks.flatMap((block) => [Buffer.from([block.length]), block]),
    Buffer.from([0]),
  ]);
}
export const gifComment = () => gifExtension(0xfe, Buffer.from(SECRET, 'latin1'));
export const gifXmp = () =>
  gifExtension(0xff, Buffer.from(SECRET, 'latin1'), Buffer.from('XMP DataXMP', 'latin1'));
export const gifLoop = () => gifExtension(0xff, Buffer.from([1, 0, 0]), Buffer.from('NETSCAPE2.0', 'latin1'));
export const gifPlainText = () => gifExtension(0x01, Buffer.from(SECRET, 'latin1'), Buffer.alloc(12));

export function gif(
  parts: { before?: Buffer[]; frames?: Buffer[]; after?: Buffer[]; tail?: Buffer } = {},
): Buffer {
  return Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    Buffer.from([1, 0, 1, 0, 0x80, 0, 0]), // 1 x 1, a global table of two colours
    Buffer.from([0, 0, 0, 255, 255, 255]),
    ...(parts.before ?? []),
    ...(parts.frames ?? [GIF_CONTROL, GIF_FRAME]),
    ...(parts.after ?? []),
    Buffer.from([0x3b]),
    parts.tail ?? Buffer.alloc(0),
  ]);
}

// ── WebP ─────────────────────────────────────────────────────────────────────

export function webpChunk(type: string, data: Uint8Array): Buffer {
  const made = Buffer.alloc(8 + data.length + (data.length % 2));
  made.write(type, 0, 'latin1');
  made.writeUInt32LE(data.length, 4);
  made.set(data, 8);
  return made;
}

/** The data of the picture. Tests look for this chunk in the output. */
export const WEBP_PICTURE = webpChunk('VP8L', Buffer.from([0x2f, 0, 0, 0, 0, 0x10, 0x20, 0x30, 0x40]));

export function vp8x(flags: number): Buffer {
  const data = Buffer.alloc(10);
  data[0] = flags;
  return webpChunk('VP8X', data);
}

export function webp(chunks: Buffer[] | null = null, tail = Buffer.alloc(0), size?: number): Buffer {
  const body = Buffer.concat(chunks ?? [WEBP_PICTURE]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(size ?? 4 + body.length, 4);
  head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body, tail]);
}
