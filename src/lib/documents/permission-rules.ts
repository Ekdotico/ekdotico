// What the Owner may change in a document's permission set (FR-ED-44,
// FR-ED-45), and what the settings screen shows of it (FR-ED-46), as pure
// functions: the server asks them under the lock of the document
// (./permission-settings.ts) and the sharing page asks them to decide what to
// show. The page's answer is never the rule: the server asks again.
//
// Nothing here reads the database or is of Next.js; it loads in a browser.
import {
  defaultPermissionSet,
  holds,
  PERMISSIONS,
  ROLES,
  type DocumentRole,
  type Permission,
  type PermissionSet,
} from './permissions.ts';

/**
 * The permissions that α 0.1.0 has, in the order of the table of FR-ED-44:
 * "every permission except the two comment permissions and the
 * provenance-sealed export, which have nothing to apply to" (build-phases,
 * "The permission set of a document, and its settings"). The others are in the
 * stored set, as FR-ED-44 says, and are neither shown nor changed.
 */
export const SCREEN_PERMISSIONS = [
  'document.view',
  'document.content.edit',
  'document.collaborators.view',
  'document.rename',
  'document.export.draft',
  'document.collaborators.invite',
  'document.collaborators.roles',
  'document.collaborators.remove',
  'document.leave',
  'document.permissions.edit',
  'document.ownership.transfer',
  'document.delete',
] as const satisfies readonly Permission[];

/** The roles the release offers: "one column for each role the release offers" (FR-ED-46). The Reviewer is stored and not offered (D56). */
export const SCREEN_ROLES = ['owner', 'editor', 'viewer'] as const satisfies readonly DocumentRole[];

/**
 * What one cell of the table is, for a permission and a role.
 * - `always`, `never`: fixed by the table, and no setting changes it. The
 *   Owner's cells are all of these, and so is every cell that is fixed by role
 *   or to the Owner, and every cell that reads "never" (FR-ED-44).
 * - `adjustable`: "on" or "off", and the Owner may change it (FR-ED-45).
 * - `not_offered`: the Reviewer column, the two comment rows, and the sealed
 *   export row, which α 0.1.0 does not show (register row S16-1).
 */
export type CellState = 'always' | 'never' | 'adjustable' | 'not_offered';

export function cellState(permission: Permission, role: DocumentRole): CellState {
  const offered =
    (SCREEN_PERMISSIONS as readonly string[]).includes(permission) &&
    (SCREEN_ROLES as readonly string[]).includes(role);
  if (!offered) return 'not_offered';
  const cell = PERMISSIONS[permission][role];
  if (cell === 'on' || cell === 'off') return 'adjustable';
  return cell === 'yes' ? 'always' : 'never';
}

/**
 * The set as it is stored, made whole: every permission and every role, the
 * fixed cells with the table's value, and an adjustable cell with the stored
 * value where it is exactly `true` or `false`. A stored set that cannot be
 * read gives `false` for those cells, as `holds` refuses on it.
 */
export function wholeSet(stored: unknown): PermissionSet {
  const set = {} as PermissionSet;
  for (const permission of Object.keys(PERMISSIONS) as Permission[]) {
    set[permission] = { owner: false, editor: false, reviewer: false, viewer: false };
    for (const role of ROLES) set[permission][role] = holds(stored, role, permission);
  }
  return set;
}

/** Whether two sets are the same cell for cell. */
export function sameSet(a: PermissionSet, b: PermissionSet): boolean {
  return (Object.keys(PERMISSIONS) as Permission[]).every((permission) =>
    ROLES.every((role) => a[permission][role] === b[permission][role]),
  );
}

/** The permissions of the screen that this role holds on a document with this stored set, in the order of the table. */
export function heldBy(stored: unknown, role: DocumentRole): (typeof SCREEN_PERMISSIONS)[number][] {
  return SCREEN_PERMISSIONS.filter((permission) => holds(stored, role, permission));
}

/** One cell the Owner asks to set. */
export interface CellChange {
  permission: Permission;
  role: DocumentRole;
  allowed: boolean;
}

export type PermissionRequest = { kind: 'defaults' } | { kind: 'changes'; cells: CellChange[] };

export type RequestRefusal =
  /** A body that is not what the route takes: a 422. */
  | 'invalid_request'
  /** A cell that is fixed, that reads "never", or is the Owner's: a 422 whoever asks (FR-ED-45). */
  | 'cell_fixed'
  /** A cell outside the part of the set that α has: a 422 (register row S16-1). */
  | 'not_offered';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The request a body makes, or why it is refused. The body is exactly
 * `{ "defaults": true }` or `{ "changes": { "<permission>": { "<role>": true |
 * false } } }`, and nothing else. Every cell is checked before any is
 * written: one that is refused refuses the request. A cell is refused for what
 * it is whatever value is asked for, a fixed one included with its own value.
 */
export function readRequest(
  body: unknown,
): { ok: true; request: PermissionRequest } | { ok: false; why: RequestRefusal } {
  const invalid = { ok: false, why: 'invalid_request' } as const;
  if (!isObject(body)) return invalid;
  const keys = Object.keys(body);
  if (keys.length !== 1) return invalid;
  if (keys[0] === 'defaults') {
    return body.defaults === true ? { ok: true, request: { kind: 'defaults' } } : invalid;
  }
  const { changes } = body;
  if (keys[0] !== 'changes' || !isObject(changes)) return invalid;
  const cells: CellChange[] = [];
  for (const permission of Object.keys(changes)) {
    const roles = changes[permission];
    if (!Object.hasOwn(PERMISSIONS, permission) || !isObject(roles)) return invalid;
    const named = Object.keys(roles);
    if (named.length === 0) return invalid;
    for (const role of named) {
      const allowed = roles[role];
      if (!(ROLES as readonly string[]).includes(role) || typeof allowed !== 'boolean') return invalid;
      cells.push({ permission: permission as Permission, role: role as DocumentRole, allowed });
    }
  }
  if (cells.length === 0) return invalid;
  const states = cells.map(({ permission, role }) => cellState(permission, role));
  if (states.includes('not_offered')) return { ok: false, why: 'not_offered' };
  if (states.some((state) => state !== 'adjustable')) return { ok: false, why: 'cell_fixed' };
  return { ok: true, request: { kind: 'changes', cells } };
}

/** The set a request makes of the set that is stored now: whole, and with no cell written but the ones asked for. */
export function applyRequest(stored: unknown, request: PermissionRequest): PermissionSet {
  if (request.kind === 'defaults') return defaultPermissionSet();
  const set = wholeSet(stored);
  for (const { permission, role, allowed } of request.cells) set[permission][role] = allowed;
  return set;
}
