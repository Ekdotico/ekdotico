// The permission set of a document (FR-ED-44, FR-ED-45): the table of the
// requirement as data, the set a new document is given, and the one function
// that says whether a role holds a permission on a document.
//
// Nothing here reads the database or is of Next.js: the collaboration server
// asks the same question (FR-ED-39).

/** FR-ED-19: the four document-level roles. The Reviewer role is not offered in α 0.1.0 and is stored all the same (FR-ED-44). */
export const ROLES = ['owner', 'editor', 'reviewer', 'viewer'] as const;
export type DocumentRole = (typeof ROLES)[number];

/**
 * A cell of the table, as the table writes it: `yes` is its tick and `no` its
 * dash, both fixed; `never` is fixed too; `on` and `off` are the defaults of
 * the cells the Owner of a document may change (FR-ED-45).
 */
export type Cell = 'yes' | 'no' | 'never' | 'on' | 'off';
export type PermissionKind = 'fixed_by_role' | 'adjustable' | 'fixed_to_owner';

const row = (kind: PermissionKind, owner: Cell, editor: Cell, reviewer: Cell, viewer: Cell) => ({
  kind,
  owner,
  editor,
  reviewer,
  viewer,
});

/**
 * The table of FR-ED-44, row for row and in its order. A test holds a copy of
 * the table as the requirement prints it and fails where the two differ
 * (tests/unit/document-permissions.test.ts).
 */
export const PERMISSIONS = {
  'document.view': row('fixed_by_role', 'yes', 'yes', 'yes', 'yes'),
  'document.content.edit': row('fixed_by_role', 'yes', 'yes', 'never', 'never'),
  'document.comments.write': row('fixed_by_role', 'yes', 'yes', 'yes', 'never'),
  'document.comments.resolve': row('adjustable', 'yes', 'on', 'off', 'never'),
  'document.collaborators.view': row('adjustable', 'yes', 'on', 'on', 'on'),
  'document.rename': row('adjustable', 'yes', 'off', 'never', 'never'),
  'document.export.draft': row('adjustable', 'yes', 'on', 'off', 'off'),
  'document.collaborators.invite': row('adjustable', 'yes', 'off', 'never', 'never'),
  'document.collaborators.roles': row('adjustable', 'yes', 'off', 'never', 'never'),
  'document.collaborators.remove': row('adjustable', 'yes', 'off', 'never', 'never'),
  'document.leave': row('fixed_by_role', 'no', 'yes', 'yes', 'yes'),
  'document.permissions.edit': row('fixed_to_owner', 'yes', 'never', 'never', 'never'),
  'document.ownership.transfer': row('fixed_to_owner', 'yes', 'never', 'never', 'never'),
  'document.delete': row('fixed_to_owner', 'yes', 'never', 'never', 'never'),
  'document.export.sealed': row('fixed_to_owner', 'yes', 'never', 'never', 'never'),
} as const satisfies Record<string, ReturnType<typeof row>>;

export type Permission = keyof typeof PERMISSIONS;

/** The stored form: for every permission of the table, whether each role holds it. */
export type PermissionSet = Record<Permission, Record<DocumentRole, boolean>>;

/**
 * FR-ED-45: "a new document is created with the defaults, and the set is
 * stored whole with the document, so that a later release that changes a
 * default changes no existing document". Whole: every row and every column,
 * the fixed cells among them.
 */
export function defaultPermissionSet(): PermissionSet {
  const set = {} as PermissionSet;
  for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
    const cells = PERMISSIONS[permission];
    set[permission] = { owner: false, editor: false, reviewer: false, viewer: false };
    for (const role of ROLES) set[permission][role] = cells[role] === 'yes' || cells[role] === 'on';
  }
  return set;
}

/**
 * Whether a role holds a permission on the document whose stored set is given.
 *
 * FR-ED-44: a cell that is fixed, or that reads "never", is the table's on
 * every document, and "no setting changes it"; so is every cell of the Owner.
 * Those are answered from the table, and what is stored for them is never
 * read: a stored set that was altered cannot give a Viewer the content, or
 * take the document from its Owner. Only a cell the Owner may change is read
 * from the stored set, and there anything other than `true` refuses, a set
 * that cannot be read included.
 */
export function holds(stored: unknown, role: DocumentRole, permission: Permission): boolean {
  // The types are erased at run time: a name outside the table holds nothing.
  if (!Object.hasOwn(PERMISSIONS, permission) || !ROLES.includes(role)) return false;
  const cell: Cell = PERMISSIONS[permission][role];
  if (cell !== 'on' && cell !== 'off') return cell === 'yes';
  if (typeof stored !== 'object' || stored === null) return false;
  const cells: unknown = Object.hasOwn(stored, permission)
    ? (stored as Record<string, unknown>)[permission]
    : null;
  if (typeof cells !== 'object' || cells === null || !Object.hasOwn(cells, role)) return false;
  return (cells as Record<string, unknown>)[role] === true;
}
