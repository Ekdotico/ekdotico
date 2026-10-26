// The body of the response of a draft export (FR-EX-36; src/lib/export/stream.ts): read as it is taken, aborted
// when it makes no progress, and ended by one function that runs once however it ended. "A response that has sent
// nothing for 30 seconds is aborted in the same way" and "a client that stalls cannot hold resources past the idle
// time-out": each way a stream can stop is a test here, with the clock in the test's hands.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportIdle, guardedStream } from '../../src/lib/export/stream.ts';

const IDLE = 30_000;
const chunk = (n: number) => new Uint8Array([n]);

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A source whose chunks the test makes by hand, and that records what was done to it. */
function source(
  body: (record: { made: number; closed: boolean }, signal: AbortSignal) => AsyncGenerator<Uint8Array>,
) {
  const abort = new AbortController();
  const record = { made: 0, closed: false };
  const generator = body(record, abort.signal);
  return { abort, record, generator };
}

/** A stream over a source, with the end counted. */
function over(made: ReturnType<typeof source>, idleMs = IDLE) {
  const ends: string[] = [];
  const progress = vi.fn();
  const stream = guardedStream(made.generator, {
    idleMs,
    abort: made.abort,
    onEnd: () => {
      ends.push('end');
    },
    onProgress: progress,
  });
  return { stream, ends, progress };
}

/** Waits for a promise while the clock moves, since a timer may be what settles it. */
async function settle<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  const result = promise.then(
    (value) => ({ status: 'fulfilled', value }) as const,
    (reason: unknown) => ({ status: 'rejected', reason }) as const,
  );
  await vi.advanceTimersByTimeAsync(0);
  return result;
}

async function* numbers(
  record: { made: number; closed: boolean },
  count: number,
): AsyncGenerator<Uint8Array> {
  try {
    for (let n = 0; n < count; n += 1) {
      record.made += 1;
      yield chunk(n);
    }
  } finally {
    record.closed = true;
  }
}

describe('reading', () => {
  it('passes every chunk in order and ends, once', async () => {
    const made = source((record) => numbers(record, 5));
    const { stream, ends } = over(made);
    const read: number[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      read.push(value[0]!);
    }
    expect(read).toEqual([0, 1, 2, 3, 4]);
    expect(ends).toEqual(['end']);
    expect(made.abort.signal.aborted).toBe(true);
    expect(made.record.closed).toBe(true);
  });

  it('makes no more than one chunk ahead of the reader, however long it waits', async () => {
    const made = source((record) => numbers(record, 1_000_000));
    const { stream } = over(made);
    const reader = stream.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(IDLE / 2);
    // One taken, and one waiting in the queue.
    expect(made.record.made).toBeLessThanOrEqual(3);
    for (let n = 0; n < 50; n += 1) await reader.read();
    expect(made.record.made).toBeLessThanOrEqual(54);
    await reader.cancel();
  });

  it('calls for progress as chunks are made', async () => {
    const made = source((record) => numbers(record, 3));
    const { stream, progress } = over(made);
    const reader = stream.getReader();
    while (!(await reader.read()).done);
    expect(progress).toHaveBeenCalledTimes(3);
  });
});

describe('the idle period', () => {
  it('aborts a source that makes nothing, errors the reader, and ends once', async () => {
    const made = source(async function* (record, signal) {
      yield chunk(1);
      // The store stops answering: nothing comes until the read is aborted.
      await new Promise<void>((_, reject) =>
        signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
      record.made += 1;
      yield chunk(2);
    });
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(chunk(1));
    const second = settle(reader.read());
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(made.abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await second;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason).toBeInstanceOf(ExportIdle);
    expect(made.abort.signal.aborted).toBe(true);
    expect(ends).toEqual(['end']);
  });

  it('aborts a response whose client has stopped reading, with a chunk made and waiting', async () => {
    const made = source((record) => numbers(record, 1_000_000));
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    await reader.read();
    // The client takes nothing more.
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(ends).toEqual(['end']);
    expect(made.abort.signal.aborted).toBe(true);
    await expect(reader.read()).rejects.toBeInstanceOf(ExportIdle);
    // Nothing is made after the end.
    const after = made.record.made;
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(made.record.made).toBe(after);
  });

  it('is restarted by progress, so that a slow response that moves is not aborted', async () => {
    const made = source(async function* (record) {
      for (let n = 0; n < 8; n += 1) {
        await new Promise((resolve) => setTimeout(resolve, IDLE * 0.6));
        record.made += 1;
        yield chunk(n);
      }
    });
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    const read: number[] = [];
    const all = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        read.push(value[0]!);
      }
    })();
    await vi.advanceTimersByTimeAsync(IDLE * 6);
    await all;
    expect(read).toHaveLength(8);
    expect(ends).toEqual(['end']);
  });

  it('aborts a stream that nobody ever read, so that a client that left before the first byte holds nothing', async () => {
    const made = source((record) => numbers(record, 1_000_000));
    const { ends } = over(made);
    await vi.advanceTimersByTimeAsync(IDLE + 1);
    expect(ends).toEqual(['end']);
    expect(made.abort.signal.aborted).toBe(true);
  });

  it('uses the period it is given', async () => {
    const made = source((record) => numbers(record, 1_000_000));
    const { ends } = over(made, 1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(ends).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(ends).toEqual(['end']);
  });
});

describe('every end runs the same function, once', () => {
  it('a fault of the source after the first chunk errors the reader with it', async () => {
    const boom = new Error('boom');
    const made = source(async function* () {
      yield chunk(1);
      throw boom;
    });
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual(chunk(1));
    await expect(reader.read()).rejects.toBe(boom);
    expect(ends).toEqual(['end']);
    expect(made.abort.signal.aborted).toBe(true);
  });

  it('a fault of the source before any chunk errors the reader with it', async () => {
    const boom = new Error('first');
    const made = source(async function* () {
      throw boom;
      yield chunk(0);
    });
    const { stream, ends } = over(made);
    await expect(stream.getReader().read()).rejects.toBe(boom);
    expect(ends).toEqual(['end']);
  });

  it('a cancel by the client aborts the source, closes it, and ends', async () => {
    const made = source((record) => numbers(record, 1_000_000));
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    await reader.read();
    await reader.cancel();
    await vi.advanceTimersByTimeAsync(0);
    expect(ends).toEqual(['end']);
    expect(made.abort.signal.aborted).toBe(true);
    expect(made.record.closed).toBe(true);
  });

  it('a cancel of a source that is waiting on the store ends without waiting for it', async () => {
    const made = source(async function* () {
      yield chunk(1);
      await new Promise(() => {}); // Ignores the signal, as a store that is gone does.
    });
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    await reader.read();
    await vi.advanceTimersByTimeAsync(0);
    await reader.cancel();
    expect(ends).toEqual(['end']);
  });

  it('ends once whatever comes first and whatever comes after', async () => {
    const made = source(async function* (record) {
      record.made += 1;
      yield chunk(1);
      throw new Error('late');
    });
    const { stream, ends } = over(made);
    const reader = stream.getReader();
    await reader.read();
    await reader.read().catch(() => undefined);
    await reader.cancel().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(ends).toEqual(['end']);
  });

  it('says only the class of a fault when the end itself fails', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'error').mockImplementation((line: string) => void lines.push(line));
    const made = source((record) => numbers(record, 1));
    const secret = 'a title that must not be logged';
    const stream = guardedStream(made.generator, {
      idleMs: IDLE,
      abort: made.abort,
      onEnd: () => {
        throw new TypeError(secret);
      },
    });
    const reader = stream.getReader();
    while (!(await reader.read()).done);
    await vi.advanceTimersByTimeAsync(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('TypeError');
    expect(lines[0]).not.toContain(secret);
  });
});
