// D263, NFR-RE-15: where the transactional email service CERTAINLY did not take an email of a document, the email is
// kept for a later attempt (src/lib/email/retry.ts). What is kept is a row of `EmailRetry`: the kind, the subject,
// and the account. No address, no link, no content: the email is made again from the rows it names.
//
// NFR-SE-19: nothing here logs.
import type { EmailRetryKind } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';
import { certainlyNotTaken, type EmailMessage } from './index.ts';

export type RetryRef = { kind: EmailRetryKind; subjectId: string; userId: string };

/** Writes the row. Idempotent: the same email waits once. */
export async function queueRetry({ kind, subjectId, userId }: RetryRef): Promise<void> {
  await db().emailRetry.createMany({ data: [{ kind, subjectId, userId }], skipDuplicates: true });
}

/**
 * Hands one email over through `send`. Where the service certainly did not take it, the email is queued for the
 * timer, and the fault is thrown all the same, so that the caller's own line is written as before. Any other fault
 * (a timeout, a broken connection, a 5xx, a refusal of the message) queues nothing: the outcome is unknown, or it
 * would be refused each time (FR-ED-21).
 */
export async function sendOrQueue(
  send: (message: EmailMessage) => Promise<void>,
  message: EmailMessage,
  ref: RetryRef,
): Promise<void> {
  try {
    await send(message);
  } catch (error) {
    if (certainlyNotTaken(error)) await queueRetry(ref);
    throw error;
  }
}
