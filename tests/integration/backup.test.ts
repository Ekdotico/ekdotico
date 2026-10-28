// The job that makes the copy of the backups kept outside DigitalOcean (NFR-RE-10, D118; register
// A28; docs/plan/slice-27.md, S27-10 and S27-11), against the local PostgreSQL and the local store of
// the S3 protocol of compose.yaml, never a real account. The script is run as a process, as a
// scheduler runs it, with an environment of its own. Each rule in its header has a test here that
// fails when the rule is broken (section 8 of the plan names the mutations).
//
// Run only where the object store is given by the four IMAGE_STORAGE_* settings (they open the store
// of compose.yaml and nothing else): without them every test here is skipped and the run says so.
// Needs pg_dump of the version of the server or later, and psql and pg_restore beside it.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase } from './database.ts';

const given = Boolean(process.env.IMAGE_STORAGE_ENDPOINT);
const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/backup.ts');
const RESTORE = join(ROOT, 'scripts/backup-restore.ts');
const PASSPHRASE = 'the passphrase of a key that only a test holds';

// A run on a machine without a store skips the tests below. A run of CI does not: there a store that is
// not given is a failure, as for the adapter of the images.
it.runIf(process.env.CI === 'true' && !given)('is given a store by a run of CI (IMAGE_STORAGE_*)', () => {
  expect(given).toBe(true);
});

const DOCUMENT = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const MARKER = 'a-title-no-copy-may-show-in-clear';
const IMAGE_MARKER = 'IMAGE-BYTES-THAT-NO-COPY-MAY-SHOW';
const images = new Map<number, Buffer>();
const image = (n: number) => {
  if (!images.has(n))
    images.set(n, Buffer.concat([Buffer.from(`\x89PNG-${n}-${IMAGE_MARKER}`), randomBytes(2048)]));
  return images.get(n)!;
};
const KEY_A = `images/${DOCUMENT}/${'a'.repeat(32)}`;
const KEY_B = `images/${DOCUMENT}/${'b'.repeat(32)}`;
// A row whose object is not in the store (deleted since the dump), and a row whose key is not of the form.
const KEY_GONE = `images/${DOCUMENT}/${'c'.repeat(32)}`;
const KEY_ODD = `../outside/${'d'.repeat(32)}`;

describe.skipIf(!given)('the copy of the backups', () => {
  const admin = new URL(process.env.ADMIN_DATABASE_URL!);
  const suffix = randomBytes(5).toString('hex');
  const COPIES = `ekdotico-test-copies-${suffix}`;
  const IMAGES = `ekdotico-test-images-${suffix}`;
  const RESTORED = `ekdotico-test-restored-${suffix}`;
  const work = mkdtempSync(join(tmpdir(), 'ekdotico-backup-test-'));
  const publicFile = join(work, 'public.pem');
  let privatePem = '';
  let s3: S3Client;
  let database: ReturnType<typeof createDatabase>;
  let databaseName = '';
  const databases: string[] = [];

  const endpoint = process.env.IMAGE_STORAGE_ENDPOINT!;
  const accessKeyId = process.env.IMAGE_STORAGE_ACCESS_KEY_ID!;
  const secretAccessKey = process.env.IMAGE_STORAGE_SECRET_ACCESS_KEY!;

  const urlOf = (role: string, password: string, name = databaseName) => {
    const url = new URL(admin);
    url.username = role;
    url.password = password;
    url.pathname = `/${name}`;
    return url.toString();
  };
  const backupUrl = () => urlOf('ekdotico_backup', 'local-backup');

  /** psql, as the administrator, against a database. */
  function psql(url: string, args: string[]) {
    const run = spawnSync('psql', [url, '-X', '-At', '-v', 'ON_ERROR_STOP=1', ...args], { encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    return run.stdout.trim();
  }

  function good(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
    return {
      BACKUP_DATABASE_URL: backupUrl(),
      BACKUP_PUBLIC_KEY_FILE: publicFile,
      BACKUP_STORE_ENDPOINT: endpoint,
      BACKUP_STORE_BUCKET: COPIES,
      BACKUP_STORE_REGION: 'fr-par',
      BACKUP_STORE_ACCESS_KEY_ID: accessKeyId,
      BACKUP_STORE_SECRET_ACCESS_KEY: secretAccessKey,
      BACKUP_IMAGES_ENDPOINT: endpoint,
      BACKUP_IMAGES_BUCKET: IMAGES,
      BACKUP_IMAGES_ACCESS_KEY_ID: accessKeyId,
      BACKUP_IMAGES_SECRET_ACCESS_KEY: secretAccessKey,
      BACKUP_WORK_DIRECTORY: mkdtempSync(join(work, 'run-')),
      ...overrides,
    };
  }

  interface Ran {
    status: number | null;
    out: string;
    err: string;
    workDirectory: string;
  }

  /** The script as a process, with the environment given and no other (the PATH and nothing of the test's own). */
  function backup(
    env: Record<string, string | undefined>,
    cwd = ROOT,
    path = process.env.PATH!,
  ): Promise<Ran> {
    return new Promise((resolve) => {
      const clean = Object.fromEntries(
        Object.entries(env).filter(([, value]) => value !== undefined),
      ) as Record<string, string>;
      const child = spawn('node', [SCRIPT], {
        cwd,
        env: { NODE_ENV: 'test', PATH: path, ...clean },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => (out += chunk));
      child.stderr.on('data', (chunk) => (err += chunk));
      child.once('close', (status) =>
        resolve({ status, out, err, workDirectory: clean.BACKUP_WORK_DIRECTORY ?? '' }),
      );
    });
  }

  async function copies(): Promise<string[]> {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: COPIES }));
    return (listed.Contents ?? []).map((each) => each.Key!).sort();
  }

  /** Makes one copy in the bucket, which is empty when a test begins, and returns what the bucket holds. */
  async function makeCopy(): Promise<string[]> {
    const ran = await backup(good());
    expect(ran.status, ran.err).toBe(0);
    return copies();
  }

  async function fetchObject(bucket: string, key: string): Promise<Buffer> {
    const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return Buffer.from(await object.Body!.transformToByteArray());
  }

  async function empty(bucket: string) {
    const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null);
    for (const { Key } of listed?.Contents ?? []) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: Key })).catch(() => {});
    }
  }

  /** A database provisioned and not migrated, as the restore procedure makes it (step 10). */
  function provisioned(label: string): string {
    const name = `ekdotico_test_${label}_${randomBytes(4).toString('hex')}`;
    psql(admin.toString(), [
      '-c',
      `CREATE DATABASE ${name} ENCODING 'UTF8' LOCALE 'en_US.UTF-8' LOCALE_PROVIDER libc TEMPLATE template0`,
    ]);
    databases.push(name);
    const into = new URL(admin);
    into.pathname = `/${name}`;
    psql(into.toString(), [
      '-v',
      'migrate_password=local-migrate',
      '-v',
      'app_password=local-app',
      '-v',
      'backup_password=local-backup',
      '-f',
      'scripts/provision.sql',
    ]);
    return name;
  }

  beforeAll(async () => {
    s3 = new S3Client({
      endpoint,
      region: 'fra1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    for (const bucket of [COPIES, IMAGES, RESTORED])
      await s3.send(new CreateBucketCommand({ Bucket: bucket }));

    const pair = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
    });
    writeFileSync(publicFile, pair.publicKey);
    privatePem = pair.privateKey;

    database = createDatabase('backup');
    databaseName = new URL(database.appUrl).pathname.slice(1);
    database.sql(`
      INSERT INTO "User" (id, email, name, "updatedAt") VALUES ('u1', 'a@example.com', 'A Person', now());
      INSERT INTO "Workspace" (id, type, "ownerId") VALUES ('w1', 'PERSONAL', 'u1');
      INSERT INTO "Document" (id, "workspaceId", "ownerId", title, "permissionSet", recording, "updatedAt", "yjsState")
        VALUES ('${DOCUMENT}', 'w1', 'u1', '${MARKER}', '{}', 'UNRECORDED', now(), decode('00010203', 'hex'));
      INSERT INTO ekdotico."DocumentImage" (id, "documentId", "objectKey", "contentType", "byteSize", "uploadedById")
        VALUES ('i1', '${DOCUMENT}', '${KEY_A}', 'image/png', 2048, 'u1'),
               ('i2', '${DOCUMENT}', '${KEY_B}', 'image/png', 2048, 'u1'),
               ('i3', '${DOCUMENT}', '${KEY_GONE}', 'image/png', 2048, 'u1'),
               ('i4', '${DOCUMENT}', '${KEY_ODD}', 'image/png', 2048, 'u1');
    `);
    for (const [key, n] of [
      [KEY_A, 1],
      [KEY_B, 2],
    ] as const) {
      await s3.send(
        new PutObjectCommand({ Bucket: IMAGES, Key: key, Body: image(n), ContentLength: image(n).length }),
      );
    }
  }, 120_000);

  afterAll(async () => {
    if (!given) return;
    for (const bucket of [COPIES, IMAGES, RESTORED]) {
      await empty(bucket);
      await s3.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => {});
    }
    for (const name of databases) {
      spawnSync('psql', [admin.toString(), '-X', '-c', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`]);
    }
    database?.drop();
    rmSync(work, { recursive: true, force: true });
  });

  // ── The copy, and the restore from it ──────────────────────────────────────

  // Each test begins with no copy in the bucket, so that none counts on another's.
  beforeEach(async () => {
    await empty(COPIES);
  });

  it('stores a copy that opens, with the private half, to what was dumped, and restores to a working database and bucket', async () => {
    const ran = await backup(good());
    expect(ran.err).toBe('');
    expect(ran.status).toBe(0);
    const stored =
      /^backup: stored (\d+) bytes as (backups\/\d{4}\/\d{2}\/\d{8}T\d{6}Z-[0-9a-f]{16}\.ekdbak) in region fr-par \(2 of 4 images, 1 no longer there, 1 refused\)\n$/.exec(
        ran.out,
      );
    expect(stored, ran.out).not.toBeNull();
    expect(await copies()).toEqual([stored![2]]);
    expect(readdirSync(ran.workDirectory)).toEqual([]);

    // Step 8 and 9 of procedure 6: the copy is fetched, and opened with the private key.
    const file = join(work, 'fetched.ekdbak');
    writeFileSync(file, await fetchObject(COPIES, stored![2]!));
    expect(statSize(file)).toBe(Number(stored![1]));
    const opened = join(work, 'opened');
    const decrypted = spawnSync(
      'node',
      [RESTORE, 'decrypt', '--in', file, '--key', writeKey(), '--out', opened],
      {
        env: { NODE_ENV: 'test', PATH: process.env.PATH!, BACKUP_KEY_PASSPHRASE: PASSPHRASE },
        encoding: 'utf8',
      },
    );
    expect(decrypted.stderr).toBe('');
    expect(decrypted.status).toBe(0);
    expect(decrypted.stdout).toMatch(/opened 4 entries .* 2 of 4 images, 1 were no longer there/);
    expect(readFileSync(join(opened, KEY_A)).equals(image(1))).toBe(true);
    expect(readFileSync(join(opened, KEY_B)).equals(image(2))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(opened, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      format: 'ekdbak-1',
      role: 'ekdotico_backup',
      storeRegion: 'fr-par',
      images: { listed: 4, copied: 2, missing: 1, refused: 1 },
    });
    expect(manifest.entries.map((entry: { name: string }) => entry.name)).toEqual([
      'dump.pgdump',
      KEY_A,
      KEY_B,
    ]);

    // Step 10: an empty database with the schema and its roles, by the provisioning script; the dump is loaded into it.
    const restored = provisioned('restored');
    const loaded = spawnSync('node', [RESTORE, 'database', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_DATABASE_URL: urlOf('ekdotico_migrate', 'local-migrate', restored),
      },
      encoding: 'utf8',
    });
    expect(loaded.stderr).toBe('');
    expect(loaded.stdout).toMatch(/the schema now holds \d+ tables/);
    const app = urlOf('ekdotico_app', 'local-app', restored);
    expect(psql(app, ['-c', `SELECT title FROM ekdotico."Document"`])).toBe(MARKER);
    expect(psql(app, ['-c', `SELECT count(*) FROM ekdotico."DocumentImage"`])).toBe('4');
    expect(psql(app, ['-c', `SELECT encode("yjsState", 'hex') FROM ekdotico."Document"`])).toBe('00010203');
    // The roles hold on the restored schema what they hold on a deployment: the runtime role writes, the backup role does not.
    expect(
      psql(app, ['-c', `UPDATE ekdotico."Document" SET title = 'changed' RETURNING title`]).split('\n')[0],
    ).toBe('changed');
    expect(() =>
      psql(backupUrl().replace(databaseName, restored), ['-c', `UPDATE ekdotico."Document" SET title = 'x'`]),
    ).toThrow(/permission denied/);

    // Step 10, the objects: put into an empty bucket, and read back.
    const put = spawnSync('node', [RESTORE, 'images', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_IMAGES_ENDPOINT: endpoint,
        RESTORE_IMAGES_BUCKET: RESTORED,
        RESTORE_IMAGES_ACCESS_KEY_ID: accessKeyId,
        RESTORE_IMAGES_SECRET_ACCESS_KEY: secretAccessKey,
      },
      encoding: 'utf8',
    });
    expect(put.stderr).toBe('');
    expect(put.stdout).toBe('restore: put 2 image objects into the bucket\n');
    expect((await fetchObject(RESTORED, KEY_B)).equals(image(2))).toBe(true);
  }, 120_000);

  function writeKey(): string {
    const path = join(work, 'private.pem');
    writeFileSync(path, privatePem, { mode: 0o600 });
    return path;
  }
  function statSize(path: string): number {
    return readFileSync(path).length;
  }

  it('stores nothing in clear: the copy shows no title, no image byte, no dump header, no schema name', async () => {
    const [key] = await makeCopy();
    const bytes = await fetchObject(COPIES, key!);
    for (const clear of [MARKER, IMAGE_MARKER, 'PGDMP', 'ekdotico', 'Document', 'a@example.com', KEY_A]) {
      expect(bytes.includes(Buffer.from(clear)), clear).toBe(false);
    }
  });

  // ── Rule 5: it only adds ───────────────────────────────────────────────────

  it('adds a second copy under a key of its own and leaves the first as it was', async () => {
    const before = await makeCopy();
    expect(before).toHaveLength(1);
    const firstBytes = await fetchObject(COPIES, before[0]!);
    const ran = await backup(good());
    expect(ran.status, ran.err).toBe(0);
    const after = await copies();
    expect(after).toHaveLength(2);
    expect(new Set(after).size).toBe(2);
    expect((await fetchObject(COPIES, before[0]!)).equals(firstBytes)).toBe(true);
  }, 60_000);

  it('asks the store not to replace, and holds no call that deletes, lists or copies', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/IfNoneMatch: '\*'/);
    const imported = /import \{([^}]*)\} from '@aws-sdk\/client-s3'/.exec(source)![1]!;
    const names = imported
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean);
    expect(names.sort()).toEqual(['GetObjectCommand', 'PutObjectCommand', 'S3Client']);
  });

  // ── Rule 1: no secret from the repository ─────────────────────────────────

  it('reads no file of the directory it runs in: a .env there supplies nothing', async () => {
    const here = mkdtempSync(join(work, 'cwd-'));
    const settings = Object.entries(good())
      .map(([name, value]) => `${name}=${value}`)
      .join('\n');
    for (const name of ['.env', '.env.local', '.env.production'])
      writeFileSync(join(here, name), `${settings}\n`);
    const ran = await backup({}, here);
    expect(ran.status).toBe(2);
    expect(ran.err).toMatch(/^backup: refused: BACKUP_DATABASE_URL, BACKUP_PUBLIC_KEY_FILE are not set\.\n$/);
    expect(await copies()).toEqual([]);
  });

  it('has no way to read a file but the public key', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/loadEnvFile|dotenv|--env-file/);
    expect(source.match(/readFile\(/g)).toHaveLength(1);
    expect(source).toMatch(/readFile\(s\.publicKeyFile/);
  });

  // ── Rule 2: no secret in what it prints or in an argument ─────────────────

  /** A directory of tools that record how they were started and then run the real ones. */
  function shims(): { path: string; log: string } {
    const dir = mkdtempSync(join(work, 'shims-'));
    const log = join(dir, 'calls.log');
    for (const tool of ['pg_dump', 'psql']) {
      const real = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
      const shim = join(dir, tool);
      writeFileSync(
        shim,
        `#!/bin/sh\nprintf '%s\\n' "${tool} $*" >> '${log}'\nenv | grep '^PG' >> '${log}'\nexec '${real}' "$@"\n`,
      );
      chmodSync(shim, 0o755);
    }
    return { path: `${dir}:${process.env.PATH}`, log };
  }

  it('prints no secret, and starts its tools with the password in their environment and in no argument', async () => {
    const { path, log } = shims();
    const sentinels = ['local-backup', backupUrl(), secretAccessKey, accessKeyId];
    const runs = [
      await backup(good(), ROOT, path),
      // A password the server refuses, a key the store refuses, a store that does not answer, an image store that refuses:
      await backup(
        good({ BACKUP_DATABASE_URL: urlOf('ekdotico_no_such_role', 'not-the-password') }),
        ROOT,
        path,
      ),
      await backup(good({ BACKUP_STORE_SECRET_ACCESS_KEY: `${secretAccessKey}-changed` }), ROOT, path),
      await backup(good({ BACKUP_STORE_ENDPOINT: 'http://127.0.0.1:1' }), ROOT, path),
      await backup(good({ BACKUP_IMAGES_SECRET_ACCESS_KEY: `${secretAccessKey}-changed` }), ROOT, path),
    ];
    expect(runs.map((ran) => ran.status)).toEqual([0, 1, 1, 1, 1]);
    for (const ran of runs) {
      for (const sentinel of [...sentinels, 'not-the-password', `${secretAccessKey}-changed`]) {
        expect(ran.out + ran.err, sentinel).not.toContain(sentinel);
      }
    }
    // Nor does a fault name a host, a port or a role (item 9 of the review of PR 65): a class and an exit status.
    for (const ran of runs.slice(1)) {
      for (const name of ['ekdotico_no_such_role', 'localhost', '127.0.0.1', '8333']) {
        expect(ran.out + ran.err, name).not.toContain(name);
      }
    }
    expect(runs[1]!.err).toMatch(
      /^backup: failed \(ToolFault: psql failed \(exit \d+, connection fault\)\)\n$/,
    );
    const calls = readFileSync(log, 'utf8');
    // Arguments: the lines that begin with the tool's name. Environment: the PG lines.
    const commandLines = calls.split('\n').filter((line) => /^(pg_dump|psql) /.test(line));
    expect(commandLines.length).toBeGreaterThan(2);
    for (const line of commandLines) {
      expect(line).not.toMatch(/local-backup|not-the-password|postgres(ql)?:\/\//);
    }
    expect(calls).toContain('PGPASSWORD=local-backup');
    // A tool that is started sees no other secret of the job.
    expect(calls).not.toContain(secretAccessKey);
    await empty(COPIES);
  }, 120_000);

  // ── Rule 3: no copy without encryption ─────────────────────────────────────

  const UNREACHABLE = {
    BACKUP_DATABASE_URL: 'postgresql://ekdotico_backup:x-never-used@127.0.0.1:1/none',
    BACKUP_STORE_ENDPOINT: 'http://127.0.0.1:2',
    BACKUP_IMAGES_ENDPOINT: 'http://127.0.0.1:3',
  };

  it.each([
    ['no key file named', { BACKUP_PUBLIC_KEY_FILE: undefined }, /BACKUP_PUBLIC_KEY_FILE is not set/],
    [
      'a key file that is not there',
      { BACKUP_PUBLIC_KEY_FILE: '/nonexistent/public.pem' },
      /could not be read/,
    ],
  ])('refuses to run with %s, before it connects to anything', async (_, override, message) => {
    // The database and the stores are given addresses that answer nothing: a refusal, and not a failure to connect, is what is seen.
    const ran = await backup(good({ ...UNREACHABLE, ...override }));
    expect(ran.status).toBe(2);
    expect(ran.err).toMatch(message);
    expect(ran.out).toBe('');
    expect(readdirSync(ran.workDirectory)).toEqual([]);
  });

  it('refuses a key that is private, one that is too small, and one that is not RSA', async () => {
    const small = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const ed = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    for (const [pem, message] of [
      [privatePem, /private key/],
      [small.publicKey, /2048 bits; at least 3072/],
      [ed.publicKey, /not an RSA key/],
      ['not a key at all', /not a public key/],
    ] as const) {
      const file = join(work, `refused-${randomBytes(3).toString('hex')}.pem`);
      writeFileSync(file, pem);
      const ran = await backup(good({ ...UNREACHABLE, BACKUP_PUBLIC_KEY_FILE: file }));
      expect(ran.status).toBe(2);
      expect(ran.err).toMatch(message);
      expect(ran.out).toBe('');
    }
    expect(await copies()).toEqual([]);
  });

  // ── Rule 4: the role ───────────────────────────────────────────────────────

  it.each([
    ['the runtime role', () => urlOf('ekdotico_app', 'local-app'), /can write \d+ table/],
    [
      'the migration role',
      () => urlOf('ekdotico_migrate', 'local-migrate'),
      /can write \d+ table|create in the schema/,
    ],
    [
      'the administrator',
      () => urlOf(admin.username || userInfo().username, admin.password || 'unused'),
      /beyond a login/,
    ],
  ])('refuses to dump under %s', async (_, url, message) => {
    const ran = await backup(good({ BACKUP_DATABASE_URL: url() }));
    expect(ran.status).toBe(2);
    expect(ran.err).toMatch(message);
    expect(await copies()).toEqual([]);
    expect(readdirSync(ran.workDirectory)).toEqual([]);
  });

  it('refuses a role that cannot read every table, since the copy would not be whole', async () => {
    psql(urlOf(admin.username || userInfo().username, admin.password, databaseName), [
      '-c',
      `REVOKE SELECT ON ekdotico."Notification" FROM ekdotico_backup`,
    ]);
    try {
      const ran = await backup(good());
      expect(ran.status).toBe(2);
      expect(ran.err).toMatch(/cannot read 1 table\(s\) or sequence\(s\)/);
    } finally {
      psql(urlOf(admin.username || userInfo().username, admin.password, databaseName), [
        '-c',
        `GRANT SELECT ON ekdotico."Notification" TO ekdotico_backup`,
      ]);
    }
    expect(await copies()).toEqual([]);
  });

  // One test for each right a role could hold beyond the select of the schema (NFR-IC-17, A28; item 1 of the review
  // of PR 65). Each is granted by the administrator, the job is run, and the grant is taken away whatever happens.
  const asAdmin = (sql: string) =>
    psql(urlOf(admin.username || userInfo().username, admin.password, databaseName), ['-c', sql]);
  const serverVersion = () => Number(asAdmin('SHOW server_version_num'));

  async function refusedWith(grant: string, revoke: string, message: RegExp) {
    asAdmin(grant);
    try {
      const ran = await backup(good());
      expect(ran.status, ran.err + ran.out).toBe(2);
      expect(ran.err).toMatch(message);
      expect(ran.out).toBe('');
      expect(readdirSync(ran.workDirectory)).toEqual([]);
    } finally {
      asAdmin(revoke);
    }
    expect(await copies()).toEqual([]);
  }

  it('refuses a role that is a member of a built-in role that writes (pg_write_all_data)', async () => {
    await refusedWith(
      'GRANT pg_write_all_data TO ekdotico_backup',
      'REVOKE pg_write_all_data FROM ekdotico_backup',
      /member of 1 other role/,
    );
  });

  it('refuses a role that may only switch to another role (membership with SET and without INHERIT)', async () => {
    asAdmin('CREATE ROLE ekdotico_test_other NOLOGIN');
    try {
      await refusedWith(
        'GRANT ekdotico_test_other TO ekdotico_backup WITH INHERIT FALSE, SET TRUE',
        'REVOKE ekdotico_test_other FROM ekdotico_backup',
        /member of 1 other role/,
      );
    } finally {
      asAdmin('DROP ROLE ekdotico_test_other');
    }
  });

  it('refuses a role that may write one column of a table (a column privilege)', async () => {
    await refusedWith(
      `GRANT UPDATE (title) ON ekdotico."Document" TO ekdotico_backup`,
      `REVOKE UPDATE (title) ON ekdotico."Document" FROM ekdotico_backup`,
      /can write 1 table\(s\) of the schema, or one of their columns/,
    );
  });

  it('refuses a role that may maintain a table (MAINTAIN, PostgreSQL 17)', async () => {
    if (serverVersion() < 170000) return;
    await refusedWith(
      `GRANT MAINTAIN ON ekdotico."Notification" TO ekdotico_backup`,
      `REVOKE MAINTAIN ON ekdotico."Notification" FROM ekdotico_backup`,
      /can write 1 table\(s\)/,
    );
  });

  it('refuses a role that may execute a routine of the schema', async () => {
    asAdmin('CREATE FUNCTION ekdotico.ekdotico_test_routine() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$');
    try {
      await refusedWith(
        'REVOKE ALL ON FUNCTION ekdotico.ekdotico_test_routine() FROM PUBLIC; GRANT EXECUTE ON FUNCTION ekdotico.ekdotico_test_routine() TO ekdotico_backup',
        'REVOKE EXECUTE ON FUNCTION ekdotico.ekdotico_test_routine() FROM ekdotico_backup',
        /can execute 1 routine\(s\) of the schema/,
      );
    } finally {
      asAdmin('DROP FUNCTION ekdotico.ekdotico_test_routine()');
    }
  });

  it('refuses a role that holds a right outside the schema (a table of another schema, the right to create in public)', async () => {
    asAdmin('CREATE SCHEMA ekdotico_test_other; CREATE TABLE ekdotico_test_other.t (i int)');
    try {
      await refusedWith(
        'GRANT USAGE ON SCHEMA ekdotico_test_other TO ekdotico_backup; GRANT SELECT ON ekdotico_test_other.t TO ekdotico_backup',
        'REVOKE ALL ON ekdotico_test_other.t FROM ekdotico_backup; REVOKE ALL ON SCHEMA ekdotico_test_other FROM ekdotico_backup',
        /right outside the schema `ekdotico`/,
      );
      await refusedWith(
        'GRANT CREATE ON SCHEMA public TO ekdotico_backup',
        'REVOKE CREATE ON SCHEMA public FROM ekdotico_backup',
        /right outside the schema `ekdotico`/,
      );
    } finally {
      asAdmin('DROP SCHEMA ekdotico_test_other CASCADE');
    }
  });

  it('refuses settings that are not what the copy is: no TLS away from localhost, a bucket at DigitalOcean, one bucket for both', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [
        { BACKUP_DATABASE_URL: 'postgresql://ekdotico_backup:x@db.example.test:25060/ekdotico' },
        /sslmode=require/,
      ],
      [{ BACKUP_STORE_ENDPOINT: 'https://fra1.digitaloceanspaces.com' }, /at DigitalOcean/],
      [{ BACKUP_STORE_ENDPOINT: 'http://store.example.test' }, /must use https/],
      [{ BACKUP_STORE_BUCKET: IMAGES }, /bucket of the images/],
      [{ BACKUP_STORE_REGION: undefined as unknown as string }, /BACKUP_STORE_REGION is not set/],
    ];
    for (const [override, message] of cases) {
      const ran = await backup(good(override));
      expect(ran.status, JSON.stringify(override)).toBe(2);
      expect(ran.err).toMatch(message);
    }
    expect(await copies()).toEqual([]);
  });

  // ── Rule 6: nothing plain, nothing left ───────────────────────────────────

  it('leaves nothing in its directory when the store refuses, and stores nothing', async () => {
    const ran = await backup(good({ BACKUP_STORE_SECRET_ACCESS_KEY: 'a-secret-the-store-has-never-seen' }));
    expect(ran.status).toBe(1);
    expect(ran.err).toMatch(/^backup: failed \(/);
    expect(readdirSync(ran.workDirectory)).toEqual([]);
    expect(await copies()).toEqual([]);
  });

  it('fails, and stores nothing, when the dump fails', async () => {
    const dir = mkdtempSync(join(work, 'broken-'));
    writeFileSync(join(dir, 'pg_dump'), '#!/bin/sh\necho "pg_dump: error: the dump broke" >&2\nexit 3\n');
    chmodSync(join(dir, 'pg_dump'), 0o755);
    const ran = await backup(good(), ROOT, `${dir}:${process.env.PATH}`);
    expect(ran.status).toBe(1);
    expect(ran.err).toMatch(/pg_dump failed \(exit 3\)/);
    expect(readdirSync(ran.workDirectory)).toEqual([]);
    expect(await copies()).toEqual([]);
  });

  it('writes the sealed file with mode 0600 and no plain file at all while it runs', async () => {
    // A shim of the store's put cannot be had; the mode is read from the source and the content is shown by the test of the stored bytes.
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).toMatch(/open\(path, 'wx', 0o600\)/);
    const dump = /spawn\(\s*'pg_dump'[\s\S]*?\)/.exec(source)![0];
    expect(dump).not.toMatch(/--file|-f /);
  });

  // ── The restore refuses what it should ─────────────────────────────────────

  it('does not open a copy with another key, nor load into a schema that has tables, nor as another role', async () => {
    const [key] = await makeCopy();
    const file = join(work, 'second.ekdbak');
    writeFileSync(file, await fetchObject(COPIES, key!));
    const other = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase: PASSPHRASE },
    });
    const otherPath = join(work, 'other.pem');
    writeFileSync(otherPath, other.privateKey);
    const out = join(work, 'never');
    const refused = spawnSync('node', [RESTORE, 'decrypt', '--in', file, '--key', otherPath, '--out', out], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH!, BACKUP_KEY_PASSPHRASE: PASSPHRASE },
      encoding: 'utf8',
    });
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/does not open the copy/);
    expect(() => readdirSync(out)).toThrow(/ENOENT/);

    // A private key that is not under a passphrase is refused before the copy is touched (item 12).
    const bare = generateKeyPairSync('rsa', {
      modulusLength: 3072,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const barePath = join(work, 'bare.pem');
    writeFileSync(barePath, bare.privateKey);
    const bareOut = join(work, 'never-bare');
    const bareRefused = spawnSync(
      'node',
      [RESTORE, 'decrypt', '--in', file, '--key', barePath, '--out', bareOut],
      { env: { NODE_ENV: 'test', PATH: process.env.PATH! }, encoding: 'utf8' },
    );
    expect(bareRefused.status).toBe(2);
    expect(bareRefused.stderr).toMatch(/not encrypted with a passphrase/);
    expect(() => readdirSync(bareOut)).toThrow(/ENOENT/);

    const opened = join(work, 'opened-again');
    const ok = spawnSync('node', [RESTORE, 'decrypt', '--in', file, '--key', writeKey(), '--out', opened], {
      env: { NODE_ENV: 'test', PATH: process.env.PATH!, BACKUP_KEY_PASSPHRASE: PASSPHRASE },
      encoding: 'utf8',
    });
    expect(ok.status, ok.stderr).toBe(0);
    // Into the database the copy was taken from: it has tables, so it is refused.
    const into = spawnSync('node', [RESTORE, 'database', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_DATABASE_URL: urlOf('ekdotico_migrate', 'local-migrate'),
      },
      encoding: 'utf8',
    });
    expect(into.status).toBe(2);
    expect(into.stderr).toMatch(/already holds a table/);
    // As a role that does not own the schema.
    const emptied = provisioned('notowner');
    const wrongRole = spawnSync('node', [RESTORE, 'database', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_DATABASE_URL: urlOf('ekdotico_app', 'local-app', emptied),
      },
      encoding: 'utf8',
    });
    expect(wrongRole.status).toBe(2);
    expect(wrongRole.stderr).toMatch(/not owned by this user/);
    // Into a bucket that has an object.
    const notEmpty = spawnSync('node', [RESTORE, 'images', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_IMAGES_ENDPOINT: endpoint,
        RESTORE_IMAGES_BUCKET: RESTORED,
        RESTORE_IMAGES_ACCESS_KEY_ID: accessKeyId,
        RESTORE_IMAGES_SECRET_ACCESS_KEY: secretAccessKey,
      },
      encoding: 'utf8',
    });
    expect(notEmpty.status).toBe(2);
    expect(notEmpty.stderr).toMatch(/bucket is not empty/);

    // Away from this machine the restore requires TLS, as the job does (item 4)...
    const clear = spawnSync('node', [RESTORE, 'database', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_DATABASE_URL: 'postgresql://ekdotico_migrate:x@db.example.test:25060/ekdotico',
      },
      encoding: 'utf8',
    });
    expect(clear.status).toBe(2);
    expect(clear.stderr).toMatch(/sslmode=require/);

    // ...and takes [::1] for this machine: an http endpoint there is not refused for its scheme (item 4).
    const loopback = spawnSync('node', [RESTORE, 'images', '--dir', opened], {
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH!,
        RESTORE_IMAGES_ENDPOINT: 'http://[::1]:1',
        RESTORE_IMAGES_BUCKET: RESTORED,
        RESTORE_IMAGES_ACCESS_KEY_ID: accessKeyId,
        RESTORE_IMAGES_SECRET_ACCESS_KEY: secretAccessKey,
      },
      encoding: 'utf8',
    });
    expect(loopback.stderr).not.toMatch(/must use https/);
    expect(loopback.status).toBe(1);

    // A manifest that names an object that is not an image key puts nothing anywhere (item 13).
    const forged = join(work, 'forged');
    mkdirSync(forged, { recursive: true });
    writeFileSync(
      join(forged, 'manifest.json'),
      JSON.stringify({ format: 'ekdbak-1', entries: [{ name: '../escape', bytes: 1, sha256: 'x' }] }),
    );
    const emptyBucket = `ekdotico-test-empty-${suffix}`;
    await s3.send(new CreateBucketCommand({ Bucket: emptyBucket }));
    try {
      const bad = spawnSync('node', [RESTORE, 'images', '--dir', forged], {
        env: {
          NODE_ENV: 'test',
          PATH: process.env.PATH!,
          RESTORE_IMAGES_ENDPOINT: endpoint,
          RESTORE_IMAGES_BUCKET: emptyBucket,
          RESTORE_IMAGES_ACCESS_KEY_ID: accessKeyId,
          RESTORE_IMAGES_SECRET_ACCESS_KEY: secretAccessKey,
        },
        encoding: 'utf8',
      });
      expect(bad.status).toBe(2);
      expect(bad.stderr).toMatch(/not an image key: nothing was put/);
    } finally {
      await empty(emptyBucket);
      await s3.send(new DeleteBucketCommand({ Bucket: emptyBucket })).catch(() => {});
    }
    mkdirSync(join(work, 'unused'), { recursive: true });
  }, 120_000);

  // ── The images of the copy are those of the rows dumped (item 10) ──────────

  it('lists the images in the snapshot of the dump: a row added while the dump waits is in neither', async () => {
    // pg_dump is held by a tool that says it has started and waits for a file; the snapshot was opened before it.
    const dir = mkdtempSync(join(work, 'held-'));
    const real = spawnSync('which', ['pg_dump'], { encoding: 'utf8' }).stdout.trim();
    writeFileSync(
      join(dir, 'pg_dump'),
      `#!/bin/sh\ntouch '${dir}/started'\nwhile [ ! -f '${dir}/go' ]; do sleep 0.05; done\nexec '${real}' "$@"\n`,
    );
    chmodSync(join(dir, 'pg_dump'), 0o755);
    const running = backup(good(), ROOT, `${dir}:${process.env.PATH}`);
    const began = Date.now();
    while (!existsSync(join(dir, 'started')) && Date.now() - began < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(existsSync(join(dir, 'started'))).toBe(true);
    const later = `images/${DOCUMENT}/${'e'.repeat(32)}`;
    asAdmin(`
      INSERT INTO ekdotico."Document" (id, "workspaceId", "ownerId", title, "permissionSet", recording, "updatedAt")
        VALUES ('4a2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b', 'w1', 'u1', 'added-after-the-snapshot', '{}', 'UNRECORDED', now());
      INSERT INTO ekdotico."DocumentImage" (id, "documentId", "objectKey", "contentType", "byteSize", "uploadedById")
        VALUES ('i5', '4a2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b', '${later}', 'image/png', 2048, 'u1')`);
    try {
      writeFileSync(join(dir, 'go'), '');
      const ran = await running;
      expect(ran.status, ran.err).toBe(0);
      // Four images were listed, as before the row: the fifth is not.
      expect(ran.out).toMatch(/\(2 of 4 images, 1 no longer there, 1 refused\)/);
      const [key] = await copies();
      const file = join(work, 'snapshot.ekdbak');
      writeFileSync(file, await fetchObject(COPIES, key!));
      const opened = join(work, 'snapshot-opened');
      const decrypted = spawnSync(
        'node',
        [RESTORE, 'decrypt', '--in', file, '--key', writeKey(), '--out', opened],
        {
          env: { NODE_ENV: 'test', PATH: process.env.PATH!, BACKUP_KEY_PASSPHRASE: PASSPHRASE },
          encoding: 'utf8',
        },
      );
      expect(decrypted.status, decrypted.stderr).toBe(0);
      const text = spawnSync('pg_restore', ['-f', '-', join(opened, 'dump.pgdump')], {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
      }).stdout;
      expect(text).toContain(MARKER);
      expect(text).not.toContain('added-after-the-snapshot');
    } finally {
      asAdmin(
        `DELETE FROM ekdotico."DocumentImage" WHERE id = 'i5'; DELETE FROM ekdotico."Document" WHERE id = '4a2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b'`,
      );
    }
  }, 120_000);
});
