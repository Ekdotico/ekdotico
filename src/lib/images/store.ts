// The object store of this process: the one the settings name, or none (a
// development machine that has given no settings for it). Made once.
import { settings } from '../settings.ts';
import { S3Storage } from './s3-storage.ts';
import type { ImageStorage } from './storage.ts';

let current: ImageStorage | null | undefined;

/** The store of the images, or null where there is none: no image can then be uploaded, shown, or deleted. */
export function imageStorage(): ImageStorage | null {
  if (current === undefined) {
    const config = settings().imageStorage;
    current = config ? new S3Storage(config) : null;
  }
  return current;
}

/** For the tests: a store of their own, or null for none; undefined makes the next call read the settings again. */
export function useImageStorage(storage: ImageStorage | null | undefined): void {
  current = storage;
}
