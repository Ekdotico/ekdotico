// The hand-over of an email of the account (FR-AU-87, NFR-RE-15): "handed to
// the transactional email service by the request that causes it, after the
// response has been returned", and "tried again for up to 10 minutes where the
// service cannot be reached". The caller starts this once its response has
// gone (in a route handler, inside `after`), so that the time a response takes
// does not show whether an email was sent.
//
// The retries live in the process that served the request, as the row of
// NFR-RE-15 has it: no table, no timer, no second instance involved. An email
// of the account "may be sent more than once", and where the process stops
// first the email is lost and "the person can ask again".
// ponytail: retries die with the process; an outbox table if that ever loses mail that matters.
import { sendEmail, type EmailMessage } from './index.ts';

const WINDOW_MS = 10 * 60 * 1000;
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 60_000;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hands one message over, trying again for up to 10 minutes. It never rejects:
 * nothing waits on it, and its failure changes no response. Returns whether
 * the message was handed over. `send` and `wait` are parameters for the tests.
 */
export async function handOver(
  message: EmailMessage,
  send: (message: EmailMessage) => Promise<void> = sendEmail,
  wait: (ms: number) => Promise<void> = pause,
): Promise<boolean> {
  let waited = 0;
  for (let next = FIRST_WAIT_MS; ; next = Math.min(next * 2, LONGEST_WAIT_MS)) {
    try {
      await send(message);
      return true;
    } catch {
      if (waited + next > WINDOW_MS) {
        // NFR-SE-19: neither the address nor the cause, which may quote the message.
        console.error('email: a message was not handed over within 10 minutes');
        return false;
      }
      await wait(next);
      waited += next;
    }
  }
}
