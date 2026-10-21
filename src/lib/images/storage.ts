// The interface of the object store for images (FR-ED-08, NFR-SE-18): DigitalOcean
// Spaces in production, a local S3-compatible store in development; the adapter
// is ./s3-storage.ts and `imageStorage()` of ./store.ts hands it out. Everything
// that stores or deletes an image takes a store as a parameter, so that the code
// is tested against the in-memory one of the tests as well as against a real one.
import { randomBytes } from 'node:crypto';

export interface ImageStorage {
  /** Stores the bytes under the key, with the type the server established. */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  /**
   * Deletes the object. An object that is not there is no fault: a deletion that
   * is repeated, or that another instance made first, finds nothing (NFR-RE-15:
   * idempotent).
   */
  remove(key: string): Promise<void>;
  /**
   * A signed link for a GET of the object that is valid for `seconds` and for
   * this key alone, and the storage's own answer to it carries the type given.
   * Issued only by a route that has a session and access to the document
   * (NFR-SE-18); never stored.
   */
  link(key: string, seconds: number, contentType: string): Promise<string>;
}

const PREFIX = 'images';

/**
 * A key for an image of a document: it names its document (NFR-SE-18), cannot
 * be guessed (128 random bits), and holds nothing a user typed: there is no
 * parameter for a file name.
 */
export function newObjectKey(documentId: string): string {
  return `${PREFIX}/${documentId}/${randomBytes(16).toString('hex')}`;
}

/** The document a key names, or null where it is not a key of this form. */
export function documentOfKey(key: string): string | null {
  const match = /^images\/([0-9a-f-]{36})\/[0-9a-f]{32}$/.exec(key);
  return match ? match[1]! : null;
}
