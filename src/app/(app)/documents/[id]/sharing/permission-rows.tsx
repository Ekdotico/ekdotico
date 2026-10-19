// What the sharing page shows of a document's permission set (FR-ED-46): the
// rows of the table for the Owner, and the statement of a role for anyone
// else. Read from the stored set on each load, by the same `holds` that every
// request asks. Nothing here decides anything: the routes do, again.
import { Stack } from '@ekdotico/domico/components';
import {
  tableCell,
  heldBy,
  SCREEN_PERMISSIONS,
  TABLE_PERMISSIONS,
  TABLE_ROLES,
} from '../../../../../lib/documents/permission-rules.ts';
import {
  KIND_TEXT,
  NOT_OFFERED_CELL,
  NOT_OFFERED_REVIEWER,
  OWNER_LEAVE,
  PERMISSION_TEXT,
  ROWS_WITH_LIMIT,
  SETTINGS_TEXT,
  SHORT_TEXT,
} from '../../../../../lib/documents/permission-texts.ts';
import {
  holds,
  PERMISSIONS,
  ROLE_NAME,
  type DocumentRole,
} from '../../../../../lib/documents/permissions.ts';
import styles from '../../../../pages.module.css';
import type { CellView, PermissionRowView } from './permission-settings.tsx';

/**
 * The rows of the table, every permission of FR-ED-44 in its order and every role, for a document with
 * this stored set. The owner's decisions of 19 October 2026 (register rows S16-1, S16-3): a cell that
 * α 0.1.0 does not offer is shown, a checkbox disabled and described where it can be changed, and the
 * Owner's "Leave" cell says why it is "Never".
 */
export function permissionRows(stored: unknown): PermissionRowView[] {
  return TABLE_PERMISSIONS.map((permission) => {
    const cells = {} as PermissionRowView['cells'];
    for (const role of TABLE_ROLES) {
      const { state, offered } = tableCell(permission, role);
      cells[role] =
        state === 'adjustable'
          ? ({
              state,
              checked: holds(stored, role, permission),
              ...(offered
                ? {}
                : { notOffered: role === 'reviewer' ? NOT_OFFERED_REVIEWER : NOT_OFFERED_CELL }),
            } satisfies CellView)
          : {
              state,
              ...(permission === 'document.leave' && role === 'owner' ? { note: OWNER_LEAVE } : {}),
            };
    }
    return {
      permission,
      text: PERMISSION_TEXT[permission],
      short: SHORT_TEXT[permission] ?? PERMISSION_TEXT[permission],
      kind: KIND_TEXT[PERMISSIONS[permission].kind],
      limit: ROWS_WITH_LIMIT.includes(permission),
      // A row α does not have: the two comment rows and the sealed export.
      notOffered: !(SCREEN_PERMISSIONS as readonly string[]).includes(permission),
      ...(permission === 'document.leave' ? { ownerNote: OWNER_LEAVE } : {}),
      cells,
    };
  });
}

/** FR-ED-46: to a role that is not the Owner, in words, the role held and what it may do; no control. */
export function RoleSummary({ stored, role }: { stored: unknown; role: DocumentRole }) {
  return (
    <Stack gap={3}>
      <h2 className={styles.heading}>{SETTINGS_TEXT.yourRole}</h2>
      <p className={styles.text}>{SETTINGS_TEXT.roleIs(ROLE_NAME[role])}</p>
      <p className={styles.text}>{SETTINGS_TEXT.mayDo}</p>
      <ul className={styles.list}>
        {heldBy(stored, role).map((permission) => (
          <li key={permission} className={styles.row}>
            {PERMISSION_TEXT[permission]}
          </li>
        ))}
      </ul>
    </Stack>
  );
}
