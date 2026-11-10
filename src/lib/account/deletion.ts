// The confirmation of the deletion of an account (FR-AU-58): the refusal while
// the account owns a document, and the record that makes the deletion happen.
// The steps that follow are in ./deletion-steps.ts, and are the timer's.
//
// Nothing here is of Next.js, and nothing here asks for a password: the route
// does that first (src/app/api/account/route.ts), "immediately before the
// action", and this runs only for a request whose password and code were right.
import type { Prisma } from '../../generated/prisma/client.ts';
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { securityLogIn } from '../security-log.ts';

/** What the deletion screen says of the documents an account owns (FR-AU-58). */
export interface OwnedDocuments {
  /** Every document the account is the Owner of, a deleted one within its retention included (FR-ED-36). */
  owned: number;
  /** Of those, the ones in the list of deleted documents: they still count, until they are deleted permanently. */
  deleted: number;
}

/**
 * "Ekdotico shall refuse the deletion while the account owns any document, a deleted document within
 * its retention included (FR-ED-36)": a row whose Owner this is, whatever its `deletedAt`. A document
 * claimed for its permanent deletion is still a row until the row is deleted, and so it counts. The
 * number the refusal states (FR-AU-58: "the answer states how many").
 */
export async function ownedDocuments(userId: string): Promise<OwnedDocuments> {
  const [owned, deleted] = await Promise.all([
    db().document.count({ where: { ownerId: userId } }),
    // A document under a clearing is not in that list, though its claim sets `deletedAt` (FR-AU-91).
    db().document.count({ where: { ownerId: userId, deletedAt: { not: null }, clearingAt: null } }),
  ]);
  return { owned, deleted };
}

/**
 * What a confirmation asks again inside its transaction, as every change under a prompt does
 * (src/lib/auth/two-factor.ts, `standing`): whether the password that was verified is still the
 * account's, and the session still stands. Each is asked as a write, which waits for a reset, a
 * change of the password or the end of the session that has not yet committed. The route supplies it.
 */
export type Standing = (tx: Prisma.TransactionClient) => Promise<'held' | 'ended' | 'outrun'>;

export type ConfirmResult =
  /** The deletion is recorded: the account makes no request from here, and the steps follow. */
  | { outcome: 'confirmed' }
  /** The session ended since the request was authorised (FR-AU-84): nothing was recorded. */
  | { outcome: 'ended' }
  /** The password was set since it was verified (FR-AU-85, FR-AU-86): nothing was recorded. */
  | { outcome: 'outrun' }
  /** It was recorded already, by a request beside this one: the same answer, and no second record. */
  | { outcome: 'already_confirmed' }
  /** FR-AU-58: the account owns documents, and this many. Nothing is recorded. */
  | { outcome: 'owns_documents'; documents: number }
  /** There is no such account, or it is a tombstone already. */
  | { outcome: 'not_found' };

/**
 * FR-AU-58: "Once the user has confirmed, Ekdotico shall record the deletion, in the same transaction
 * in which it checks that the account owns no document".
 *
 * The row of the account is taken `FOR UPDATE` first. Whatever makes an account the Owner of a
 * document takes the same row `FOR SHARE` (`holdOwnableAccount`), so of a creation or an acceptance
 * and this, one waits for the other, and this counts the documents after it: a document made a moment
 * ago is counted, or the creation finds the record and is refused. Without it, the count and the
 * record could be separated by a document, and a deleted account would own it.
 *
 * The record is the gate: from its commit the account has no session (src/lib/auth/session.ts), signs
 * in nowhere (src/lib/auth/sign-in.ts), and its connections are closed (step (a), FR-ED-40 (d)): the
 * collaboration servers are told once it has committed, and never before, and a notice that is lost
 * is made good by their re-check within 60 seconds (src/lib/collab/events.ts).
 *
 * NFR-SE-19: the entry of step (a) is written in this transaction, so that the record does not stand
 * without it. It names the user and nothing else.
 */
export async function confirmDeletion(
  userId: string,
  standing: Standing,
  now: Date = new Date(),
): Promise<ConfirmResult> {
  const result = await db().$transaction(async (tx): Promise<ConfirmResult> => {
    // The password and the session first, as a change of the password takes them (the credentials,
    // then the session, and the row of the account last), so that none waits for another in a circle.
    const stands = await standing(tx);
    if (stands !== 'held') return { outcome: stands };
    const held = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "ekdotico"."User"
      WHERE "id" = ${userId} AND "erasedAt" IS NULL
      FOR UPDATE`;
    if (held.length === 0) return { outcome: 'not_found' };
    if ((await tx.accountDeletion.count({ where: { userId } })) > 0) return { outcome: 'already_confirmed' };
    const documents = await tx.document.count({ where: { ownerId: userId } });
    if (documents > 0) return { outcome: 'owns_documents', documents };
    await tx.accountDeletion.create({ data: { userId, requestedAt: now } });
    await securityLogIn(tx, { kind: 'account_deletion_connections_closed', userId });
    return { outcome: 'confirmed' };
  });
  // FR-ED-40 (d): every connection the user holds is closed within 5 seconds of the commit. The
  // collaboration server reads the rows (`accountStands`), not the notice, and never rejects here.
  if (result.outcome === 'confirmed') await publishCollabEvent({ kind: 'session-ended', userId });
  return result;
}
