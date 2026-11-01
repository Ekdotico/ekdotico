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
// first the email is lost and "the person can ask again". A process stops first
// on SIGTERM too: the wait ends and the message is given up, so that a restart
// does not wait out the 10 minutes (`pause`).
// ponytail: retries die with the process; an outbox table if that ever loses mail that matters.
import { faultOf } from '../fault.ts';
import { MessageRefused, MessageSentAlready, sendEmail, type EmailMessage } from './index.ts';

const WINDOW_MS = 10 * 60 * 1000;
const FIRST_WAIT_MS = 5_000;
const LONGEST_WAIT_MS = 60_000;

// SIGTERM ends every wait and stops every retry. Next.js waits for the work that `after` started before it
// lets the process exit, and a retry that is waiting would hold a restart for as long as it has left, up to
// about 11 minutes. One listener for the process, added at the first wait, and one entry in `waiting` for
// each wait that is running: nothing builds up for each message.
let stopping = false;
let listening = false;
const waiting = new Set<() => void>();

function stop() {
  stopping = true;
  for (const done of [...waiting]) done();
  // Having a listener for SIGTERM replaces what the process does by default, which is to exit. Where nothing
  // else handles the signal (Next.js and the collaboration server each do), this puts that default back.
  if (process.listenerCount('SIGTERM') === 0) process.kill(process.pid, 'SIGTERM');
}

// A wait does not keep a process alive that is otherwise ready to stop, and SIGTERM ends it at once.
function pause(ms: number): Promise<void> {
  if (!listening) {
    listening = true;
    process.once('SIGTERM', stop);
  }
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiting.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms).unref();
    waiting.add(done);
  });
}

function lost(stopped: boolean, which: string): false {
  console.error(
    stopped
      ? `email: a message was not handed over, the process is stopping${which}`
      : `email: a message was not handed over within 10 minutes${which}`,
  );
  return false;
}

/**
 * Hands one message over, trying again for up to 10 minutes. It never rejects:
 * nothing waits on it, and its failure changes no response. Returns whether
 * the message was handed over (or, for a message Brevo has seen already, very
 * likely was).
 *
 * `kind` says what a lost message was, for the person who reads the log: the
 * kind of thing, with its identifier where it has one ("invitation <id>"),
 * and never anything of a person (NFR-SE-19). It is printed on each line.
 * `send` and `wait` are parameters for the tests.
 */
export async function handOver(
  message: EmailMessage,
  kind: string,
  send: (message: EmailMessage) => Promise<void> = sendEmail,
  wait: (ms: number) => Promise<void> = pause,
): Promise<boolean> {
  const which = ` (${kind})`;
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
        console.error(`email: a message was refused and not handed over (${faultOf(error)})${which}`);
        return false;
      }
      if (error instanceof MessageSentAlready) {
        // The service has seen it: a second send would be a second email.
        console.error(
          `email: a message was seen by the service already, not sent again (${faultOf(error)})${which}`,
        );
        return true;
      }
      // Once, at the first failure: what the fault is, while it can still be mended.
      if (waited === 0) console.error(`email: hand-over failed, trying again (${faultOf(error)})${which}`);
      if (stopping || waited + next > WINDOW_MS) {
        return lost(stopping, which);
      }
      await wait(next);
      // Ended by SIGTERM: no further attempt, which could take its own 10 seconds.
      if (stopping) return lost(true, which);
      waited += next;
    }
  }
}
