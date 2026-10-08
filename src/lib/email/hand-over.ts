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
import { faultOf } from '../fault.ts';
import { MessageRefused, sendEmail, type EmailMessage } from './index.ts';

const WINDOW_MS = 10 * 60 * 1000;
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 60_000;

// A wait does not keep a process alive that is otherwise ready to stop.
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

/**
 * Hands one message over, trying again for up to 10 minutes. It never rejects:
 * nothing waits on it, and its failure changes no response. Returns whether
 * the message was handed over.
 *
 * `reference` says what a lost message was, for the person who reads the log:
 * the kind of thing and its identifier ("invitation <id>"), and never anything
 * of a person (NFR-SE-19). `send` and `wait` are parameters for the tests.
 */
export async function handOver(
  message: EmailMessage,
  reference?: string,
  send: (message: EmailMessage) => Promise<void> = sendEmail,
  wait: (ms: number) => Promise<void> = pause,
): Promise<boolean> {
  const which = reference ? ` (${reference})` : '';
  let waited = 0;
  for (let next = FIRST_WAIT_MS; ; next = Math.min(next * 2, LONGEST_WAIT_MS)) {
    try {
      await send(message);
      return true;
    } catch (error) {
      // NFR-SE-19, in each line: neither the address nor the message of the
      // fault, which may quote the email. Its class and its code alone.
      if (error instanceof MessageRefused) {
        // The message itself is at fault, and would be refused each time.
        console.error(`email: a message was refused and not handed over${which}`);
        return false;
      }
      // Once, at the first failure: what the fault is, while it can still be mended.
      if (waited === 0) console.error(`email: hand-over failed, trying again (${faultOf(error)})`);
      if (waited + next > WINDOW_MS) {
        console.error(`email: a message was not handed over within 10 minutes${which}`);
        return false;
      }
      await wait(next);
      waited += next;
    }
  }
}
