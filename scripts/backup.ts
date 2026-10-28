// The job that makes the copy of the backups kept outside DigitalOcean (NFR-RE-10, D118; register
// A28, assumed): a logical dump of the `ekdotico` schema with the image objects, taken under the
// application backup role `ekdotico_backup`, sealed on this host to a public key whose private half
// the founding team holds offline (scripts/backup-envelope.ts), and added to a bucket in the object
// storage of Scaleway. docs/operations/backup.md says how to run it and what it needs.
//
//   node scripts/backup.ts
//
// It holds a database dump and the means to reach two stores, so it keeps these rules, each with a
// test that fails when it is broken (tests/integration/backup.test.ts):
//
//   1. It reads every setting from the environment, and no file but the PUBLIC key. It loads no
//      `.env` file, so no secret of the repository's directory can reach it.
//   2. It prints no secret: a line is written by `say`, which removes every secret value from it, and
//      only counts, key names of the copy and the class of a fault are put in one. A password reaches
//      the tools it starts in their environment and never in an argument.
//   3. It refuses to run without encryption: with no key, a private key or a key under 3,072 bits it
//      stops before it opens a connection to anything.
//   4. It refuses a role that is more than a reader of the schema, and one that cannot read all of it.
//      The dump is taken under the role of NFR-IC-17 and not under a role that could write.
//   5. It only adds. It never deletes, lists or overwrites: every copy has a key of its own, and the
//      store is asked not to replace (If-None-Match). The expiry of the copies is a rule of the bucket.
//   6. Nothing plain is written to disk. The dump goes from `pg_dump` into the seal; what is written
//      is ciphertext, in a file of mode 0600 that is removed whatever happens.
//
// Exit codes: 0 the copy is stored; 1 a fault, after which nothing is stored; 2 a refusal, before
// anything was done. The scheduler that runs it tells the founding team of a status other than 0
// (NFR-RE-10: "it is told of its failures").
//
// ponytail: one request stores the copy, so it is at most 5 GiB (the envelope refuses more). Use
// multipart storing when a copy outgrows that.
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { documentOfKey } from '../src/lib/images/storage.ts';
import { EnvelopeError, publicKeyOf, seal, type Entry } from './backup-envelope.ts';

/** Where a copy goes in its bucket. The bucket's expiry rule is written for this prefix (docs/operations/backup.md). */
export const BACKUP_PREFIX = 'backups';

/** A refusal: the settings or the role are not what the job is allowed to run with. */
export class Refusal extends Error {
  name = 'Refusal';
}

interface Store {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export interface Settings {
  database: {
    host: string;
    port: string;
    user: string;
    password: string;
    name: string;
    sslmode: string | undefined;
  };
  databaseUrl: string;
  publicKeyFile: string;
  store: Store;
  images: Store;
  workDirectory: string;
}

type Env = Record<string, string | undefined>;

const LOCAL = ['localhost', '127.0.0.1', '[::1]', '::1'];
const TLS = ['require', 'verify-ca', 'verify-full'];

function need(env: Env, names: string[]): void {
  const absent = names.filter((name) => !env[name]);
  if (absent.length > 0)
    throw new Refusal(`${absent.join(', ')} ${absent.length === 1 ? 'is' : 'are'} not set.`);
}

function storeOf(env: Env, prefix: 'BACKUP_STORE' | 'BACKUP_IMAGES', defaultRegion?: string): Store {
  need(env, [
    `${prefix}_ENDPOINT`,
    `${prefix}_BUCKET`,
    `${prefix}_ACCESS_KEY_ID`,
    `${prefix}_SECRET_ACCESS_KEY`,
    ...(defaultRegion ? [] : [`${prefix}_REGION`]),
  ]);
  const endpoint = env[`${prefix}_ENDPOINT`]!;
  if (!URL.canParse(endpoint) || new URL(endpoint).origin !== endpoint) {
    throw new Refusal(
      `${prefix}_ENDPOINT must be an origin: a scheme, a host and an optional port, with nothing after.`,
    );
  }
  const { protocol, hostname } = new URL(endpoint);
  const here = LOCAL.includes(hostname);
  if (protocol !== 'https:' && !(protocol === 'http:' && here)) {
    throw new Refusal(`${prefix}_ENDPOINT must use https, except on localhost.`);
  }
  const bucket = env[`${prefix}_BUCKET`]!;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Refusal(`${prefix}_BUCKET must be a bucket name: 3 to 63 characters of a to z, 0 to 9 and -.`);
  }
  const region = env[`${prefix}_REGION`] || defaultRegion!;
  if (!/^[a-z0-9-]{2,32}$/.test(region))
    throw new Refusal(`${prefix}_REGION must be 2 to 32 characters of a to z, 0 to 9 and -.`);
  return {
    endpoint,
    bucket,
    region,
    accessKeyId: env[`${prefix}_ACCESS_KEY_ID`]!,
    secretAccessKey: env[`${prefix}_SECRET_ACCESS_KEY`]!,
  };
}

/**
 * The settings, or a refusal. Reads nothing: the environment is the only source (rule 1). The public
 * key file is read later, by the one function that reads a file.
 */
export function loadSettings(env: Env): Settings {
  need(env, ['BACKUP_DATABASE_URL', 'BACKUP_PUBLIC_KEY_FILE']);
  // Rule 3 comes first among the checks: nothing below is looked at before the key has been.
  const databaseUrl = env.BACKUP_DATABASE_URL!;
  if (!URL.canParse(databaseUrl)) throw new Refusal('BACKUP_DATABASE_URL is not a URL.');
  const url = new URL(databaseUrl);
  if (!['postgresql:', 'postgres:'].includes(url.protocol))
    throw new Refusal('BACKUP_DATABASE_URL is not a PostgreSQL URL.');
  if (!url.username || !url.password || url.pathname.length < 2) {
    throw new Refusal('BACKUP_DATABASE_URL must name a user, a password and a database.');
  }
  const sslmode = url.searchParams.get('sslmode') ?? undefined;
  if (!LOCAL.includes(url.hostname) && !(sslmode && TLS.includes(sslmode))) {
    throw new Refusal(
      'BACKUP_DATABASE_URL must say sslmode=require (or verify-ca, verify-full) away from localhost.',
    );
  }
  const store = storeOf(env, 'BACKUP_STORE');
  const images = storeOf(env, 'BACKUP_IMAGES', 'fra1');
  // The copy is outside DigitalOcean (NFR-RE-10): a bucket there is a misspelt setting, not a copy.
  if (
    !LOCAL.includes(new URL(store.endpoint).hostname) &&
    /(^|\.)digitalocean(spaces)?\.com$/.test(new URL(store.endpoint).hostname)
  ) {
    throw new Refusal('BACKUP_STORE_ENDPOINT is at DigitalOcean: the copy is kept outside it.');
  }
  if (store.endpoint === images.endpoint && store.bucket === images.bucket) {
    throw new Refusal('The bucket of the copies is the bucket of the images.');
  }
  return {
    database: {
      host: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port || '5432',
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      name: decodeURIComponent(url.pathname.slice(1)),
      sslmode,
    },
    databaseUrl,
    publicKeyFile: env.BACKUP_PUBLIC_KEY_FILE!,
    store,
    images,
    workDirectory: env.BACKUP_WORK_DIRECTORY || tmpdir(),
  };
}

// ── What is said ────────────────────────────────────────────────────────────

let secrets: string[] = [];

/** Rule 2: every line goes through here, and a secret value never survives it. */
function clean(text: string): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join('[removed]');
  return out;
}
const say = (line: string) => console.log(clean(line));
const complain = (line: string) => console.error(clean(line));

// ── The tools ───────────────────────────────────────────────────────────────

/** The environment of a tool this job starts: its path, and the connection by name. The password is here and in no argument. */
function toolEnv(s: Settings): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    PGHOST: s.database.host,
    PGPORT: s.database.port,
    PGUSER: s.database.user,
    PGPASSWORD: s.database.password,
    PGDATABASE: s.database.name,
    ...(s.database.sslmode ? { PGSSLMODE: s.database.sslmode } : {}),
    PGCONNECT_TIMEOUT: '15',
    PGAPPNAME: 'ekdotico-backup',
    // Defence in depth for rule 4: a session of this job cannot write, whatever its role could.
    PGOPTIONS: '-c default_transaction_read_only=on',
  };
}

function run(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.once('error', (error) =>
      reject(
        new Error(`${command} could not be started (${(error as NodeJS.ErrnoException).code ?? 'fault'})`),
      ),
    );
    child.once('close', (code) =>
      code === 0
        ? resolve(out)
        : reject(new Error(`${command} failed (${code}): ${err.trim().slice(0, 500)}`)),
    );
  });
}

const psql = (s: Settings, sql: string) =>
  run('psql', ['-X', '-w', '-At', '-F', '|', '-v', 'ON_ERROR_STOP=1', '-c', sql], toolEnv(s));

// ── Rule 4: the role ────────────────────────────────────────────────────────

const WRITES = 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER';

/**
 * Refuses a role that can do more than read the schema, or cannot read all of it: a dump under a role
 * that could write is not the copy of NFR-RE-10, and one that misses a table is a copy that is not whole.
 */
export async function checkRole(s: Settings): Promise<string> {
  const row = await psql(
    s,
    `SELECT current_user,
       coalesce((SELECT rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname = current_user), true),
       has_schema_privilege(current_user, 'ekdotico', 'USAGE'),
       has_schema_privilege(current_user, 'ekdotico', 'CREATE'),
       has_database_privilege(current_user, current_database(), 'CREATE,TEMPORARY'),
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'ekdotico' AND c.relkind IN ('r','p','v','m','f') AND has_table_privilege(current_user, c.oid, '${WRITES}')),
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'ekdotico' AND c.relkind = 'S' AND has_sequence_privilege(current_user, c.oid, 'UPDATE,USAGE')),
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'ekdotico'
           AND ((c.relkind IN ('r','p') AND NOT has_table_privilege(current_user, c.oid, 'SELECT'))
             OR (c.relkind = 'S' AND NOT has_sequence_privilege(current_user, c.oid, 'SELECT')))),
       (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'ekdotico' AND c.relkind IN ('r','p'))`,
  );
  const [user, wide, usage, create, database, writable, sequences, unreadable, tables] = row
    .trim()
    .split('|');
  if (wide !== 'f')
    throw new Refusal(
      'The role holds an attribute beyond a login (superuser, createdb, createrole, replication or bypassrls).',
    );
  if (usage !== 't') throw new Refusal('The role cannot use the schema `ekdotico`.');
  if (create === 't') throw new Refusal('The role can create in the schema `ekdotico`.');
  if (database === 't') throw new Refusal('The role can create objects or temporary tables in the database.');
  if (Number(writable) > 0)
    throw new Refusal(
      `The role can write ${writable} table(s) of the schema: the dump is taken under a role that only reads.`,
    );
  if (Number(sequences) > 0) throw new Refusal('The role can advance a sequence of the schema.');
  if (Number(unreadable) > 0)
    throw new Refusal(
      `The role cannot read ${unreadable} table(s) or sequence(s) of the schema: the copy would not be whole.`,
    );
  if (Number(tables) === 0)
    throw new Refusal('The schema `ekdotico` holds no table: this is not the application database.');
  return user!;
}

// ── The copy ────────────────────────────────────────────────────────────────

function client(store: Store): S3Client {
  const here = LOCAL.includes(new URL(store.endpoint).hostname);
  return new S3Client({
    endpoint: store.endpoint,
    region: store.region,
    forcePathStyle: here,
    credentials: { accessKeyId: store.accessKeyId, secretAccessKey: store.secretAccessKey },
    // As the application's own client: the protocol's other stores do not all take the SDK's default checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 3,
    requestHandler: { requestTimeout: 60_000, connectionTimeout: 10_000 },
    // The SDK writes a line of its own for some faults. Every line this job prints goes through `say` (rule 2).
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
}

interface Counted {
  name: string;
  bytes: number;
  sha256: string;
}

async function* counting(source: AsyncIterable<Uint8Array>, into: Counted): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256');
  for await (const part of source) {
    hash.update(part);
    into.bytes += part.length;
    yield part;
  }
  into.sha256 = hash.digest('hex');
}

interface Report {
  images: { listed: number; copied: number; missing: number; refused: number };
}

async function* entriesOf(
  s: Settings,
  user: string,
  report: Report,
  counts: Counted[],
): AsyncGenerator<Entry> {
  // The dump, straight from pg_dump into the seal.
  const dump = spawn('pg_dump', ['-w', '--schema=ekdotico', '--no-owner', '--no-acl', '--format=custom'], {
    env: toolEnv(s) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let dumpError = '';
  dump.stderr.on('data', (chunk) => (dumpError += chunk));
  const exited = new Promise<number | null>((resolve) => dump.once('close', resolve));
  const failed = new Promise<never>((_, reject) =>
    dump.once('error', (error) =>
      reject(new Error(`pg_dump could not be started (${(error as NodeJS.ErrnoException).code ?? 'fault'})`)),
    ),
  );
  failed.catch(() => {});
  const dumped: Counted = { name: 'dump.pgdump', bytes: 0, sha256: '' };
  const source = client(s.images);
  try {
    yield { name: dumped.name, body: counting(dump.stdout, dumped) };
    const code = await Promise.race([exited, failed]);
    if (code !== 0) throw new Error(`pg_dump failed (${code}): ${dumpError.trim().slice(0, 500)}`);
    counts.push(dumped);

    // The objects of the images, named by the rows of the table, so that the credential lists nothing (NFR-SE-18).
    const listed = (
      await psql(s, `SELECT "objectKey" FROM ekdotico."DocumentImage" ORDER BY "createdAt", id`)
    )
      .split('\n')
      .filter(Boolean);
    report.images.listed = listed.length;
    for (const key of listed) {
      if (documentOfKey(key) === null) {
        report.images.refused++;
        continue;
      }
      let body: AsyncIterable<Uint8Array>;
      try {
        const object = await source.send(new GetObjectCommand({ Bucket: s.images.bucket, Key: key }));
        body = object.Body as unknown as AsyncIterable<Uint8Array>;
      } catch (error) {
        // An object deleted since the dump was taken has no copy to make; any other fault stops the job.
        if ((error as { name?: string }).name === 'NoSuchKey') {
          report.images.missing++;
          continue;
        }
        throw error;
      }
      const counted: Counted = { name: key, bytes: 0, sha256: '' };
      yield { name: key, body: counting(body, counted) };
      counts.push(counted);
      report.images.copied++;
    }

    const manifest = Buffer.from(
      JSON.stringify(
        {
          format: 'ekdbak-1',
          madeAt: new Date().toISOString(),
          schema: 'ekdotico',
          role: user,
          storeRegion: s.store.region,
          images: report.images,
          entries: counts,
        },
        null,
        2,
      ),
    );
    yield {
      name: 'manifest.json',
      body: (async function* () {
        yield manifest;
      })(),
    };
  } finally {
    source.destroy();
    // A job that stops early does not leave a dump running.
    if (dump.exitCode === null && dump.signalCode === null) dump.kill();
  }
}

/** Seals the copy into a file of this job's own, mode 0600, and returns its path and size. */
async function sealToFile(
  s: Settings,
  key: ReturnType<typeof publicKeyOf>,
  user: string,
  report: Report,
): Promise<{ path: string; size: number }> {
  const path = join(s.workDirectory, `ekdotico-backup-${randomBytes(8).toString('hex')}.ekdbak`);
  const file = await open(path, 'wx', 0o600);
  try {
    for await (const piece of seal(key, entriesOf(s, user, report, []))) await file.write(piece);
  } catch (error) {
    await file.close();
    await rm(path, { force: true });
    throw error;
  }
  await file.close();
  return { path, size: (await stat(path)).size };
}

function newKey(): string {
  const now = new Date();
  const stamp = now
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${BACKUP_PREFIX}/${stamp.slice(0, 4)}/${stamp.slice(4, 6)}/${stamp}-${randomBytes(8).toString('hex')}.ekdbak`;
}

/** Makes the copy. Resolves with the key it was stored under. */
export async function backUp(env: Env): Promise<string> {
  const s = loadSettings(env);
  secrets = [
    s.databaseUrl,
    s.database.password,
    encodeURIComponent(s.database.password),
    s.store.secretAccessKey,
    s.store.accessKeyId,
    s.images.secretAccessKey,
    s.images.accessKeyId,
  ].filter((value) => value.length >= 4);

  // Rule 3: the key, before anything is connected to.
  let key;
  try {
    key = publicKeyOf(await readFile(s.publicKeyFile, 'utf8'));
  } catch (error) {
    if (error instanceof EnvelopeError) throw new Refusal(error.message);
    throw new Refusal('BACKUP_PUBLIC_KEY_FILE could not be read.');
  }

  const user = await checkRole(s);
  const report: Report = { images: { listed: 0, copied: 0, missing: 0, refused: 0 } };
  const { path, size } = await sealToFile(s, key, user, report);
  const objectKey = newKey();
  const store = client(s.store);
  try {
    await store.send(
      new PutObjectCommand({
        Bucket: s.store.bucket,
        Key: objectKey,
        Body: createReadStream(path),
        ContentLength: size,
        ContentType: 'application/octet-stream',
        // Rule 5: add, and never replace.
        IfNoneMatch: '*',
      }),
    );
  } finally {
    store.destroy();
    await rm(path, { force: true });
  }
  say(
    `backup: stored ${size} bytes as ${objectKey} in region ${s.store.region} ` +
      `(${report.images.copied} of ${report.images.listed} images, ${report.images.missing} no longer there, ${report.images.refused} refused)`,
  );
  return objectKey;
}

if (import.meta.main) {
  try {
    await backUp(process.env);
  } catch (error) {
    if (error instanceof Refusal) {
      complain(`backup: refused: ${error.message}`);
      process.exit(2);
    }
    // The class of the fault and what the tool said, with every secret removed (rule 2).
    const name = error instanceof Error ? error.name : 'Error';
    const message = error instanceof Error ? error.message.split('\n')[0]!.slice(0, 300) : '';
    complain(`backup: failed (${name}${message ? `: ${message}` : ''})`);
    process.exit(1);
  }
}
