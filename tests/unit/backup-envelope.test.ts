// The envelope of the copy of the backups (NFR-RE-10, D118; docs/plan/slice-27.md, S27-10): what is
// sealed on the host opens only with the private half, and a copy that was changed opens as nothing.
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  EnvelopeError,
  MAGIC,
  publicKeyOf,
  seal,
  unseal,
  type Entry,
} from '../../scripts/backup-envelope.ts';

const PASSPHRASE = 'a passphrase that only a test uses';
const pair = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
});
const other = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const work = mkdtempSync(join(tmpdir(), 'ekdotico-envelope-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

async function* bodyOf(...parts: Uint8Array[]) {
  for (const part of parts) yield part;
}

async function sealed(entries: Entry[], publicKey = pair.publicKey): Promise<Buffer> {
  const pieces: Buffer[] = [];
  async function* all() {
    yield* entries;
  }
  for await (const piece of seal(publicKeyOf(publicKey), all())) pieces.push(piece);
  return Buffer.concat(pieces);
}

const MARKER = 'a-sentence-that-no-copy-may-show';
const BIG = randomBytes(3 * 1024 * 1024 + 17);
const entries = (): Entry[] => [
  { name: 'dump.pgdump', body: bodyOf(Buffer.from(MARKER), Buffer.from(` and ${MARKER}`)) },
  { name: 'images/0f0e0d0c/abc', body: bodyOf(BIG) },
  { name: 'empty', body: bodyOf() },
  { name: 'manifest-ünï.json', body: bodyOf(Buffer.from('{}')) },
];

function folder() {
  return mkdtempSync(join(work, 'out-'));
}

describe('publicKeyOf', () => {
  it('takes an RSA public key of 3,072 bits', () => {
    expect(publicKeyOf(pair.publicKey).asymmetricKeyType).toBe('rsa');
  });

  it('refuses a private key, whatever else it is', () => {
    expect(() => publicKeyOf(other.privateKey)).toThrow(/private key/);
    expect(() => publicKeyOf(`${pair.publicKey}\n${other.privateKey}`)).toThrow(/private key/);
  });

  it('refuses an RSA key of 2,048 bits', () => {
    const small = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() => publicKeyOf(small.publicKey)).toThrow(/2048 bits; at least 3072/);
  });

  it('refuses a key that is not RSA, and text that is no key', () => {
    const ed = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    expect(() => publicKeyOf(ed.publicKey)).toThrow(/not an RSA key/);
    expect(() => publicKeyOf('not a key')).toThrow(/not a public key/);
    expect(() => publicKeyOf('')).toThrow(EnvelopeError);
  });
});

describe('seal and unseal', () => {
  it('opens to the same entries, byte for byte, with the private half', async () => {
    const file = join(work, 'round-trip.ekdbak');
    writeFileSync(file, await sealed(entries()));
    const out = folder();
    const result = await unseal(file, pair.privateKey, PASSPHRASE, out);
    expect(result.names).toEqual(['dump.pgdump', 'images/0f0e0d0c/abc', 'empty', 'manifest-ünï.json']);
    expect(readFileSync(join(out, 'dump.pgdump'), 'utf8')).toBe(`${MARKER} and ${MARKER}`);
    expect(readFileSync(join(out, 'images/0f0e0d0c/abc')).equals(BIG)).toBe(true);
    expect(readFileSync(join(out, 'empty')).length).toBe(0);
    expect(readFileSync(join(out, 'manifest-ünï.json'), 'utf8')).toBe('{}');
    // The plain archive that the opening made is not left beside them.
    expect(readdirSync(out).sort()).toEqual(['dump.pgdump', 'empty', 'images', 'manifest-ünï.json']);
  });

  it('shows nothing of the content in the file, and begins with its name', async () => {
    const file = await sealed(entries());
    expect(file.subarray(0, MAGIC.length).equals(MAGIC)).toBe(true);
    expect(file.includes(Buffer.from(MARKER))).toBe(false);
    expect(file.includes(Buffer.from('dump.pgdump'))).toBe(false);
    expect(file.includes(BIG.subarray(1000, 1064))).toBe(false);
  });

  it('is not the same file twice: each seal has a key and an IV of its own', async () => {
    const a = await sealed(entries());
    const b = await sealed(entries());
    expect(a.equals(b)).toBe(false);
  });

  it('is not opened by another private key, nor by a wrong passphrase, and writes nothing', async () => {
    const file = join(work, 'other-key.ekdbak');
    writeFileSync(file, await sealed(entries()));
    const out = folder();
    await expect(unseal(file, other.privateKey, undefined, out)).rejects.toThrow(/does not open the copy/);
    await expect(unseal(file, pair.privateKey, 'not the passphrase', out)).rejects.toThrow(
      /passphrase may be wrong/,
    );
    expect(readdirSync(out)).toEqual([]);
  });

  it('is refused when one byte of the ciphertext is changed, and leaves nothing written', async () => {
    const file = await sealed(entries());
    const at = Math.floor(file.length / 2);
    file[at] = file[at]! ^ 0x01;
    const path = join(work, 'flipped.ekdbak');
    writeFileSync(path, file);
    const out = folder();
    await expect(unseal(path, pair.privateKey, PASSPHRASE, out)).rejects.toThrow(/tag does not match/);
    expect(readdirSync(out)).toEqual([]);
  });

  it('is refused when the header is changed, which the tag covers', async () => {
    const file = await sealed(entries());
    // The last byte of the IV, which the wrapped key does not cover.
    const wrappedLength = file.readUInt16BE(MAGIC.length);
    const at = MAGIC.length + 2 + wrappedLength + 11;
    file[at] = file[at]! ^ 0x01;
    const path = join(work, 'iv.ekdbak');
    writeFileSync(path, file);
    await expect(unseal(path, pair.privateKey, PASSPHRASE, folder())).rejects.toThrow(EnvelopeError);
  });

  it('is refused when it is cut short, and when it is not a copy', async () => {
    const file = await sealed(entries());
    const cut = join(work, 'cut.ekdbak');
    writeFileSync(cut, file.subarray(0, file.length - 40));
    await expect(unseal(cut, pair.privateKey, PASSPHRASE, folder())).rejects.toThrow(EnvelopeError);
    const text = join(work, 'text.ekdbak');
    writeFileSync(text, 'this is not a copy of the backups, however long it is made to be');
    await expect(unseal(text, pair.privateKey, PASSPHRASE, folder())).rejects.toThrow(
      /not a copy of this form/,
    );
  });

  it.each(['', '../x', '/abs', 'a//b', 'a/../b', 'a\\b', 'a\0b', './a'])(
    'does not seal an entry named %j',
    async (name) => {
      await expect(sealed([{ name, body: bodyOf(Buffer.from('x')) }])).rejects.toThrow(
        /not a plain relative path/,
      );
    },
  );
});

describe('what an opening that fails leaves behind', () => {
  it('nothing: a copy that is validly sealed and that the cutting rejects (an entry twice) leaves the directory empty', async () => {
    const file = join(work, 'twice.ekdbak');
    writeFileSync(
      file,
      await sealed([
        { name: 'dump.pgdump', body: bodyOf(Buffer.from('one')) },
        { name: 'dump.pgdump', body: bodyOf(Buffer.from('two')) },
      ]),
    );
    const out = folder();
    // The tag is right, the plain archive is written, and then the second entry of the name cannot be made.
    await expect(unseal(file, pair.privateKey, PASSPHRASE, out)).rejects.toThrow();
    expect(readdirSync(out)).toEqual([]);
  });

  it('nothing, when SIGTERM stops it in the middle: the plain archive is removed and the status is 143', async () => {
    // A copy of 300 MB, so that the opening is still under way when the signal comes.
    async function* large() {
      yield { name: 'big', body: bodyOf(...Array.from({ length: 300 }, () => randomBytes(1024 * 1024))) };
    }
    const file = join(work, 'large.ekdbak');
    const pieces: Buffer[] = [];
    for await (const piece of seal(publicKeyOf(pair.publicKey), large())) pieces.push(piece);
    writeFileSync(file, Buffer.concat(pieces));
    const keyFile = join(work, 'key.pem');
    writeFileSync(keyFile, pair.privateKey, { mode: 0o600 });
    const out = folder();
    const child = spawn('node', ['tests/fixtures/open-archive.ts', file, keyFile, out], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH!, KEY_PASSPHRASE: PASSPHRASE } as NodeJS.ProcessEnv,
      stdio: 'ignore',
    });
    const status = new Promise<number | null>((resolve) => child.once('close', resolve));
    const began = Date.now();
    while (!readdirSync(out).includes('.archive.plain') && Date.now() - began < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(readdirSync(out)).toContain('.archive.plain');
    child.kill('SIGTERM');
    expect(await status).toBe(143);
    expect(readdirSync(out)).toEqual([]);
  }, 60_000);
});
