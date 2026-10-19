// Changing a collaborator's role, removing one, and leaving a document
// (FR-ED-38, FR-ED-44 (b)); and telling the collaboration server, so that an
// open connection is closed or made read-only or editable in place within 5
// seconds (FR-ED-40 (a), (b); NFR-SE-03 (b) to (d)).
//
// WHAT AUTHORISES A REQUEST IS READ AGAIN UNDER THE LOCK. `documentRoute`
// authorised the caller before the handler ran, and that was a moment ago: an
// Owner may since have removed the caller, or taken the permission away. Each
// action is one transaction that holds the document's row (`lockDocument`, as
// an invitation and its acceptance do), reads the document's permission set
// and the caller's own role under it, and decides on what it reads. Every
// change to who holds a role on a document holds the same row, so they are
// one after another and no one acts on what has just ceased to be.
//
// The entry of `collaborators_changed` is written in the transaction of the
// change (NFR-SE-19, D163): the user who acted and the document, and nothing
// of the person it affects. The event is published after the commit, and never
// before: a connection must not be closed for a change that was not made.
//
// NFR-SE-19: nothing here logs a name or an address. The name of a
// collaborator leaves this module in the statement the route answers with.
import type { Prisma, DocumentRole as StoredRole } from '../../generated/prisma/client.ts';
import { publishCollabEvent } from '../collab/events.ts';
import { displayNameOf } from '../collab/presence.ts';
import { db } from '../db.ts';
import { securityLogIn } from '../security-log.ts';
import { mayAct, refusalOn, type CollaboratorAction } from './collaborator-rules.ts';
import { withdrawOffersFor } from './ownership.ts';
import { COLLABORATOR_ROLE, type DocumentRole } from './permissions.ts';
import { lockDocument, OFFERED, type OfferedRole } from './sharing.ts';

/** What the identifier of a collaborator's row looks like (a cuid); anything else names no one and is not looked up. */
const COLLABORATOR_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Outcome =
  /** The document is gone or deleted, or the caller holds no role on it now: a 404 (the same for both). */
  | { outcome: 'not_found' }
  /** The caller's role does not hold the permission now: a 403. */
  | { outcome: 'no_permission' }
  /** No collaborator of this document has this identifier: a 404. */
  | { outcome: 'no_such_collaborator' }
  /** FR-ED-44 (b): the caller may act, but not on this one: a 403. */
  | { outcome: 'refused'; why: 'self' | 'editor' };

export type ChangeResult =
  | Outcome
  | { outcome: 'changed'; name: string; role: OfferedRole }
  | { outcome: 'unchanged'; name: string; role: OfferedRole };

export type RemoveResult = Outcome | { outcome: 'removed'; name: string };

export type LeaveResult = { outcome: 'left' } | { outcome: 'not_found' };

/**
 * The caller's role on the document, from the rows, with the document's
 * permission set, read under the document's row; null where the document is
 * gone or deleted or the caller holds no role on it. The change of the
 * permission set (./permission-settings.ts) asks it too.
 */
export async function roleUnderLock(
  tx: Prisma.TransactionClient,
  documentId: string,
  callerId: string,
): Promise<{ role: DocumentRole; permissionSet: unknown } | null> {
  if (!(await lockDocument(tx, documentId))) return null;
  const document = await tx.document.findUnique({
    where: { id: documentId },
    select: { ownerId: true, permissionSet: true },
  });
  if (!document) return null;
  if (document.ownerId === callerId) return { role: 'owner', permissionSet: document.permissionSet };
  const held = await tx.documentCollaborator.findUnique({
    where: { documentId_userId: { documentId, userId: callerId } },
    select: { role: true },
  });
  return held ? { role: COLLABORATOR_ROLE[held.role], permissionSet: document.permissionSet } : null;
}

/**
 * The collaborator this action is for, or the outcome that says why not, in
 * the order of the section "The order inside" of docs/plan/slice-15.md: the
 * caller's role, the permission, the collaborator OF THIS DOCUMENT (an
 * identifier of another document's is no one), and the rules of FR-ED-44 (b).
 */
async function target(
  tx: Prisma.TransactionClient,
  documentId: string,
  callerId: string,
  collaboratorId: string,
  action: CollaboratorAction,
): Promise<
  | { stop: Outcome }
  | {
      stop?: undefined;
      found: { id: string; userId: string; role: StoredRole };
      role: DocumentRole;
      name: string;
    }
> {
  const caller = await roleUnderLock(tx, documentId, callerId);
  if (!caller) return { stop: { outcome: 'not_found' } };
  if (!mayAct(caller.permissionSet, caller.role, action)) {
    return { stop: { outcome: 'no_permission' } };
  }
  const found = COLLABORATOR_ID.test(collaboratorId)
    ? await tx.documentCollaborator.findFirst({
        where: { id: collaboratorId, documentId },
        select: { id: true, userId: true, role: true, user: { select: { name: true, email: true } } },
      })
    : null;
  if (!found) return { stop: { outcome: 'no_such_collaborator' } };
  const role = COLLABORATOR_ROLE[found.role];
  const why = refusalOn(caller.role, { role, self: found.userId === callerId });
  if (why) return { stop: { outcome: 'refused', why } };
  return { found, role, name: displayNameOf(found.user) };
}

/** After the commit: tells the collaboration server to look at this person's connections to this document. */
const announce = (documentId: string, userId: string) =>
  publishCollabEvent({ kind: 'collaborator-changed', documentId, userId });

/**
 * FR-ED-38: changes a collaborator's role to Editor or Viewer. `roleSince` is
 * written again (FR-AU-92). A role that is the one held changes nothing: no
 * write, no entry, no event.
 */
export async function changeRole(
  documentId: string,
  callerId: string,
  collaboratorId: string,
  wanted: OfferedRole,
  now: Date = new Date(),
): Promise<ChangeResult> {
  const { result, userId } = await db().$transaction(
    async (tx): Promise<{ result: ChangeResult; userId?: string }> => {
      const acted = await target(tx, documentId, callerId, collaboratorId, 'roles');
      if (acted.stop) return { result: acted.stop };
      const { found, name } = acted;
      if (found.role === OFFERED[wanted]) return { result: { outcome: 'unchanged', name, role: wanted } };
      await tx.documentCollaborator.update({
        where: { id: found.id },
        data: { role: OFFERED[wanted], roleSince: now },
      });
      await securityLogIn(tx, { kind: 'collaborators_changed', userId: callerId, documentId });
      // FR-ED-47: an offer of ownership to an Editor who stops being one is withdrawn.
      if (OFFERED[wanted] !== 'EDITOR') await withdrawOffersFor(tx, documentId, found.userId, now);
      return { result: { outcome: 'changed', name, role: wanted }, userId: found.userId };
    },
  );
  // Only a change that was made is told: after its commit, never before.
  if (userId) await announce(documentId, userId);
  return result;
}

/**
 * FR-ED-38: removes a collaborator. The row goes and nothing the person
 * contributed does: its edits are in the document, and the invitation that
 * made it a collaborator stays as it was (a removed person may be invited
 * again, and the refusal of FR-ED-37 is for an address at which a person who
 * holds a role accepted).
 */
export async function removeCollaborator(
  documentId: string,
  callerId: string,
  collaboratorId: string,
): Promise<RemoveResult> {
  const { result, userId } = await db().$transaction(
    async (tx): Promise<{ result: RemoveResult; userId?: string }> => {
      const acted = await target(tx, documentId, callerId, collaboratorId, 'remove');
      if (acted.stop) return { result: acted.stop };
      const { found, name } = acted;
      await tx.documentCollaborator.delete({ where: { id: found.id } });
      await securityLogIn(tx, { kind: 'collaborators_changed', userId: callerId, documentId });
      await withdrawOffersFor(tx, documentId, found.userId, new Date());
      return { result: { outcome: 'removed', name }, userId: found.userId };
    },
  );
  if (userId) await announce(documentId, userId);
  return result;
}

/**
 * FR-ED-38: a collaborator leaves, "which has the effect of a removal". The
 * permission, `document.leave`, is fixed by role and held by every role but
 * the Owner's (FR-ED-44), so it is decided by `documentRoute` and not here;
 * what is read under the lock is that the caller still has a row to remove.
 * The Owner has none: "The Owner cannot be removed, cannot leave."
 */
export async function leaveDocument(documentId: string, callerId: string): Promise<LeaveResult> {
  const done = await db().$transaction(async (tx): Promise<LeaveResult> => {
    if (!(await lockDocument(tx, documentId))) return { outcome: 'not_found' };
    const { count } = await tx.documentCollaborator.deleteMany({ where: { documentId, userId: callerId } });
    if (count !== 1) return { outcome: 'not_found' };
    // The one who acts is the one who goes.
    await securityLogIn(tx, { kind: 'collaborators_changed', userId: callerId, documentId });
    await withdrawOffersFor(tx, documentId, callerId, new Date());
    return { outcome: 'left' };
  });
  if (done.outcome === 'left') await announce(documentId, callerId);
  return done;
}
