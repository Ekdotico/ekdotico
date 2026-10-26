// A ZIP archive written as a stream (FR-EX-36): each entry stored as it is, with its size and checksum in a
// descriptor after its bytes, since neither is known before they have passed; the directory of the archive at the
// end. Nothing is compressed (the images are "stored as they are"), nothing is held but the chunk in hand, and
// nothing is written to a file.
//
// ZIP64 is not written: an entry or an archive of 4 GiB, or 65,535 entries, is refused. A document holds 100 MB of
// images and 5,000 blocks, so none is reached; the refusal is the guard that says so if one ever is.
//
// THE NAMES ARE HELD HERE, not trusted from the caller (docs/plan/slice-21.md, section 4): an archive is opened by
// tools that write what it names wherever it says, so a name that is empty, absolute, a drive, a way up (`..`), a
// backslash, a control character, too long, or a repeat of an earlier one (in any case, since a file system that
// folds case writes both to one file) is refused whole. The names the export makes can be none of these.
import { crc32 } from 'node:zlib';

/** Why an archive could not be written. The messages are fixed and name nothing of the entry (NFR-SE-19). */
export class ZipError extends Error {
  override name = 'ZipError';
  readonly reason: 'name' | 'size' | 'limit';
  constructor(reason: 'name' | 'size' | 'limit') {
    super(
      reason === 'name'
        ? 'an entry has a name an archive may not hold'
        : reason === 'size'
          ? 'an entry is not the size it was said to be'
          : 'the archive is past what it can hold',
    );
    this.reason = reason;
  }
}

export interface ZipEntry {
  name: string;
  /** The bytes of the entry, whole or in chunks. */
  body: Uint8Array | AsyncIterable<Uint8Array>;
  /** The size the entry must have when its bytes have passed; any other is a `ZipError`. */
  size?: number;
}

/** The longest chunk handed on: a longer one is passed in pieces, so that what is waiting for the reader is bounded. */
export const CHUNK_BYTES = 64 * 1024;
/** The most bytes of a name (the field is 16 bits; common tools stop well short of it). */
const NAME_MOST_BYTES = 255;
/** The most any field that would need ZIP64 may hold: past it the archive is refused. */
const U32_MOST = 0xfffffffe;
const ENTRIES_MOST = 0xfffe;

const LOCAL = 0x04034b50;
const DESCRIPTOR = 0x08074b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
// Bit 3: sizes and checksum follow the data. Bit 11: names are UTF-8.
const FLAGS = 0x0808;
// 3 for Unix, and 30 for version 3.0; and a regular file with the mode 0644.
const MADE_BY = (3 << 8) | 30;
const NEEDED = 20;
const MODE_0644 = (0o100644 << 16) >>> 0;

const encoder = new TextEncoder();

/**
 * Throws a `ZipError` for a name an archive may not hold. Exported for the tests, and called by the writer for
 * every entry before one byte of it is written.
 */
export function checkEntryName(name: string): void {
  const bytes = name.isWellFormed() ? encoder.encode(name).byteLength : Infinity;
  if (
    name === '' ||
    bytes > NAME_MOST_BYTES ||
    name.startsWith('/') ||
    name.includes('\\') ||
    /^[A-Za-z]:/u.test(name) ||
    /\p{Cc}/u.test(name) ||
    name.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new ZipError('name');
  }
}

function dosTime(now: Date): { time: number; date: number } {
  const year = Math.min(2107, Math.max(1980, now.getUTCFullYear()));
  return {
    time: (now.getUTCHours() << 11) | (now.getUTCMinutes() << 5) | (now.getUTCSeconds() >> 1),
    date: ((year - 1980) << 9) | ((now.getUTCMonth() + 1) << 5) | now.getUTCDate(),
  };
}

/** A record of `fixed` bytes written by `write`, then the name where the record has one. */
function record(fixed: number, write: (view: DataView) => void, name?: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(fixed + (name?.byteLength ?? 0));
  write(new DataView(bytes.buffer));
  if (name) bytes.set(name, fixed);
  return bytes;
}

function* pieces(chunk: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < chunk.byteLength; at += CHUNK_BYTES) yield chunk.subarray(at, at + CHUNK_BYTES);
}

/**
 * The archive of these entries, in chunks, in order. The entries are taken one at a time and the body of one is read
 * as it is passed on, so nothing is read ahead of the reader but what it asks for.
 */
export async function* zip(
  entries: Iterable<ZipEntry> | AsyncIterable<ZipEntry>,
  now: Date = new Date(),
): AsyncGenerator<Uint8Array> {
  const { time, date } = dosTime(now);
  const seen = new Set<string>();
  const directory: { name: Uint8Array; crc: number; size: number; offset: number }[] = [];
  let offset = 0;
  /** Counts the bytes handed on, and refuses the archive that passes what its offsets can hold. */
  const emit = (bytes: Uint8Array): Uint8Array => {
    offset += bytes.byteLength;
    if (offset > U32_MOST) throw new ZipError('limit');
    return bytes;
  };

  for await (const entry of entries) {
    checkEntryName(entry.name);
    const folded = entry.name.toLowerCase();
    if (seen.has(folded)) throw new ZipError('name');
    seen.add(folded);
    if (directory.length >= ENTRIES_MOST) throw new ZipError('limit');

    const name = encoder.encode(entry.name);
    const start = offset;
    yield emit(
      record(
        30,
        (view) => {
          view.setUint32(0, LOCAL, true);
          view.setUint16(4, NEEDED, true);
          view.setUint16(6, FLAGS, true);
          view.setUint16(8, 0, true);
          view.setUint16(10, time, true);
          view.setUint16(12, date, true);
          // The checksum and the two sizes (14 to 25) are 0 here: the descriptor has them.
          view.setUint16(26, name.byteLength, true);
          view.setUint16(28, 0, true);
        },
        name,
      ),
    );

    let crc = 0;
    let size = 0;
    const body = entry.body instanceof Uint8Array ? [entry.body] : entry.body;
    for await (const chunk of body) {
      for (const piece of pieces(chunk)) {
        crc = crc32(piece, crc);
        size += piece.byteLength;
        yield emit(piece);
      }
    }
    if (entry.size !== undefined && size !== entry.size) throw new ZipError('size');

    yield emit(
      record(16, (view) => {
        view.setUint32(0, DESCRIPTOR, true);
        view.setUint32(4, crc, true);
        view.setUint32(8, size, true);
        view.setUint32(12, size, true);
      }),
    );
    directory.push({ name, crc, size, offset: start });
  }

  const directoryStart = offset;
  for (const { name, crc, size, offset: at } of directory) {
    yield emit(
      record(
        46,
        (view) => {
          view.setUint32(0, CENTRAL, true);
          view.setUint16(4, MADE_BY, true);
          view.setUint16(6, NEEDED, true);
          view.setUint16(8, FLAGS, true);
          view.setUint16(10, 0, true);
          view.setUint16(12, time, true);
          view.setUint16(14, date, true);
          view.setUint32(16, crc, true);
          view.setUint32(20, size, true);
          view.setUint32(24, size, true);
          view.setUint16(28, name.byteLength, true);
          view.setUint32(38, MODE_0644, true);
          view.setUint32(42, at, true);
        },
        name,
      ),
    );
  }
  const directoryBytes = offset - directoryStart;
  yield emit(
    record(22, (view) => {
      view.setUint32(0, END, true);
      view.setUint16(8, directory.length, true);
      view.setUint16(10, directory.length, true);
      view.setUint32(12, directoryBytes, true);
      view.setUint32(16, directoryStart, true);
    }),
  );
}
