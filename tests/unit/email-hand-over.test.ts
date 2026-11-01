// FR-AU-87, NFR-RE-15: where the email service cannot be reached "the
// hand-over is tried again for up to 10 minutes", and the request has already
// succeeded, so nothing here may reject.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handOver } from '../../src/lib/email/hand-over.ts';
import { MessageRefused } from '../../src/lib/email/index.ts';

const MESSAGE = { to: 'person@example.com', subject: 'A subject', text: 'A text with a-single-use-token.' };
const TEN_MINUTES = 10 * 60 * 1000;
const REFERENCE = 'invitation cm0000000000000000000000';

afterEach(() => vi.restoreAllMocks());

describe('handOver', () => {
  it('hands the message over once where the service answers, and prints nothing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => {});
    const wait = vi.fn(async () => {});
    expect(await handOver(MESSAGE, REFERENCE, send, wait)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(MESSAGE);
    expect(wait).not.toHaveBeenCalled();
    expect(logged).not.toHaveBeenCalled();
  });

  it('tries again until the service answers, and says what the fault was once, at the first failure', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const send = vi.fn(async () => {
      calls += 1;
      if (calls < 4) {
        throw new Error(`could not store ${MESSAGE.text}`, {
          cause: Object.assign(new Error('permission denied'), { code: 'EACCES' }),
        });
      }
    });
    const waits: number[] = [];
    expect(await handOver(MESSAGE, REFERENCE, send, async (ms) => void waits.push(ms))).toBe(true);
    expect(send).toHaveBeenCalledTimes(4);
    expect(waits).toEqual([5_000, 10_000, 20_000]);
    // The class and the code of the fault, and nothing of its message.
    expect(logged.mock.calls).toEqual([
      [`email: hand-over failed, trying again (Error EACCES) (${REFERENCE})`],
    ]);
  });

  it('gives up within 10 minutes, without rejecting, and logs the reference and nothing of the message', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => {
      throw new Error(`could not send to ${MESSAGE.to}: ${MESSAGE.text}`);
    });
    const waits: number[] = [];
    expect(await handOver(MESSAGE, REFERENCE, send, async (ms) => void waits.push(ms))).toBe(false);
    const waited = waits.reduce((sum, ms) => sum + ms, 0);
    expect(waited).toBeLessThanOrEqual(TEN_MINUTES);
    // It did not stop early either: the next wait would have passed the 10 minutes.
    expect(waited + 60_000).toBeGreaterThan(TEN_MINUTES);
    expect(send).toHaveBeenCalledTimes(waits.length + 1);
    // Two lines however often it tried: the first failure, and the loss with what was lost.
    expect(logged.mock.calls).toEqual([
      [`email: hand-over failed, trying again (Error) (${REFERENCE})`],
      [`email: a message was not handed over within 10 minutes (${REFERENCE})`],
    ]);
    const output = JSON.stringify(logged.mock.calls);
    for (const secret of [MESSAGE.to, 'person', MESSAGE.subject, 'a-single-use-token', 'could not send']) {
      expect(output).not.toContain(secret);
    }
  });

  it('prints the kind it was given on the first line and on the loss, whatever the kind is called', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = async () => {
      throw new Error('unreachable');
    };
    expect(await handOver(MESSAGE, 'password reset', send, async () => {})).toBe(false);
    expect(logged.mock.calls.map(([line]) => line)).toEqual([
      'email: hand-over failed, trying again (Error) (password reset)',
      'email: a message was not handed over within 10 minutes (password reset)',
    ]);
  });

  it('does not try again where the message itself is refused', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const send = vi.fn(async () => {
      throw new MessageRefused(`refused: ${MESSAGE.to}`);
    });
    const wait = vi.fn(async () => {});
    expect(await handOver(MESSAGE, REFERENCE, send, wait)).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
    expect(logged.mock.calls).toEqual([
      [`email: a message was refused and not handed over (MessageRefused) (${REFERENCE})`],
    ]);
  });

  it('is refused by the sink for a line break in the recipient, with the error that is not tried again', async () => {
    const { sendEmail } = await import('../../src/lib/email/index.ts');
    await expect(
      sendEmail({ ...MESSAGE, to: 'person@example.com\nBcc: other@example.com' }),
    ).rejects.toBeInstanceOf(MessageRefused);
    await expect(sendEmail({ ...MESSAGE, subject: 'A\rsubject' })).rejects.toBeInstanceOf(MessageRefused);
  });
});
