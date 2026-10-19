// Changing a document's permission set (FR-ED-45), and telling the
// collaboration server, so that an open connection is told within 5 seconds
// (FR-ED-40 (g); NFR-SE-03 (d)).
//
// WHAT AUTHORISES A REQUEST IS READ AGAIN UNDER THE LOCK, as for a change of
// role (./collaborators.ts): the route authorised the caller a moment ago, and
// the Owner may since have been replaced, or the caller removed. The change is
// one transaction that holds the document's row, reads the caller's role and
// the stored set under it, and decides on what it reads. Two changes are one
// after the other, each on the set the earlier left.
//
// The set is written WHOLE (FR-ED-45): every cell of the table, the fixed ones
// with the table's value. A cell is changed only where `readRequest`
// (./permission-rules.ts) found it adjustable, and a request with one cell
// refused changes none.
//
// The entry of `permission_set_changed` is written in the transaction of the
// change (NFR-SE-19, D163): the user who made it and the document, and nothing
// of the people it affects or of the cells. The event is published after the
// commit and never before: no connection is told of a change that was not made.
// A request that changes nothing writes, logs and publishes nothing.
import { publishCollabEvent } from '../collab/events.ts';
import { db } from '../db.ts';
import { securityLogIn } from '../security-log.ts';
import { roleUnderLock } from './collaborators.ts';
import { applyRequest, sameSet, wholeSet, type PermissionRequest } from './permission-rules.ts';
import { holds, type PermissionSet } from './permissions.ts';

export type SetResult =
  /** The document is gone or deleted, or the caller holds no role on it now: a 404. */
  | { outcome: 'not_found' }
  /** The caller's role does not hold `document.permissions.edit` now: a 403. */
  | { outcome: 'no_permission' }
  | { outcome: 'changed'; set: PermissionSet; defaults: boolean }
  | { outcome: 'unchanged'; set: PermissionSet; defaults: boolean };

/** FR-ED-45: changes the cells asked for, or returns the whole set to its defaults. */
export async function changePermissionSet(
  documentId: string,
  callerId: string,
  request: PermissionRequest,
): Promise<SetResult> {
  const defaults = request.kind === 'defaults';
  const result = await db().$transaction(async (tx): Promise<SetResult> => {
    const caller = await roleUnderLock(tx, documentId, callerId);
    if (!caller) return { outcome: 'not_found' };
    if (!holds(caller.permissionSet, caller.role, 'document.permissions.edit')) {
      return { outcome: 'no_permission' };
    }
    const before = wholeSet(caller.permissionSet);
    const next = applyRequest(caller.permissionSet, request);
    if (sameSet(before, next)) return { outcome: 'unchanged', set: before, defaults };
    await tx.document.update({ where: { id: documentId }, data: { permissionSet: next } });
    await securityLogIn(tx, { kind: 'permission_set_changed', userId: callerId, documentId });
    return { outcome: 'changed', set: next, defaults };
  });
  // Only a change that was made is told: after its commit, never before.
  if (result.outcome === 'changed') await publishCollabEvent({ kind: 'permission-set-changed', documentId });
  return result;
}
