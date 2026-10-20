// The adapter of the object store of the images against a real store of the S3
// protocol (src/lib/images/s3-storage.ts; NFR-SE-18; the owner's decision of
// 20 October 2026, S19-1): what a link is signed for, how long it lives, that the
// bucket admits no public read and no listing, and that a deletion is idempotent.
// The tests of what the application does with a store use the store of the tests
// (./image-storage.ts); these are the ones that need the protocol itself.
//
// Run only where a store is given, by the four settings of the object store in the
// environment of the run (`.env.example`): without them every test here is skipped
// and the run says so. Each run makes a bucket of its own, and deletes it.
import { randomBytes } from 'node:crypto';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadSettings, type ImageStorageSettings } from '../../src/lib/settings.ts';
import { S3Storage } from '../../src/lib/images/s3-storage.ts';
import { newObjectKey } from '../../src/lib/images/storage.ts';
import { png } from '../unit/image-fixtures.ts';

const given = Boolean(process.env.IMAGE_STORAGE_ENDPOINT);
// A bucket of this run's own, in the name rule of the settings.
const BUCKET = `ekdotico-test-${randomBytes(6).toString('hex')}`;
const DOCUMENT = '2a7f6c1e-5b1c-4d3e-9a58-0d8c3a9d4e11';

describe.skipIf(!given)('the object store of the images (a store of the S3 protocol)', () => {
  let config: ImageStorageSettings;
  let admin: S3Client;
  let store: S3Storage;
  const made: string[] = [];

  beforeAll(async () => {
    config = loadSettings({
      FOUNDING_TEAM_EMAILS: '',
      APP_ORIGIN: 'http://localhost:3000',
      DATABASE_URL: 'postgresql://x:x@localhost:5432/x',
      VALKEY_URL: 'redis://localhost:6379',
      AUTH_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
      ...process.env,
      IMAGE_STORAGE_BUCKET: BUCKET,
    }).imageStorage!;
    admin = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.pathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
    await admin.send(new CreateBucketCommand({ Bucket: BUCKET }));
    store = new S3Storage(config);
  });

  afterAll(async () => {
    if (!given) return;
    for (const key of made)
      await admin.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key })).catch(() => {});
    const left = await admin.send(new ListObjectsV2Command({ Bucket: BUCKET })).catch(() => null);
    for (const { Key } of left?.Contents ?? [])
      await admin.send(new DeleteObjectCommand({ Bucket: BUCKET, Key }));
    await admin.send(new DeleteBucketCommand({ Bucket: BUCKET })).catch(() => {});
    admin.destroy();
  });

  async function stored(contentType = 'image/png') {
    const key = newObjectKey(DOCUMENT);
    made.push(key);
    const bytes = png();
    await store.put(key, bytes, contentType);
    return { key, bytes };
  }

  it('serves what was put, to a signed link, with the type the server established and as an image to show, not a file to save', async () => {
    const { key, bytes } = await stored();
    const response = await fetch(await store.link(key, 300, 'image/png'));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe('inline');
  });

  // The type of the answer is signed with the link: the stored object may say what it likes.
  it('answers with the type the link was signed for, whatever type the object holds', async () => {
    const { key } = await stored('text/html');
    const response = await fetch(await store.link(key, 300, 'image/webp'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/webp');
  });

  it('is a link of the lifetime asked, for a GET, to the origin that the policy of a page names', async () => {
    const { key } = await stored();
    const url = new URL(await store.link(key, 300, 'image/png'));
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    // The one origin an image is loaded from is the origin of what the store hands out (S19-4).
    expect(url.origin).toBe(config.origin);
    expect(url.pathname.endsWith(key)).toBe(true);
    expect(new URL(await store.link(key, 60, 'image/png')).searchParams.get('X-Amz-Expires')).toBe('60');
  });

  it('is refused once its time has passed', async () => {
    const { key } = await stored();
    const url = await store.link(key, 1, 'image/png');
    expect((await fetch(url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 3000));
    expect((await fetch(url)).status).toBe(403);
  });

  it('is for one object: the signature serves no other key, and no other type', async () => {
    const first = await stored();
    const second = await stored();
    const url = await store.link(first.key, 300, 'image/png');
    expect((await fetch(url.replace(first.key, second.key))).status).toBe(403);
    expect((await fetch(url.replace('image%2Fpng', 'text%2Fhtml'))).status).toBe(403);
    expect(
      (
        await fetch(
          url.replace('response-content-disposition=inline', 'response-content-disposition=attachment'),
        )
      ).status,
    ).toBe(403);
    expect(
      (await fetch(url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64)))).status,
    ).toBe(403);
    expect((await fetch(url.replace(/X-Amz-Expires=\d+/, 'X-Amz-Expires=604800'))).status).toBe(403);
  });

  it('is for a GET alone: it puts nothing and deletes nothing', async () => {
    const { key } = await stored();
    const url = await store.link(key, 300, 'image/png');
    expect((await fetch(url, { method: 'PUT', body: 'x' })).status).toBe(403);
    expect((await fetch(url, { method: 'DELETE' })).status).toBe(403);
    expect((await fetch(url)).status).toBe(200);
  });

  it('admits no public read and no listing: the object and the bucket are refused to a request that is not signed', async () => {
    const { key } = await stored();
    const base = new URL(await store.link(key, 300, 'image/png'));
    const unsigned = new URL(base.origin + base.pathname);
    expect((await fetch(unsigned)).status).toBe(403);
    // The bucket: in the path where the store has it there, and at the root of its own host where Spaces has it.
    const bucket = config.pathStyle ? `${config.endpoint}/${BUCKET}` : config.origin;
    expect((await fetch(`${bucket}?list-type=2`)).status).toBe(403);
    expect((await fetch(`${bucket}/?prefix=images/`)).status).toBe(403);
  });

  it('deletes an object, and an object that is not there is no fault', async () => {
    const { key } = await stored();
    const url = await store.link(key, 300, 'image/png');
    expect((await fetch(url)).status).toBe(200);
    await store.remove(key);
    expect((await fetch(url)).status).toBe(404);
    await expect(store.remove(key)).resolves.toBeUndefined();
    await expect(store.remove(newObjectKey(DOCUMENT))).resolves.toBeUndefined();
  });

  it('keeps nothing under a key that was deleted, and the keys of two documents apart', async () => {
    const a = await stored();
    const other = newObjectKey('9b0b1b9e-7c0a-4a45-8f0d-6d2f3a7e1c22');
    made.push(other);
    await store.put(other, png(), 'image/png');
    await store.remove(a.key);
    expect((await fetch(await store.link(other, 300, 'image/png'))).status).toBe(200);
  });
});
