// The other end of scripts/backup.ts (NFR-RE-10; procedure 6, steps 8 to 12): make the pair of keys,
// open a copy with the private half, and load what it holds into a database and a bucket that no user
// can reach. Run on a machine that is not a host of the deployment, where the private key is brought
// from where it is held offline. Every setting comes from the environment or a flag, none from a file
// but the key; no secret is printed or put in an argument.
//
//   A secret is read from the keyboard, never typed in a command: `read -rs NAME && export NAME` (no echo, nothing in
//   the history of the shell or in `ps`).
//   read -rs BACKUP_KEY_PASSPHRASE && export BACKUP_KEY_PASSPHRASE
//   node scripts/backup-restore.ts keygen --out <directory>
//   node scripts/backup-restore.ts decrypt --in <copy> --key <private.pem> --out <directory>
//   read -rs RESTORE_DATABASE_URL && export RESTORE_DATABASE_URL     (postgresql://ekdotico_migrate:…@host/db)
//   node scripts/backup-restore.ts database --dir <directory>
//   export RESTORE_IMAGES_ENDPOINT=… RESTORE_IMAGES_BUCKET=… RESTORE_IMAGES_ACCESS_KEY_ID=…
//   read -rs RESTORE_IMAGES_SECRET_ACCESS_KEY && export RESTORE_IMAGES_SECRET_ACCESS_KEY
//   node scripts/backup-restore.ts images --dir <directory>
//
// `database` loads into an empty database that scripts/provision.sql has provisioned, as the owner of the
// schema (the migration role), so that the roles hold what they hold on a deployment. It refuses a
// schema that already has a table.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { documentOfKey } from '../src/lib/images/storage.ts';
import { EnvelopeError, newKeyPair, unseal } from './backup-envelope.ts';
import { connectionEnv, describeError, LOCAL, run, tlsOrLocal } from './backup-tools.ts';

class Refusal extends Error {
  name = 'Refusal';
}

let secrets: string[] = [];
const clean = (text: string) => secrets.reduce((out, secret) => out.split(secret).join('[removed]'), text);
const say = (line: string) => console.log(clean(line));

function flag(args: string[], name: string): string {
  const at = args.indexOf(`--${name}`);
  const value = at >= 0 ? args[at + 1] : undefined;
  if (!value || value.startsWith('--')) throw new Refusal(`--${name} is needed.`);
  return value;
}

// ── keygen ──────────────────────────────────────────────────────────────────

async function keygen(args: string[]): Promise<void> {
  const passphrase = process.env.BACKUP_KEY_PASSPHRASE;
  if (!passphrase) throw new Refusal('BACKUP_KEY_PASSPHRASE is not set.');
  secrets = [passphrase];
  const directory = resolve(flag(args, 'out'));
  const pair = newKeyPair(passphrase);
  // 'wx': an existing key is never replaced, so a copy sealed to it can still be opened.
  const publicFile = join(directory, 'backup-public.pem');
  const privateFile = join(directory, 'backup-private.pem');
  await writeFile(publicFile, pair.publicKey, { flag: 'wx', mode: 0o644 });
  await writeFile(privateFile, pair.privateKey, { flag: 'wx', mode: 0o600 });
  say(`keys: wrote ${publicFile} (for the host) and ${privateFile} (for the team alone, to be kept offline)`);
}

// ── decrypt ─────────────────────────────────────────────────────────────────

interface Manifest {
  format: string;
  entries: { name: string; bytes: number; sha256: string }[];
  images: { listed: number; copied: number; missing: number; refused: number };
}

async function decrypt(args: string[]): Promise<void> {
  const passphrase = process.env.BACKUP_KEY_PASSPHRASE;
  secrets = passphrase ? [passphrase] : [];
  const file = resolve(flag(args, 'in'));
  const key = await readFile(resolve(flag(args, 'key')), 'utf8');
  // A private key kept offline is kept under a passphrase: a file that anyone who finds it can use is not offline.
  if (!/-----BEGIN ENCRYPTED PRIVATE KEY-----|Proc-Type: 4,ENCRYPTED/.test(key)) {
    throw new Refusal(
      'The private key is not encrypted with a passphrase: make the pair again with the keygen command.',
    );
  }
  const directory = resolve(flag(args, 'out'));
  try {
    if ((await readdir(directory)).length > 0) throw new Refusal('The directory to write to is not empty.');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  try {
    const opened = await unseal(file, key, passphrase, directory);
    // The copy is whole when every entry is what the manifest says it is.
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
    if (manifest.format !== 'ekdbak-1')
      throw new Refusal('The manifest is of a form this tool does not know.');
    for (const entry of manifest.entries) {
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const part of createReadStream(join(directory, entry.name))) {
        hash.update(part);
        bytes += part.length;
      }
      if (bytes !== entry.bytes || hash.digest('hex') !== entry.sha256) {
        throw new Refusal('An entry is not what the manifest says: the copy is not whole.');
      }
    }
    if (!opened.names.includes('dump.pgdump')) throw new Refusal('The copy holds no dump.');
    say(
      `restore: opened ${opened.names.length} entries (${opened.bytes} bytes) into ${directory}; ` +
        `${manifest.images.copied} of ${manifest.images.listed} images, ${manifest.images.missing} were no longer there when it was made`,
    );
  } catch (error) {
    // Nothing of an opening that failed stays on this machine.
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

// ── database ────────────────────────────────────────────────────────────────

async function database(args: string[]): Promise<void> {
  const directory = resolve(flag(args, 'dir'));
  const raw = process.env.RESTORE_DATABASE_URL;
  if (!raw || !URL.canParse(raw)) throw new Refusal('RESTORE_DATABASE_URL is not set to a URL.');
  const url = new URL(raw);
  const password = decodeURIComponent(url.password);
  secrets = [raw, password, encodeURIComponent(password)].filter((value) => value.length >= 4);
  // As the job requires of its own connection: away from this machine the password does not cross the network in clear.
  if (!tlsOrLocal(url)) {
    throw new Refusal(
      'RESTORE_DATABASE_URL must say sslmode=require (or verify-ca, verify-full) away from localhost.',
    );
  }
  const env = connectionEnv(url, { PGOPTIONS: '-c statement_timeout=0' });
  const state = (
    await run(
      'psql',
      [
        '-X',
        '-w',
        '-At',
        '-F',
        '|',
        '-c',
        `SELECT coalesce((SELECT nspowner::regrole::text = current_user FROM pg_namespace WHERE nspname = 'ekdotico'), false),
                (SELECT count(*) FROM pg_tables WHERE schemaname = 'ekdotico')`,
      ],
      env,
    )
  ).trim();
  const [owns, tables] = state.split('|');
  if (owns !== 't') {
    throw new Refusal(
      'The schema `ekdotico` is missing or not owned by this user: provision the database (scripts/provision.sql) and restore as the migration role.',
    );
  }
  if (Number(tables) > 0)
    throw new Refusal('The schema already holds a table: restore into an empty database.');

  const dump = join(directory, 'dump.pgdump');
  await stat(dump);
  // The schema is made by the provisioning script, with its owner and its grants; the dump's own line for it is left out.
  const list = (await run('pg_restore', ['-l', dump], env))
    .split('\n')
    .filter((line) => !/ SCHEMA - ekdotico /.test(line))
    .join('\n');
  const listFile = join(directory, '.restore-list');
  await writeFile(listFile, list, { mode: 0o600 });
  try {
    await run(
      'pg_restore',
      ['--no-owner', '--no-acl', '--exit-on-error', '-L', listFile, '-d', env.PGDATABASE!, dump],
      env,
    );
  } finally {
    await rm(listFile, { force: true });
  }
  const count = (
    await run(
      'psql',
      ['-X', '-w', '-At', '-c', `SELECT count(*) FROM pg_tables WHERE schemaname = 'ekdotico'`],
      env,
    )
  ).trim();
  say(`restore: loaded the dump into the database; the schema now holds ${count} tables`);
}

// ── images ──────────────────────────────────────────────────────────────────

async function images(args: string[]): Promise<void> {
  const directory = resolve(flag(args, 'dir'));
  const names = [
    'RESTORE_IMAGES_ENDPOINT',
    'RESTORE_IMAGES_BUCKET',
    'RESTORE_IMAGES_ACCESS_KEY_ID',
    'RESTORE_IMAGES_SECRET_ACCESS_KEY',
  ];
  const absent = names.filter((name) => !process.env[name]);
  if (absent.length > 0) throw new Refusal(`${absent.join(', ')} not set.`);
  const endpoint = process.env.RESTORE_IMAGES_ENDPOINT!;
  const { protocol, hostname } = new URL(endpoint);
  const here = LOCAL.includes(hostname);
  if (protocol !== 'https:' && !(protocol === 'http:' && here))
    throw new Refusal('RESTORE_IMAGES_ENDPOINT must use https, except on localhost.');
  secrets = [process.env.RESTORE_IMAGES_SECRET_ACCESS_KEY!];
  const bucket = process.env.RESTORE_IMAGES_BUCKET!;
  const client = new S3Client({
    endpoint,
    region: process.env.RESTORE_IMAGES_REGION || 'fra1',
    forcePathStyle: here,
    credentials: {
      accessKeyId: process.env.RESTORE_IMAGES_ACCESS_KEY_ID!,
      secretAccessKey: process.env.RESTORE_IMAGES_SECRET_ACCESS_KEY!,
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  try {
    const present = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    if ((present.KeyCount ?? 0) > 0)
      throw new Refusal('The bucket is not empty: restore into an empty bucket.');
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Manifest;
    let put = 0;
    const objects = manifest.entries.filter((each) => each.name !== 'dump.pgdump');
    // What the manifest names as an object is put under that name: it must be the name of an image object, and nothing else.
    if (objects.some((each) => documentOfKey(each.name) === null)) {
      throw new Refusal('The manifest names an object that is not an image key: nothing was put.');
    }
    for (const entry of objects) {
      const handle = await open(join(directory, entry.name), 'r');
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: entry.name,
            Body: handle.createReadStream(),
            ContentLength: entry.bytes,
          }),
        );
      } finally {
        await handle.close();
      }
      put++;
    }
    say(`restore: put ${put} image objects into the bucket`);
  } finally {
    client.destroy();
  }
}

// ── main ────────────────────────────────────────────────────────────────────

const COMMANDS: Record<string, (args: string[]) => Promise<void>> = { keygen, decrypt, database, images };

if (import.meta.main) {
  const [name, ...args] = process.argv.slice(2);
  try {
    const command = name ? COMMANDS[name] : undefined;
    if (!command) throw new Refusal('The commands are keygen, decrypt, database and images.');
    await command(args);
  } catch (error) {
    if (error instanceof Refusal || error instanceof EnvelopeError) {
      console.error(clean(`restore: refused: ${error.message}`));
      process.exit(2);
    }
    console.error(clean(`restore: failed (${describeError(error)})`));
    process.exit(1);
  }
}
