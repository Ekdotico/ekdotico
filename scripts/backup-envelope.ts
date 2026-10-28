// The envelope of the copy of the backups kept outside DigitalOcean (NFR-RE-10, D118): one file,
// sealed on the host to a public key whose private half the founding team holds offline, so
// that neither the host nor the place that keeps the copy can read it. Used by scripts/backup.ts
// (seal) and scripts/backup-restore.ts (unseal). Node's own `crypto` and nothing else.
//
//   file       = header, ciphertext, tag
//   header     = "EKDBAK01", u16 length of the wrapped key, the wrapped key, a 12-byte IV
//   wrapped    = a fresh 256-bit key under RSA-OAEP with SHA-256, to the public key
//   ciphertext = AES-256-GCM of the archive, the header as additional data
//   tag        = the 16-byte GCM tag, last in the file
//   archive    = entries, then a u16 0
//   entry      = u16 length of the name, the name (UTF-8), chunks, then a u32 0
//   chunk      = u32 length, that many bytes
//
// The tag is checked once, at the end, so what `unseal` has written is not to be believed until
// it returns; it removes everything it wrote when it throws, and when SIGINT or SIGTERM stops it. SIGKILL
// and a loss of power cannot be caught: they leave `.archive.plain`, the plain archive, in the directory
// it was opening into, and whoever stopped it that way removes the directory (procedure 6, step 9).
//
// ponytail: one GCM stream under one key and one IV is sound up to 64 GiB, and the file is stored
// with one request, which takes 5 GiB; a copy past either is refused (CEILING). Seal in segments
// of their own, or store in parts, when the copy grows to that.
import {
  constants,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { rmSync } from 'node:fs';
import { mkdir, open, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

export const MAGIC = Buffer.from('EKDBAK01');
export const MIN_MODULUS_BITS = 3072;
/** The most a copy holds: below the 5 GiB of one request that stores it. */
export const CEILING = 5 * 1024 ** 3 - 1024 * 1024;
const CHUNK = 1024 * 1024;
const TAG_BYTES = 16;
const IV_BYTES = 12;

/** A refusal of the key or of the file, in words; it carries no byte of either. */
export class EnvelopeError extends Error {
  name = 'EnvelopeError';
}

const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/**
 * The key a copy is sealed to. It must be a public key and nothing that holds a private half: a host
 * that holds the private half can read its own copies (NFR-RE-10). RSA of 3,072 bits or more.
 */
export function publicKeyOf(pem: string): KeyObject {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(pem)) {
    // `createPublicKey` would take the public half out of a private key, so the text is looked at first.
    throw new EnvelopeError('The key is a private key: the host must hold the public half alone.');
  }
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch {
    throw new EnvelopeError('The key is not a public key in PEM form.');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new EnvelopeError('The key is not an RSA key.');
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_MODULUS_BITS) {
    throw new EnvelopeError(`The key has ${bits} bits; at least ${MIN_MODULUS_BITS} are required.`);
  }
  return key;
}

/** A pair for the founding team to make on a machine that is not a host of the deployment. */
export function newKeyPair(passphrase: string): { publicKey: string; privateKey: string } {
  if (passphrase.length < 12)
    throw new EnvelopeError('The passphrase of the private key has under 12 characters.');
  return generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase },
  });
}

export interface Entry {
  /** Where it goes when the file is opened: a relative path with no `..`. */
  name: string;
  body: AsyncIterable<Uint8Array>;
}

/**
 * The sealed file, in pieces. Nothing is plain after the first one but the header. Counts what it seals
 * and stops, with a refusal, at the ceiling.
 */
export async function* seal(publicKey: KeyObject, entries: AsyncIterable<Entry>): AsyncGenerator<Buffer> {
  const dataKey = randomBytes(32);
  const iv = randomBytes(IV_BYTES);
  const wrapped = publicEncrypt(
    { key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dataKey,
  );
  const header = Buffer.concat([MAGIC, u16(wrapped.length), wrapped, iv]);
  const cipher = createCipheriv('aes-256-gcm', dataKey, iv);
  cipher.setAAD(header);
  let size = header.length;
  const put = (plain: Buffer): Buffer => {
    const sealed = cipher.update(plain);
    size += sealed.length;
    if (size > CEILING) throw new EnvelopeError('The copy is larger than the one request that stores it.');
    return sealed;
  };

  yield header;
  for await (const entry of entries) {
    checkName(entry.name);
    const name = Buffer.from(entry.name, 'utf8');
    yield put(Buffer.concat([u16(name.length), name]));
    for await (const part of entry.body) {
      const bytes = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
      for (let at = 0; at < bytes.length; at += CHUNK) {
        const piece = bytes.subarray(at, at + CHUNK);
        yield put(Buffer.concat([u32(piece.length), piece]));
      }
    }
    yield put(u32(0));
  }
  yield put(u16(0));
  yield cipher.final();
  yield cipher.getAuthTag();
}

function checkName(name: string): void {
  const bytes = Buffer.byteLength(name, 'utf8');
  const safe = normalize(name);
  if (
    bytes === 0 ||
    bytes > 1024 ||
    name.includes('\0') ||
    name.startsWith('/') ||
    name.includes('\\') ||
    safe !== name ||
    safe.split(sep).includes('..')
  ) {
    throw new EnvelopeError('An entry has a name that is not a plain relative path.');
  }
}

export interface Unsealed {
  /** The entries written, in order, as paths relative to the directory. */
  names: string[];
  bytes: number;
}

/**
 * Opens a file with the private half of the key into `directory`. Writes the plain archive to a file of
 * its own first, so that the tag is checked before anything is cut from it, then cuts it into the entries.
 * On any fault it removes what it wrote, the plain archive among it.
 */
export async function unseal(
  file: string,
  privateKeyPem: string,
  passphrase: string | undefined,
  directory: string,
): Promise<Unsealed> {
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey({ key: privateKeyPem, passphrase });
  } catch {
    throw new EnvelopeError('The private key could not be read; the passphrase may be wrong.');
  }
  const plainPath = join(directory, '.archive.plain');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const written: string[] = [plainPath];
  // An interrupted opening does not leave the plain archive behind (a handler can run only at a signal that can be caught).
  const onSignal = (signal: NodeJS.Signals) => {
    for (const path of written) rmSync(path, { force: true });
    process.exit(128 + (signal === 'SIGINT' ? 2 : 15));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await decryptTo(file, privateKey, plainPath);
    return await cut(plainPath, directory, written);
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await rm(plainPath, { force: true });
  }
}

async function decryptTo(file: string, privateKey: KeyObject, plainPath: string): Promise<void> {
  const { size } = await stat(file);
  const handle = await open(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 2);
    if (size < head.length + IV_BYTES + TAG_BYTES)
      throw new EnvelopeError('The file is too short to be a copy.');
    await handle.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC))
      throw new EnvelopeError('The file is not a copy of this form.');
    const wrappedLength = head.readUInt16BE(MAGIC.length);
    const headerLength = head.length + wrappedLength + IV_BYTES;
    if (headerLength + TAG_BYTES > size) throw new EnvelopeError('The file is too short to be a copy.');
    const header = Buffer.alloc(headerLength);
    await handle.read(header, 0, headerLength, 0);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);

    let dataKey: Buffer;
    try {
      dataKey = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
        header.subarray(head.length, head.length + wrappedLength),
      );
    } catch {
      throw new EnvelopeError('This private key does not open the copy.');
    }
    const decipher = createDecipheriv('aes-256-gcm', dataKey, header.subarray(headerLength - IV_BYTES));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);

    const out = await open(plainPath, 'wx', 0o600);
    try {
      const buffer = Buffer.alloc(CHUNK);
      let at = headerLength;
      const end = size - TAG_BYTES;
      while (at < end) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, end - at), at);
        if (bytesRead === 0) break;
        at += bytesRead;
        await write(out, decipher.update(buffer.subarray(0, bytesRead)));
      }
      try {
        await write(out, decipher.final());
      } catch {
        throw new EnvelopeError('The copy has been changed or is not whole: its tag does not match.');
      }
    } finally {
      await out.close();
    }
  } finally {
    await handle.close();
  }
}

async function write(out: FileHandle, bytes: Buffer): Promise<void> {
  if (bytes.length > 0) await out.write(bytes);
}

async function cut(plainPath: string, directory: string, written: string[]): Promise<Unsealed> {
  const handle = await open(plainPath, 'r');
  const names: string[] = [];
  let position = 0;
  let bytes = 0;
  const take = async (length: number): Promise<Buffer> => {
    const piece = Buffer.alloc(length);
    const { bytesRead } = await handle.read(piece, 0, length, position);
    if (bytesRead !== length) throw new EnvelopeError('The archive ends inside an entry.');
    position += length;
    return piece;
  };
  try {
    for (;;) {
      const nameLength = (await take(2)).readUInt16BE();
      if (nameLength === 0) break;
      const name = (await take(nameLength)).toString('utf8');
      checkName(name);
      const target = join(directory, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const out = await open(target, 'wx', 0o600);
      written.push(target);
      try {
        for (;;) {
          const length = (await take(4)).readUInt32BE();
          if (length === 0) break;
          if (length > CHUNK) throw new EnvelopeError('The archive holds a chunk larger than it writes.');
          const chunk = await take(length);
          bytes += length;
          await write(out, chunk);
        }
      } finally {
        await out.close();
      }
      names.push(name);
    }
  } finally {
    await handle.close();
  }
  return { names, bytes };
}
