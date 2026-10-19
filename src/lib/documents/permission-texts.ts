// The words of the permission settings screen and of what the routes answer
// (FR-ED-46, FR-ED-45). The cell words and the kinds are the requirements'
// own, used verbatim; the rest is text for a person, written under the
// Expression Guidelines for the owner's approval (plan Q6;
// docs/plan/slice-16.md, §7).
//
// Nothing here is of Next.js; it loads in a browser.
import type { Permission, PermissionKind } from './permissions.ts';
import type { SCREEN_PERMISSIONS } from './permission-rules.ts';

type OfScreen = (typeof SCREEN_PERMISSIONS)[number];

/**
 * The first column of FR-ED-44, row for row. Without the citations the column
 * carries, and without the clause on comment threads, which α has none of
 * (register row S16-2).
 */
export const PERMISSION_TEXT: Record<OfScreen, string> = {
  'document.view': "View the document's content",
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
    'Resetting returns every permission of every role on this document to its default. Any change you made to the permissions is lost.',
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
