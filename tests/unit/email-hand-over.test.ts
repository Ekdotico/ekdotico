// FR-AU-87, NFR-RE-15: where the email service cannot be reached "the
// hand-over is tried again for up to 10 minutes", and the request has already
// succeeded, so nothing here may reject.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOver } from '../../src/lib/email/hand-over.ts';

const MESSAGE = { to: 'person@example.com', subject: 'A subject', text: 'A text with a-single-use-token.' };
const TEN_MINUTES = 10 * 60 * 1000;

afterEach(() => vi.restoreAllMocks());

describe('handOver', () => {
  it('hands the message over once where the service answers', async () => {
    const send = vi.fn(async () => {});
    const wait = vi.fn(async () => {});
    expect(await handOver(MESSAGE, send, wait)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(MESSAGE);
    expect(wait).not.toHaveBeenCalled();
  });

  it('tries again until the service answers', async () => {
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls < 4) throw new Error('unreachable');
    });
    const waits: number[] = [];
    expect(await handOver(MESSAGE, send, async (ms) => void waits.push(ms))).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([5_000, 10_000, 20_000]);
  });

  it('gives up within 10 minutes, without rejecting, and logs nothing of the message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => {
      throw new Error(`could not send to ${MESSAGE.to}: ${MESSAGE.text}`);
    });
    const waits: number[] = [];
    expect(await handOver(MESSAGE, send, async (ms) => void waits.push(ms))).toBe(false);
    const waited = waits.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(TEN_MINUTES);
    // It did not stop early either: the next wait would have passed the 10 minutes.
    expect(waited + 60_000).toBeGreaterThan(TEN_MINUTES);
    expect(send).toHaveBeenCalledTimes(waits.length + 1);
    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain('not handed over');
    for (const secret of [MESSAGE.to, 'person', MESSAGE.subject, 'a-single-use-token', 'could not send']) {
      expect(output).not.toContain(secret);
    }
  });
});
