// What stands where a surface would name an account that was deleted (FR-AU-58
// (e)): "Wherever a surface would name the user, it shows the fixed text
// 'Deleted account'". Fixed by the requirement, so not a text for approval.
//
// The tombstone has neither a name nor an address, so a surface that reads the
// display name of an account (`displayNameOf`, src/lib/collab/presence.ts) gets
// an empty one, and shows this where it would show a person. Reachable today:
// the sender of an invitation that was accepted (the page of an invitation and
// its notification, `Sender` in src/app/(app)/invitations/invitation-view.tsx),
// and the pseudonym of an invitation (src/lib/documents/pseudonym.ts). The other
// surfaces that name an account name one that holds a role or is the Owner, and
// a deleted account holds none.
//
// One exception is the owner's own, later than the requirement and more
// specific (register D215, D217): the notice to an Owner that an offer of
// ownership ended names a deleted Editor as "the Editor"
// (src/app/(app)/notifications/notification-list.tsx).
//
// No import: a page in the browser reads this too.

/** FR-AU-58 (e), verbatim. */
export const DELETED_ACCOUNT = 'Deleted account';
