// An account whose deletion has been confirmed (FR-AU-58). From the moment the
// row of `AccountDeletion` is committed, "the account can make no further
// request other than those of this deletion", and "a sign-in to the account is
// refused with the statement of FR-AU-81". The rest of this slice asks the two
// questions of this file, and no other table, to tell such an account.
//
// Nothing here is of Next.js: the collaboration server loads it too, through
// the validation of a session.
import type { Prisma } from '../../generated/prisma/client.ts';
import { db } from '../db.ts';

/** The columns of a client or of a transaction that these functions read. */
type Rows = Pick<Prisma.TransactionClient, 'accountDeletion'>;

/**
 * Whether the deletion of this account is confirmed. One read by the unique
 * index, made for an identifier that belongs to no account as for one that
 * does (`undefined` asks for none), so that a sign-in does not show which it
 * is (FR-AU-81). Never from a cache: the signed copy of a session is up to a
 * minute old, and this must hold from the commit of the confirmation.
 */
export async function inDeletion(userId: string | undefined, client: Rows = db()): Promise<boolean> {
  return (await client.accountDeletion.count({ where: { userId: userId ?? '' } })) > 0;
}

/**
 * Inside a transaction: holds the row of the account against the confirmation
 * of its deletion, until the commit, and says whether the account may be made
 * the Owner of a document. False where it is not there or its deletion is
 * confirmed.
 *
 * FR-AU-58: "the deletion is recorded in the same transaction in which it
 * checks that the account owns no document, … so that no deleted account is
 * ever the Owner of a document". The confirmation takes the row `FOR UPDATE`
 * and counts the documents under it; whatever makes an account the Owner of a
 * document (its creation of one, its acceptance of an offer) takes the same
 * row `FOR SHARE` and asks for the confirmation, so of the two, one waits for
 * the other and reads what it left: either the document is counted, or the
 * confirmation is found. A raw statement, because Prisma has no read that locks
 * a row; parameterised (NFR-SE-06, A05), and naming its own schema, since a raw
 * query is not given the one the client names (src/lib/db.ts).
 */
export async function holdOwnableAccount(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | 'accountDeletion'>,
  userId: string,
): Promise<boolean> {
  const held = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "ekdotico"."User"
    WHERE "id" = ${userId} AND "erasedAt" IS NULL
    FOR SHARE`;
  if (held.length === 0) return false;
  return !(await inDeletion(userId, tx));
}

/** Thrown where an account in deletion would become the Owner of a document; a route answers it as it answers a request without a session. */
export class AccountInDeletion extends Error {
  name = 'AccountInDeletion';
  constructor() {
    super('The deletion of this account is confirmed.');
  }
}
