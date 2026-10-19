// The table of FR-ED-44 as the requirement prints it, written out here and not
// read from the code under test: one row for each permission and one symbol for
// each of Owner, Editor, Reviewer, Viewer (✓ always, — never held by the Owner
// because the Owner cannot leave, "never" fixed, "on" and "off" the defaults of
// a cell the Owner may change). Shared by the unit test of the rules and by the
// integration tests of NFR-SE-04.
import type { DocumentRole, Permission } from '../src/lib/documents/permissions.ts';

export const PRINTED: Record<Permission, [string, string, string, string]> = {
  'document.view': ['✓', '✓', '✓', '✓'],
  'document.content.edit': ['✓', '✓', 'never', 'never'],
  'document.comments.write': ['✓', '✓', '✓', 'never'],
  'document.comments.resolve': ['✓', 'on', 'off', 'never'],
  'document.collaborators.view': ['✓', 'on', 'on', 'on'],
  'document.rename': ['✓', 'off', 'never', 'never'],
  'document.export.draft': ['✓', 'on', 'off', 'off'],
  'document.collaborators.invite': ['✓', 'off', 'never', 'never'],
  'document.collaborators.roles': ['✓', 'off', 'never', 'never'],
  'document.collaborators.remove': ['✓', 'off', 'never', 'never'],
  'document.leave': ['—', '✓', '✓', '✓'],
  'document.permissions.edit': ['✓', 'never', 'never', 'never'],
  'document.ownership.transfer': ['✓', 'never', 'never', 'never'],
  'document.delete': ['✓', 'never', 'never', 'never'],
  'document.export.sealed': ['✓', 'never', 'never', 'never'],
};

export const ROLE_AT: DocumentRole[] = ['owner', 'editor', 'reviewer', 'viewer'];
export const ALL_PERMISSIONS = Object.keys(PRINTED) as Permission[];

/** The symbol the requirement prints for this permission and this role. */
export const symbolOf = (permission: Permission, role: DocumentRole) =>
  PRINTED[permission][ROLE_AT.indexOf(role)]!;

/** Whether the role holds the permission by default: a tick or an "on". */
export const heldByDefault = (permission: Permission, role: DocumentRole) =>
  ['✓', 'on'].includes(symbolOf(permission, role));

/** Whether the Owner may change the cell: "on" or "off", and nothing that is fixed or reads "never". */
export const changeable = (permission: Permission, role: DocumentRole) =>
  ['on', 'off'].includes(symbolOf(permission, role));
