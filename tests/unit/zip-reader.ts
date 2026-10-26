// A reader of ZIP archives for the tests of the export (src/lib/export/zip.ts), written from the format and not from
// the writer: the end record from the end of the archive, the directory it points to, each local header it points
// to, the data, the descriptor behind it, and the checksum of what was read. It refuses anything out of order.
import { crc32 } from 'node:zlib';

export interface ReadEntry {
  name: string;
  bytes: Buffer;
  /** The flags of the entry, as both headers write them. */
  flags: number;
  method: number;
  /** The mode in the upper half of the external attributes. */
  mode: number;
  /** The modification time of the extended timestamp field (0x5455), in seconds since 1970, or null where there is none. */
  mtime: number | null;
}

const U = (buffer: Buffer, at: number) => buffer.readUInt32LE(at);
const S = (buffer: Buffer, at: number) => buffer.readUInt16LE(at);

/** The extra fields of a header, by id, each checked to lie inside the field that holds them. */
function extraFields(archive: Buffer, from: number, length: number): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let at = from;
  while (at < from + length) {
    if (at + 4 > from + length) throw new Error('an extra field without its header');
    const id = S(archive, at);
    const size = S(archive, at + 2);
    if (at + 4 + size > from + length) throw new Error('an extra field longer than the extra data');
    if (fields.has(id)) throw new Error('an extra field twice');
    fields.set(id, archive.subarray(at + 4, at + 4 + size));
    at += 4 + size;
  }
  return fields;
}

/** The modification time of an extended timestamp field (flags, then the time if the first bit is set). */
function mtimeOf(fields: Map<number, Buffer>): number | null {
  const field = fields.get(0x5455);
  if (!field) return null;
  if (field.length !== 5 || field[0] !== 1)
    throw new Error('an extended timestamp that is not flags and a time');
  return field.readUInt32LE(1);
}

/** Collects a stream or any async iterable of chunks into one buffer. */
export async function collect(
  chunks: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  if ('getReader' in chunks) {
    const reader = chunks.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
  } else {
    for await (const chunk of chunks) parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export function readZip(archive: Buffer): ReadEntry[] {
  // The end record is the last 22 bytes: the writer writes no comment.
  const end = archive.length - 22;
  if (end < 0 || U(archive, end) !== 0x06054b50) throw new Error('no end record');
  if (S(archive, end + 20) !== 0) throw new Error('a comment');
  const count = S(archive, end + 10);
  if (S(archive, end + 8) !== count || S(archive, end + 4) !== 0 || S(archive, end + 6) !== 0) {
    throw new Error('the end record is not of a single disk');
  }
  const size = U(archive, end + 12);
  const start = U(archive, end + 16);
  if (start + size !== end) throw new Error('the directory does not end where the end record begins');

  const entries: ReadEntry[] = [];
  let at = start;
  let expectedLocal = 0;
  for (let n = 0; n < count; n += 1) {
    if (U(archive, at) !== 0x02014b50) throw new Error('no central header');
    const flags = S(archive, at + 8);
    const method = S(archive, at + 10);
    const crc = U(archive, at + 16);
    const compressed = U(archive, at + 20);
    const length = U(archive, at + 24);
    const nameLength = S(archive, at + 28);
    const extraLength = S(archive, at + 30);
    const commentLength = S(archive, at + 32);
    const mode = U(archive, at + 38) >>> 16;
    const local = U(archive, at + 42);
    const name = archive.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const centralMtime = mtimeOf(extraFields(archive, at + 46 + nameLength, extraLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (method !== 0 || compressed !== length) throw new Error(`${name}: not stored`);
    if ((flags & 0x0800) === 0) throw new Error(`${name}: the name is not marked UTF-8`);
    if (local !== expectedLocal) throw new Error(`${name}: the entries are not one after another`);
    if (U(archive, local) !== 0x04034b50) throw new Error(`${name}: no local header`);
    if (S(archive, local + 6) !== flags) throw new Error(`${name}: the two headers differ in flags`);
    if (S(archive, local + 26) !== nameLength) throw new Error(`${name}: the two headers differ in the name`);
    const localName = archive.subarray(local + 30, local + 30 + nameLength).toString('utf8');
    if (localName !== name) throw new Error(`${name}: the two headers name different files`);
    const localExtra = S(archive, local + 28);
    const localMtime = mtimeOf(extraFields(archive, local + 30 + nameLength, localExtra));
    if (localMtime !== centralMtime)
      throw new Error(`${name}: the two headers differ in the modification time`);
    const data = local + 30 + nameLength + localExtra;
    const bytes = archive.subarray(data, data + length);
    // The descriptor with its signature, behind the data.
    if ((flags & 0x0008) === 0) throw new Error(`${name}: no descriptor`);
    const descriptor = data + length;
    if (U(archive, descriptor) !== 0x08074b50) throw new Error(`${name}: no descriptor signature`);
    if (
      U(archive, descriptor + 4) !== crc ||
      U(archive, descriptor + 8) !== length ||
      U(archive, descriptor + 12) !== length
    ) {
      throw new Error(`${name}: the descriptor differs from the directory`);
    }
    if (crc32(bytes) !== crc) throw new Error(`${name}: the checksum is wrong`);
    expectedLocal = descriptor + 16;
    entries.push({ name, bytes: Buffer.from(bytes), flags, method, mode, mtime: centralMtime });
  }
  if (at !== end) throw new Error('bytes between the directory and the end record');
  if (expectedLocal !== start) throw new Error('bytes between the last entry and the directory');
  return entries;
}
