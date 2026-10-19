// The words of the permission settings screen and of what the routes answer
// (FR-ED-46, FR-ED-45). The cell words and the kinds are the requirements'
// own, used verbatim; the rest is text for a person, written under the
// Expression Guidelines for the owner's approval (plan Q6;
// docs/plan/slice-16.md, §7).
//
// Nothing here is of Next.js; it loads in a browser.
import type { Permission, PermissionKind } from './permissions.ts';

/**
 * The first column of FR-ED-44, row for row. Without the citations the column
 * carries, and without the clause on comment threads, which α has none of
 * (register row S16-2).
 */
export const PERMISSION_TEXT: Record<Permission, string> = {
  'document.view': "View the document's content",
  // The three rows that α 0.1.0 shows disabled (register row S16-1, 19 October 2026): the first
  // column of FR-ED-44 without its citations.
  'document.comments.write': "Create comment threads, reply to them, and resolve one's own thread",
  'document.comments.resolve': 'Resolve and reopen any comment thread',
  'document.export.sealed':
    'Initiate a provenance-sealed export, and the Revise and Branch actions that follow one',
  'document.content.edit':
    "Edit the document's content, which includes adding and changing images and footnotes",
  'document.collaborators.view': 'See the list of collaborators and their roles',
  'document.rename': 'Rename the document',
  'document.export.draft': 'Draft export',
  'document.collaborators.invite':
    'Invite collaborators, send an invitation again, revoke a pending invitation, and see the pending invitations',
  'document.collaborators.roles': "Change a collaborator's role",
  'document.collaborators.remove': 'Remove a collaborator',
  'document.leave': 'Leave the document',
  'document.permissions.edit': "Change the document's permission set",
  'document.ownership.transfer': 'Transfer ownership of the document',
  'document.delete': 'Delete the document, and restore it within its retention',
};

/** The name a checkbox is given for its permission: short, so that "[Role]: [name]" reads at once. */
export const SHORT_TEXT: Partial<Record<Permission, string>> = {
  'document.comments.resolve': 'Resolve and reopen any comment thread',
  'document.collaborators.view': 'See the list of collaborators',
  'document.rename': 'Rename the document',
  'document.export.draft': 'Draft export',
  'document.collaborators.invite': 'Invite collaborators',
  'document.collaborators.roles': "Change a collaborator's role",
  'document.collaborators.remove': 'Remove a collaborator',
};

/** The kind of each permission in words: the third column of FR-ED-44, verbatim. */
export const KIND_TEXT: Record<PermissionKind, string> = {
  fixed_by_role: 'Fixed by role',
  adjustable: 'Adjustable',
  fixed_to_owner: 'Fixed to the Owner',
};

/**
 * The owner's decisions of 19 October 2026 (register rows S16-1, S16-3, S16-7).
 * What the table says of a cell or a column that α 0.1.0 does not offer: the
 * note under a row, which also describes the disabled checkbox of its Editor cell; the
 * Reviewer column's header, which describes the disabled checkboxes of that column; and the one sentence that the Owner's "Leave" cell
 * and the refusal of an Owner who tries to leave both say. "Owner" is the
 * product's role name, capitalised.
 */
export const NOT_OFFERED_ROW = 'Not offered in this release.';
export const REVIEWER_HEADER = 'Reviewer (not offered in this release)';
export const OWNER_LEAVE = 'You are the Owner. You must transfer ownership before leaving.';
/** The refusal of a role that asks to change the permission set, which only the Owner can do. */
export const ONLY_OWNER = 'Only the Owner of the document can do this.';

/** FR-ED-46: the words of a cell the Owner cannot change. */
export const ALWAYS = 'Always';
export const NEVER = 'Never';

/** FR-ED-46: stated in the rows for changing a role and for removing (register row S16-4). */
export const EDITOR_LIMIT =
  'An Editor who is given this permission can act on Viewers and never on another Editor.';

export const ROWS_WITH_LIMIT: readonly Permission[] = [
  'document.collaborators.roles',
  'document.collaborators.remove',
];

export const SETTINGS_TEXT = {
  heading: 'Permissions',
  table: 'Permissions of each role',
  saved: 'Saved.',
  reset: 'Reset to defaults',
  resetTitle: 'Reset permissions',
  resetStatement:
    'Resetting returns every permission of every role on this document to its default. Any change made to them is lost.',
  resetConfirm: 'Reset permissions',
  resetPending: 'Resetting permissions…',
  yourRole: 'Your role',
  roleIs: (role: string) => `Your role on this document is ${role}.`,
  mayDo: 'This role may do the following on this document.',
};

/** What the routes answer (FR-ED-45). The refusals begin by saying that nothing was changed. */
export const PERMISSION_MESSAGES = {
  changed: 'Saved.',
  unchanged: 'Nothing changed. The permissions are already as requested.',
  reset: 'Permissions reset to the defaults.',
  resetUnchanged: 'The permissions are already the defaults.',
  invalidRequest: 'The permissions were not changed. Send the cells to change, or ask for the defaults.',
  cellFixed:
    'The permissions were not changed. A permission that is fixed, or never given, for a role cannot be changed.',
  notOffered:
    'The permissions were not changed. This role or this permission is not offered in this release.',
};

/** What the editor says to a connection whose role's permissions changed (FR-ED-40 (g)). */
export const PERMISSIONS_NOW = (role: string) =>
  `The permissions of the ${role} role on this document have changed.`;
