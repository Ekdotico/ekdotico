// Who may change a collaborator's role or remove one (FR-ED-38, FR-ED-44 (b)),
// as two pure functions: the server asks them under the lock of the document
// (./collaborators.ts) and the sharing page asks them to decide which controls
// to show. The page's answer is never the rule: the server asks again.
//
// Nothing here reads the database or is of Next.js.
import { holds, type DocumentRole, type Permission } from './permissions.ts';

/** The two actions of FR-ED-38 that act on another person. Leaving is the person's own (`document.leave`). */
export type CollaboratorAction = 'roles' | 'remove';

const PERMISSION = {
  roles: 'document.collaborators.roles',
  remove: 'document.collaborators.remove',
} as const satisfies Record<CollaboratorAction, Permission>;

/** The role of a collaborator: the Owner is `Document.ownerId` and no collaborator (FR-ED-19). */
export type CollaboratorRole = Exclude<DocumentRole, 'owner'>;

/**
 * Whether this role holds the permission of the action on this document, now
 * (FR-ED-44: the Owner always, others as the stored set says).
 */
export function mayAct(permissionSet: unknown, actor: DocumentRole, action: CollaboratorAction): boolean {
  return holds(permissionSet, actor, PERMISSION[action]);
}

/**
 * FR-ED-44 (b), for one collaborator the actor may act on in general: why it
 * may not act on this one, or null.
 *
 * - `self`: "The holder cannot act on the Owner or on themselves; a holder who
 *   wants to go leaves the document." (The Owner has no row to name.)
 * - `editor`: "An Editor never acts on another Editor: a holder may change the
 *   role of, or remove, only a collaborator who holds the Reviewer or the
 *   Viewer role at that moment ... unless the Owner makes it."
 */
export function refusalOn(
  actor: DocumentRole,
  target: { role: CollaboratorRole; self: boolean },
): 'self' | 'editor' | null {
  if (target.self) return 'self';
  if (actor !== 'owner' && target.role === 'editor') return 'editor';
  return null;
}
