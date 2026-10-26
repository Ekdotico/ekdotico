// The in-memory object store of the tests (src/lib/images/storage.ts): what the code that stores and deletes images
// is tested against until the adapter for DigitalOcean Spaces and its local equivalent exist (register row S19-1).
// It keeps every call, so that a test can say how many objects a run removed or read, and it fails on demand where a
// test needs the store to. Reading is by the pull: a chunk is made only when the consumer asks for one, so a test
// can see how far ahead of its consumer a reader runs.
import type { ImageStorage } from '../../src/lib/images/storage.ts';

/** How a read of one object goes wrong, for a test of the export's failures. */
export interface ReadFault {
  /** The read is refused before any byte, with this fault. */
  open?: Error;
  /** The stream errors with this fault after this many bytes. */
  after?: { bytes: number; error: Error };
  /** The stream makes no byte after this many, until the read is aborted: a store that stops answering. */
  stallAfter?: number;
  /** The stream ends after this many bytes, as if the object were shorter than its row says. */
  endAfter?: number;
  /** The stream sends this many bytes more than the object holds. */
  extra?: number;
}

export class MemoryStorage implements ImageStorage {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  /** The keys of every call of `remove`, in order, whether the object was there or not. */
  readonly removals: string[] = [];
  /** Keys that the store fails to remove, with the fault it throws. */
  readonly failing = new Map<string, Error>();
  /** The keys of every call of `read`, in order. */
  readonly reads: string[] = [];
  /** How many bytes the consumers of the reads have asked for so far, in all. */
  pulled = 0;
  /** How many reads were aborted by their signal. */
  aborted = 0;
  /** How many reads are open now: begun, and neither read to the end, nor failed, nor cancelled. */
  open = 0;
  /** What goes wrong with a read of a key. */
  readonly faults = new Map<string, ReadFault>();
  /** The size of a chunk a read makes. */
  chunk = 16 * 1024;

  async put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    this.objects.set(key, { bytes, contentType });
  }

  async remove(key: string): Promise<void> {
    this.removals.push(key);
    const fault = this.failing.get(key);
    if (fault) throw fault;
    this.objects.delete(key);
  }

  async read(key: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
    this.reads.push(key);
    if (signal?.aborted) throw new Error('aborted');
    const fault = this.faults.get(key);
    if (fault?.open) throw fault.open;
    const object = this.objects.get(key);
    if (!object) throw new Error('no such object');
    const whole = fault?.extra
      ? Buffer.concat([object.bytes, Buffer.alloc(fault.extra, 7)])
      : Buffer.from(object.bytes);
    const end = Math.min(whole.length, fault?.endAfter ?? Infinity);
    let at = 0;
    this.open += 1;
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.open -= 1;
    };
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          // The store's request is ended by its signal, whatever the stream was doing.
          signal?.addEventListener(
            'abort',
            () => {
              if (closed) return;
              this.aborted += 1;
              close();
              controller.error(new Error('aborted'));
            },
            { once: true },
          );
        },
        pull: (controller) =>
          new Promise<void>((resolve) => {
            const next = () => {
              if (fault?.after && at >= fault.after.bytes) {
                close();
                controller.error(fault.after.error);
              } else if (at >= end) {
                close();
                controller.close();
              } else {
                const limit = Math.min(end, fault?.after ? fault.after.bytes : end);
                const piece = whole.subarray(at, Math.min(at + this.chunk, limit));
                at += piece.length;
                this.pulled += piece.length;
                controller.enqueue(new Uint8Array(piece));
              }
              resolve();
            };
            // A stalled read never answers; its signal ends it.
            if (fault?.stallAfter !== undefined && at >= fault.stallAfter) return;
            next();
          }),
        cancel: () => close(),
      },
      { highWaterMark: 0 },
    );
  }

  async link(key: string, seconds: number): Promise<string> {
    return `memory://${key}?expires=${seconds}`;
  }
}
