// The body of the response of a draft export (FR-EX-36): a stream that is read as the client takes it and not
// before, that is aborted when it makes no progress for the idle period, and that ends, in whatever way, by one
// function that runs once.
//
// BACKPRESSURE. The queue holds one chunk. A chunk is made when the one before it has been taken by whatever
// writes the response, and that does not take the next until the socket has taken the last: a client that reads
// slowly slows the reading of the store, and nothing piles up.
//
// THE IDLE PERIOD. A timer is started with the stream and restarted whenever the response makes progress, which is
// two things: the writer asks for the next chunk (so it has taken the last), and a chunk is made. It therefore runs
// out when the store stops answering, and when a client stops reading and so stops asking. When it runs out the
// stream errors, which is what Next.js turns into a destroyed connection, so that the browser reports a failed
// download and keeps no file that looks whole; and whatever the source was waiting on is aborted.
//
// THE END. A stream ends in one of five ways: its last chunk, a fault of the source, the idle period, a cancel by the
// client's disconnect, or a fault before anyone read it. `end` is what they all run, once: it stops the timer, aborts
// the source's pending work, closes the source, and calls `onEnd`, where the lock is released.
import { faultOf } from '../fault.ts';

/** The idle period passed with no progress. The message names nothing (NFR-SE-19). */
export class ExportIdle extends Error {
  override name = 'ExportIdle';
  constructor() {
    super('the response made no progress for the idle period');
  }
}

export interface GuardOptions {
  /** The idle period, in milliseconds. */
  idleMs: number;
  /** Aborted when the stream ends, so that a read of the store that is waiting is ended with it. */
  abort: AbortController;
  /** Runs once, when the stream has ended in any way. Its rejection is logged as a class and is nothing else. */
  onEnd: () => Promise<void> | void;
  /** Called whenever a chunk has been made: the lock is renewed from here. */
  onProgress?: () => void;
}

/**
 * The source as a stream. Nothing is read until the stream is: the source is an async generator that makes the
 * archive, and it makes a chunk only when `next` is called.
 */
export function guardedStream(
  source: AsyncGenerator<Uint8Array>,
  { idleMs, abort, onEnd, onProgress }: GuardOptions,
): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ending: Promise<void> | undefined;

  const end = (): Promise<void> => {
    ending ??= (async () => {
      clearTimeout(timer);
      abort.abort();
      // Closes a source that is suspended; one that is running is closed when it settles, which the abort brings about.
      source.return(undefined).catch(() => undefined);
      try {
        await onEnd();
      } catch (error) {
        console.error(`export: the end of a response was not carried out (${faultOf(error)})`);
      }
    })();
    return ending;
  };

  const fail = (error: unknown) => {
    if (ending) return;
    // One line, with the class of the fault and nothing it says (NFR-SE-19): the response is aborted, and an
    // operator can tell why.
    console.error(`export: a response was aborted (${faultOf(error)})`);
    try {
      controller.error(error);
    } catch {
      // The stream was closed or cancelled already.
    }
    void end();
  };

  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new ExportIdle()), idleMs);
    // A process that is stopping is not held up by a download.
    timer.unref?.();
  };

  return new ReadableStream<Uint8Array>({
    start(started) {
      controller = started;
      arm();
    },
    async pull() {
      if (ending) return;
      arm();
      try {
        const next = await source.next();
        if (ending) return;
        if (next.done) {
          clearTimeout(timer);
          controller.close();
          await end();
          return;
        }
        controller.enqueue(next.value);
        arm();
        onProgress?.();
      } catch (error) {
        fail(error);
      }
    },
    cancel() {
      return end();
    },
  });
}
