// "Email is healthy" for the check-in of D274 (register D320, decided 17 November 2026): the last hand-over to
// Brevo was not an account fault, and the queue of emails waiting to be tried again is not growing. It is
// worked out every 15 minutes, from the email-retry timer (src/lib/timers.ts). While it holds, the timer
// checks in; while it does not, the timer stays silent and the service emails the owner.
//
// How the two words are read, from the row and from the sender's own words (src/lib/email/index.ts):
//   - An ACCOUNT FAULT is an answer that says the account, its key, or its sending domain is wrong and not
//     the message: 401, 402, 403, and any 400 that is neither a refusal of the message (`INVALID`, `MISSING`,
//     `RANGE`) nor "seen already". The sender's comment on that 400 reads: "no credits, an unverified sender
//     or domain, a key it does not know". A 429, a 5xx, a timeout and a failure to connect are an outage or a
//     limit, not the account, and change nothing here.
//   - The LAST hand-over is the last of this process that Brevo answered. A success, a refusal of one message
//     and "seen already" show that the account works, so they clear a fault. Nothing is known before the
//     first hand-over after a start, and the row states that cost: it says nothing while no email has been
//     sent since a fault began, and a restart forgets a fault.
//   - GROWING is: more rows waiting now than at the previous run of the timer. The first run has none to
//     compare with and does not count as growing.
import { printableCode } from '../fault.ts';

let lastHandOver: 'ok' | 'account-fault' | undefined;
let previousQueue: number | undefined;

/** Whether the fault of a hand-over (its `code`, as src/lib/email/index.ts puts it) is a fault of the account. */
export function isAccountFault(code: unknown): boolean {
  const text = printableCode(code);
  return text !== undefined && (['401', '402', '403'].includes(text) || /^400($|_)/.test(text));
}

/** Records what Brevo answered to the last hand-over: `ok` where it shows the account works. */
export function recordHandOver(outcome: 'ok' | 'account-fault'): void {
  lastHandOver = outcome;
}

/**
 * Whether email is healthy now, given how many rows wait to be tried again. Remembers the count for the next
 * run, so call it once for each run of the timer.
 */
export function emailHealthy(queued: number): boolean {
  const growing = previousQueue !== undefined && queued > previousQueue;
  previousQueue = queued;
  return lastHandOver !== 'account-fault' && !growing;
}

/** For the tests. */
export function forgetEmailHealth(): void {
  lastHandOver = undefined;
  previousQueue = undefined;
}
