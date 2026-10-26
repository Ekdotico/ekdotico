// The archive the draft export streams (FR-EX-36; docs/plan/slice-21.md, section 4): its form, read back by a
// reader written from the format (./zip-reader.ts) and by the system's own `unzip` where there is one; and the
// rules for a name, one test each, since a name that gets through is a file written where the archive chooses.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, ZipError, checkEntryName, zip, type ZipEntry } from '../../src/lib/export/zip.ts';
import { collect, readZip } from './zip-reader.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const NOW = new Date(Date.UTC(2026, 9, 26, 13, 45, 30));
const archive = (entries: ZipEntry[], now = NOW) => collect(zip(entries, now));

async function* chunked(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < data.length; at += size) yield data.subarray(at, at + size);
}
const random = (length: number) => {
  let seed = 7;
  return Uint8Array.from({ length }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 24;
  });
};

describe('the form of the archive', () => {
  it('holds each entry stored, in order, with a descriptor, and a directory that agrees', async () => {
    const image = random(5000);
    const read = readZip(
      await archive([
        { name: 'Thesis.md', body: bytes('# Title\n') },
        { name: 'images/001.png', body: image },
      ]),
    );
    expect(read.map((each) => each.name)).toEqual(['Thesis.md', 'images/001.png']);
    expect(read[0]!.bytes.toString()).toBe('# Title\n');
    expect(Buffer.compare(read[1]!.bytes, Buffer.from(image))).toBe(0);
    // UTF-8 names, a descriptor, stored, a regular file of mode 0644.
    for (const each of read) expect([each.flags, each.method, each.mode]).toEqual([0x0808, 0, 0o100644]);
  });

  it('says the modification time exactly, in both headers, as the extended timestamp field (N3)', async () => {
    const read = readZip(
      await archive([
        { name: 'a.md', body: bytes('a') },
        { name: 'images/001.png', body: bytes('b') },
      ]),
    );
    // The reader refuses an archive whose two headers differ in it; here it is the time of the export, in UTC.
    for (const each of read) expect(each.mtime).toBe(Math.floor(NOW.getTime() / 1000));
  });

  it('asks a reader no faster than 16 KiB in the idle period (N1)', () => {
    expect(CHUNK_BYTES).toBe(16 * 1024);
  });

  it('is an archive of no entry where there is none', async () => {
    const data = await archive([]);
    expect(data).toHaveLength(22);
    expect(readZip(data)).toEqual([]);
  });

  it('holds an entry of no bytes, of one byte, and of many bytes passed in chunks of any size', async () => {
    const big = random(200_000);
    const sizes = [1, 3, 1000, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 150_000, 200_000];
    for (const size of sizes) {
      const read = readZip(
        await archive([
          { name: 'empty', body: new Uint8Array() },
          { name: 'one', body: new Uint8Array([9]) },
          { name: 'big', body: chunked(big, size), size: big.length },
        ]),
      );
      expect(
        read.map((each) => each.bytes.length),
        `chunks of ${size}`,
      ).toEqual([0, 1, 200_000]);
      expect(Buffer.compare(read[2]!.bytes, Buffer.from(big)), `chunks of ${size}`).toBe(0);
    }
  });

  it('passes on no chunk longer than CHUNK_BYTES, so that what waits for the reader is bounded', async () => {
    const longest = (async () => {
      let most = 0;
      for await (const chunk of zip([{ name: 'a', body: random(1_000_000) }], NOW)) {
        most = Math.max(most, chunk.byteLength);
      }
      return most;
    })();
    expect(await longest).toBeLessThanOrEqual(CHUNK_BYTES);
  });

  it('writes the names in UTF-8, flagged as such', async () => {
    const name = 'Εκδοτικό 論文 📚.md';
    const read = readZip(await archive([{ name, body: bytes('x') }]));
    expect(read[0]!.name).toBe(name);
    expect(read[0]!.flags & 0x0800).toBe(0x0800);
  });

  it('is read by the system`s unzip, where there is one', async () => {
    const found = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
    if (found.error) return; // No `unzip` on this machine: the reader above is the check.
    const dir = mkdtempSync(join(tmpdir(), 'ekdotico-zip-'));
    try {
      const image = random(70_000);
      const file = join(dir, 'out.zip');
      writeFileSync(
        file,
        await archive([
          { name: 'Εκδοτικό.md', body: bytes('text') },
          { name: 'images/001.png', body: chunked(image, 4096), size: image.length },
        ]),
      );
      const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
      expect(test.status, test.stdout + test.stderr).toBe(0);
      expect(test.stdout).toContain('No errors detected');
      const out = join(dir, 'out');
      const extract = spawnSync('unzip', ['-q', file, '-d', out], { encoding: 'utf8' });
      expect(extract.status, extract.stderr).toBe(0);
      expect(readFileSync(join(out, 'images', '001.png')).equals(Buffer.from(image))).toBe(true);
      // The extended timestamp (N3): in a time zone 13 hours east of UTC the listing says 02:45 on the 27th, where the
      // DOS time alone would have said 13:45 on the 26th, whatever zone it was made in.
      const listing = spawnSync('unzip', ['-l', file], {
        encoding: 'utf8',
        env: { ...process.env, TZ: 'Pacific/Auckland' },
      });
      expect(listing.stdout).toMatch(/(2026-10-27|10-27-2026) +02:45/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stamps the time of the export, in UTC, and no earlier than the format can say', async () => {
    const data = await archive([{ name: 'a', body: bytes('x') }]);
    // The local header: time at 10, date at 12.
    expect(data.readUInt16LE(10)).toBe((13 << 11) | (45 << 5) | 15);
    expect(data.readUInt16LE(12)).toBe(((2026 - 1980) << 9) | (10 << 5) | 26);
    const early = await archive([{ name: 'a', body: bytes('x') }], new Date(Date.UTC(1970, 0, 1)));
    expect(early.readUInt16LE(12) >> 9).toBe(0);
  });
});

describe('the names of the entries', () => {
  const refused = [
    ['empty', ''],
    ['absolute', '/etc/passwd'],
    ['absolute, one level', '/x'],
    ['an empty segment', 'a//b'],
    ['a trailing slash', 'a/'],
    ['the current directory', '.'],
    ['the parent directory', '..'],
    ['a way up', '../x'],
    ['a way up in the middle', 'a/../b'],
    ['a way up at the end', 'a/..'],
    ['a dot segment', 'a/./b'],
    ['a backslash', 'a\\b'],
    ['a way up by backslash', '..\\x'],
    ['a drive', 'C:x'],
    ['a drive and a path', 'c:/x'],
    ['a NUL', 'a\u0000b'],
    ['a line break', 'a\nb'],
    ['a tab', 'a\tb'],
    ['a control character of the second block', 'a\u0085b'],
    ['a lone surrogate', 'a\ud800b'],
    ['256 bytes', 'x'.repeat(256)],
    ['256 bytes in UTF-8 of fewer characters', '論'.repeat(86)],
  ] as const;

  it.each(refused)('refuses %s', async (_, name) => {
    expect(() => checkEntryName(name)).toThrow(ZipError);
    // And the writer refuses it before it writes a byte of the entry.
    const written: Uint8Array[] = [];
    const run = (async () => {
      for await (const chunk of zip([{ name, body: bytes('x') }], NOW)) written.push(chunk);
    })();
    await expect(run).rejects.toMatchObject({ name: 'ZipError', reason: 'name' });
    expect(written).toHaveLength(0);
  });

  it('refuses a name that repeats an earlier one, and one that differs in case only', async () => {
    for (const second of ['a.md', 'A.MD', 'a.Md']) {
      await expect(
        archive([
          { name: 'a.md', body: bytes('1') },
          { name: second, body: bytes('2') },
        ]),
      ).rejects.toMatchObject({ reason: 'name' });
    }
  });

  it('takes the names the export makes', () => {
    for (const name of [
      'My thesis.md',
      'document.md',
      'images/001.png',
      'images/1000.webp',
      'a.b.c',
      'Εκδοτικό.md',
    ]) {
      expect(() => checkEntryName(name), name).not.toThrow();
    }
    expect(() => checkEntryName('x'.repeat(255))).not.toThrow();
    expect(() => checkEntryName('論'.repeat(85))).not.toThrow();
  });

  it('says nothing of the name it refused', () => {
    try {
      checkEntryName('../secret-title');
      expect.unreachable();
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('secret');
    }
  });
});

describe('the sizes', () => {
  it('refuses an entry that is not the size it was said to be, shorter or longer', async () => {
    for (const said of [9, 11]) {
      await expect(archive([{ name: 'a', body: chunked(random(10), 3), size: said }])).rejects.toMatchObject({
        reason: 'size',
      });
    }
    await expect(archive([{ name: 'a', body: chunked(random(10), 3), size: 10 }])).resolves.toBeDefined();
  });

  it('refuses more entries than the format holds without ZIP64', async () => {
    async function* many(): AsyncGenerator<ZipEntry> {
      for (let n = 0; n < 65_535; n += 1) yield { name: `f${n}`, body: new Uint8Array() };
    }
    await expect(collect(zip(many(), NOW))).rejects.toMatchObject({ reason: 'limit' });
  });

  it('closes the body that is being read when the reader stops', async () => {
    let closed = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      try {
        for (;;) yield new Uint8Array(1000);
      } finally {
        closed = true;
      }
    }
    const generator = zip([{ name: 'a', body: body() }], NOW);
    await generator.next();
    await generator.next();
    await generator.return(undefined);
    expect(closed).toBe(true);
  });
});
