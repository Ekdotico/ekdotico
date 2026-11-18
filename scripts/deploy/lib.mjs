// The parts of the deployment that can be tested without a server (docs/operations/deployment.md, "Deploying a
// release"). Plain Node, no dependency: the same file runs in Actions, on the deployer's machine and on the server.
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  publicEncrypt,
  privateDecrypt,
  randomBytes,
  constants,
} from 'node:crypto';
import { createReadStream } from 'node:fs';

/** A full commit sha, lower case. A short one is refused: a release directory is named by it. */
export function checkSha(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`not a full commit sha (40 lower-case hexadecimal characters): ${JSON.stringify(sha)}`);
  }
  return sha;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Refuses a file whose sha-256 is not the one the manifest gives. */
export async function verifyChecksum(path, expected) {
  if (!/^[0-9a-f]{64}$/.test(expected ?? '')) throw new Error('the manifest gives no sha-256');
  const actual = await sha256File(path);
  if (actual !== expected)
    throw new Error(`checksum mismatch for ${path}: expected ${expected}, got ${actual}`);
}

/**
 * Refuses a manifest that is not for this commit, not marked deployable, or built for another platform, CPU or
 * Node.js major than the one that would run it.
 * @param {any} manifest
 * @param {{ sha: string, platform?: string, arch?: string, node?: string }} here
 */
export function checkManifest(
  manifest,
  { sha, platform = process.platform, arch = process.arch, node = process.version },
) {
  if (manifest?.sha !== checkSha(sha)) throw new Error(`the artifact is of ${manifest?.sha}, not ${sha}`);
  if (manifest.deployable !== true)
    throw new Error(`the artifact is not deployable: ${manifest.reason ?? 'no reason given'}`);
  const major = (v) => String(v).replace(/^v/, '').split('.')[0];
  if (manifest.platform !== platform || manifest.arch !== arch) {
    throw new Error(`built for ${manifest.platform}/${manifest.arch}, this is ${platform}/${arch}`);
  }
  if (major(manifest.node) !== major(node))
    throw new Error(`built with Node.js ${manifest.node}, this is ${node}`);
  return manifest;
}

/**
 * The release directories to delete: every one but the `keep` newest, and never the one `current` points at or the
 * one `previous` points at (the rollback). `entries` are `{ name, mtimeMs }` of the directories under releases/.
 * @param {{ name: string, mtimeMs: number }[]} entries
 * @param {{ keep: number, current?: string | false, previous?: string | false }} options
 */
export function releasesToPrune(entries, { keep, current, previous }) {
  if (!Number.isInteger(keep) || keep < 2)
    throw new Error('keep at least 2 releases: the running one and the one to roll back to');
  const held = new Set([current, previous].filter(Boolean));
  const newestFirst = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return newestFirst
    .slice(keep)
    .map((entry) => entry.name)
    .filter((name) => !held.has(name));
}

// The build output holds Next.js's preview identifier (deployment.md, "The build output is kept as a secret is"),
// and the artifacts of a public repository can be downloaded by anyone signed in to GitHub. So a release for
// deployment is sealed to the deployer's public key: AES-256-GCM under a fresh key, the key wrapped with RSA-OAEP
// (SHA-256). Layout: 4-byte length of the wrapped key, the wrapped key, 12-byte IV, 16-byte tag, ciphertext.
// ponytail: the whole file is held in memory (a few hundred MB); stream it if releases outgrow the machines.

export function seal(plaintext, publicKeyPem) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const wrapped = publicEncrypt(
    { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    key,
  );
  const length = Buffer.alloc(4);
  length.writeUInt32BE(wrapped.length);
  return Buffer.concat([length, wrapped, iv, cipher.getAuthTag(), body]);
}

export function unseal(sealed, privateKeyPem) {
  const n = sealed.readUInt32BE(0);
  const wrapped = sealed.subarray(4, 4 + n);
  const iv = sealed.subarray(4 + n, 16 + n);
  const tag = sealed.subarray(16 + n, 32 + n);
  const key = privateDecrypt(
    { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    wrapped,
  );
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(32 + n)), decipher.final()]);
}

export function keyPair() {
  return generateKeyPairSync('rsa', {
    modulusLength: 4096,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
}

/** `--name value` and `--flag` into an object; anything else is refused, and so is a missing required name. */
/**
 * @param {string[]} argv
 * @param {{ required?: string[], flags?: string[], optional?: string[] }} spec
 * @returns {Record<string, any>}
 */
export function parseArgs(argv, { required = [], flags = [], optional = [] }) {
  const known = new Set([...required, ...flags, ...optional]);
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i].replace(/^--/, '');
    if (!argv[i].startsWith('--') || !known.has(name)) throw new Error(`unknown argument: ${argv[i]}`);
    if (flags.includes(name)) out[name] = true;
    else if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
    else out[name] = argv[++i];
  }
  for (const name of required) if (out[name] === undefined) throw new Error(`--${name} is required`);
  return out;
}

/**
 * The switch, in order, with rollback. `ops` does the work (the server's file system and systemctl, or a test's
 * record of calls): link(target) points `current` at a release atomically, restart() restarts both services,
 * healthy() resolves true when both are active and answer. On a failed check the previous target is linked again
 * and the services restarted; the error says that it rolled back, and whether the rollback itself came up.
 */
export async function switchTo(target, ops) {
  const previous = ops.readCurrent();
  if (previous === target) throw new Error(`${target} is already current`);
  ops.link(target);
  ops.writePrevious(previous);
  await ops.restart();
  if (await ops.healthy()) return { previous, current: target };
  ops.link(previous);
  await ops.restart();
  const back = await ops.healthy();
  throw new Error(
    `${target} failed its check after the restart; switched back to ${previous}, which ${back ? 'is up again' : 'ALSO FAILS ITS CHECK: act now'}`,
  );
}
