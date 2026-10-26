// The object store of the images over the S3 protocol: DigitalOcean Spaces in
// FRA1 in production, a local S3-compatible store on a development machine
// (NFR-SE-18; the owner's decision of 20 October 2026, S19-1). One bucket, no
// public read and no listing: the objects carry no ACL, so the bucket's own
// private setting stands, and the application never lists.
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { ImageStorageSettings } from '../settings.ts';
import type { ImageStorage } from './storage.ts';

export class S3Storage implements ImageStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(config: ImageStorageSettings) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      endpoint: config.endpoint,
      region: config.region,
      forcePathStyle: config.pathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // The SDK adds a checksum to every request and every link by default, which stores of the S3
      // protocol other than Amazon's do not all take; none is added where the protocol does not ask.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      // A store that does not answer fails the request within seconds and is tried twice more, and never holds it open (NFR-SE-06, A10).
      maxAttempts: 3,
      requestHandler: { requestTimeout: 10_000, connectionTimeout: 5_000 },
    });
  }

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bytes,
        ContentLength: bytes.length,
        // The type the server established (NFR-SE-18), and an image that a browser shows and never downloads as a document.
        ContentType: contentType,
        ContentDisposition: 'inline',
        CacheControl: 'private, no-store',
      }),
    );
  }

  async remove(key: string): Promise<void> {
    // The protocol answers 204 whether the object was there or not.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async read(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    const { Body } = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      abortSignal: signal,
    });
    if (!Body) throw new Error('image store: no body');
    // The SDK's body is a Node stream with this method; the bytes are not read until the stream is.
    return Body.transformToWebStream() as ReadableStream<Uint8Array>;
  }

  async link(key: string, seconds: number, contentType: string): Promise<string> {
    // Signed here and never sent: the link is valid for `seconds`, for this key and this method alone, and the
    // answer to it carries the type the server established and `inline`, whatever the object itself says
    // (the response overrides are part of what is signed, so a holder of the link cannot change them).
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: 'inline',
      }),
      { expiresIn: seconds },
    );
  }
}
