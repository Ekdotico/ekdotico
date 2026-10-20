// The in-memory object store of the tests (src/lib/images/storage.ts): what the
// code that stores and deletes images is tested against until the adapter for
// DigitalOcean Spaces and its local equivalent exist (register row S19-1). It
// keeps every call, so that a test can say how many objects a run removed, and
// it fails on demand where a test needs the store to.
import type { ImageStorage } from '../../src/lib/images/storage.ts';

export class MemoryStorage implements ImageStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** The keys of every call of `remove`, in order, whether the object was there or not. */
  readonly removals: string[] = [];
  /** Keys that the store fails to remove, with the fault it throws. */
  readonly failing = new Map<string, Error>();

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }

  async remove(key: string): Promise<void> {
    this.removals.push(key);
    const fault = this.failing.get(key);
    if (fault) throw fault;
    this.objects.delete(key);
  }

  async link(key: string, seconds: number): Promise<string> {
    return `memory://${key}?expires=${seconds}`;
  }
}
