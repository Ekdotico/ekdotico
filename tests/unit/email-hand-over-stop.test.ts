// NFR-RE-15 and the header of src/lib/email/hand-over.ts: a retry that is waiting gives up on SIGTERM, so that a
// restart does not wait out the 10 minutes; and the listener that does it changes nothing else about how a
// process exits. These tests use the real wait, not the parameter of the tests.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const MESSAGE = { to: 'person@example.com', subject: 'A subject', text: 'A text.' };
const fails = vi.fn(async () => {
  throw new Error('unreachable');
});

let others: ((signal: NodeJS.Signals) => void)[];
let kill: ReturnType<typeof vi.spyOn>;
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A fresh copy of the module each time: it holds the listener and the flag of one process.
async function load() {
  vi.resetModules();
  return (await import('../../src/lib/email/hand-over.ts')).handOver;
}

beforeEach(() => {
  others = process.listeners('SIGTERM') as typeof others;
  process.removeAllListeners('SIGTERM');
  // The restart of the test runner itself must never be what a test sends.
  kill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  fails.mockClear();
});

afterEach(() => {
  process.removeAllListeners('SIGTERM');
  for (const listener of others) process.on('SIGTERM', listener);
  vi.restoreAllMocks();
});

describe('handOver and SIGTERM', () => {
  it('adds no listener when the module is loaded, nor when the first send succeeds', async () => {
    const handOver = await load();
    expect(process.listenerCount('SIGTERM')).toBe(0);
    expect(await handOver(MESSAGE, 'password reset', async () => {})).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('gives up at once on SIGTERM, in the middle of a wait of 5 seconds, and says why', async () => {
    const other = vi.fn();
    process.on('SIGTERM', other);
    const handOver = await load();
    const started = Date.now();
    const done = handOver(MESSAGE, 'invitation cm0', fails);
    await pause(30);
    expect(fails).toHaveBeenCalledTimes(1); // and now it waits
    process.emit('SIGTERM');
    expect(await done).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
    // No further attempt, which could take its own 10 seconds.
    expect(fails).toHaveBeenCalledTimes(1);
    expect(console.error).toHaveBeenLastCalledWith(
      'email: a message was not handed over, the process is stopping (invitation cm0)',
    );
    // What else handles the signal still does; it is not ours to take over, nor to repeat.
    expect(other).toHaveBeenCalledTimes(1);
    expect(kill).not.toHaveBeenCalled();
  });

  it('makes a message that fails after the signal give up without waiting', async () => {
    process.on('SIGTERM', () => {});
    const handOver = await load();
    const first = handOver(MESSAGE, 'password reset', fails);
    await pause(30);
    process.emit('SIGTERM');
    await first;
    fails.mockClear();
    const started = Date.now();
    expect(await handOver(MESSAGE, 'password notice', fails)).toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(fails).toHaveBeenCalledTimes(1);
  });

  it('keeps one listener for any number of messages, and ends all their waits', async () => {
    process.on('SIGTERM', () => {});
    const handOver = await load();
    const all = Array.from({ length: 200 }, () => handOver(MESSAGE, 'password notice', fails));
    await pause(50);
    expect(process.listenerCount('SIGTERM')).toBe(2); // the one above, and ours
    process.emit('SIGTERM');
    expect(await Promise.all(all)).toEqual(Array(200).fill(false));
    expect(process.listenerCount('SIGTERM')).toBe(1); // ours was added with `once`
  });

  it('puts the default back where nothing else handles SIGTERM: the process still exits on it', async () => {
    const handOver = await load();
    const done = handOver(MESSAGE, 'password reset', fails);
    await pause(30);
    expect(process.listenerCount('SIGTERM')).toBe(1); // ours alone, which replaced the default
    process.emit('SIGTERM');
    expect(await done).toBe(false);
    expect(kill).toHaveBeenCalledExactlyOnceWith(process.pid, 'SIGTERM');
  });
});
