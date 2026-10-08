// The security log of NFR-SE-19: a table in the application schema, written by
// the runtime role and sent to no outside service (NFR-DP-05). An entry holds
// the time, the kind, the application's user identifier and the document
// identifier, "and nothing else about a person", so the entry type has no free
// text and no bag of extras, and the kind is one of a closed list.
//
// `securityLog` below never rejects, and that rule is for the refusals alone.
// The entry of a change (the collaborators, the permission set, the Owner, a
// deletion, each step of an account deletion) is written in the transaction of
// the change, so that neither stands without the other, by `securityLogIn`.
import { db } from './db.ts';
import { faultOf } from './fault.ts';
import { settings } from './settings.ts';

// One kind for each event NFR-SE-19 lists. An entry holds no detail, so each
// step of an account deletion, (a) to (f) of FR-AU-58, is told by its kind.
// Stored as text: a database enum would put an ALTER TYPE in every migration
// that adds a kind, and the list is checked here before every write.
const KINDS = [
  'sign_in_refused',
  'forbidden',
  'rate_limit_reached',
  'signature_invalid',
  'collaborators_changed',
  'permission_set_changed',
  'owner_changed',
  'document_deleted',
  'account_deletion_connections_closed',
  'account_deletion_istorico_pseudonymised',
  'account_deletion_feedback_pseudonymised',
  'account_deletion_credentials_deleted',
  'account_deletion_user_pseudonymised',
  'account_deletion_roles_ended',
] as const;

export type SecurityLogKind = (typeof KINDS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Writes one entry. It never rejects.
 *
 * NFR-SE-06, A10: the callers are refusals (a refused sign-in, a 403, a 429, a
 * signature that did not verify). A caller has decided its response before it
 * logs; were a failed write to throw, that response would become a 500, or a
 * careless `catch` could let the request through. So the failure changes no
 * control flow: the refusal stands.
 * A09: the failure is not silent. It is reported on stderr with the kind and
 * with the class and code of the fault, never the database's message, which
 * can quote the values of the row.
 */
export async function securityLog(entry: {
  kind: SecurityLogKind;
  userId?: string;
  documentId?: string;
}): Promise<void> {
  // The type is erased at run time. A kind outside the list could be anything,
  // an address included, so it is neither stored nor printed.
  if (!KINDS.includes(entry.kind)) {
    console.error('security log: entry not written (unknown kind)');
    return;
  }
  try {
    // Named one by one, so that nothing else a caller's object carries is stored.
    await db().securityLogEntry.create({
      data: { kind: entry.kind, userId: entry.userId, documentId: entry.documentId },
    });
  } catch (error) {
    console.error(`security log: entry not written (${entry.kind}: ${faultOf(error)})`);
  }
}

/**
 * Writes the entry of a change, in the transaction of the change. It REJECTS
 * where the entry is not written, and the transaction with it: the change
 * does not stand without its entry (NFR-SE-19), as the entry cannot stand
 * without the change. The opposite of `securityLog`, on purpose.
 *
 * `transaction` is the client Prisma hands the callback of `$transaction`.
 * What is thrown for a kind outside the list names no kind: see `securityLog`.
 */
export async function securityLogIn(
  transaction: Pick<ReturnType<typeof db>, 'securityLogEntry'>,
  entry: { kind: SecurityLogKind; userId?: string; documentId?: string },
): Promise<void> {
  if (!KINDS.includes(entry.kind)) throw new Error('security log: unknown kind');
  await transaction.securityLogEntry.create({
    data: { kind: entry.kind, userId: entry.userId, documentId: entry.documentId },
  });
}

/** Deletes the entries older than the retention period; returns how many. */
export async function deleteExpiredSecurityLog(now: Date = new Date()): Promise<number> {
  const before = new Date(now.getTime() - settings().securityLogRetentionDays * DAY_MS);
  const { count } = await db().securityLogEntry.deleteMany({ where: { createdAt: { lt: before } } });
  return count;
}
