'use client';

import { useRef, useState } from 'react';
import {
  Button,
  Checkbox,
  Cluster,
  Dialog,
  FormFault,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '@ekdotico/domico/components';
import { useReady } from '../../../../../components/ready.ts';
import { sendFor, type Fault } from '../../../../../components/send.ts';
import { SCREEN_ROLES } from '../../../../../lib/documents/permission-rules.ts';
import { ALWAYS, EDITOR_LIMIT, NEVER, SETTINGS_TEXT } from '../../../../../lib/documents/permission-texts.ts';
import { ROLE_NAME, type DocumentRole, type Permission } from '../../../../../lib/documents/permissions.ts';
import styles from '../../../../pages.module.css';
import { useCancel } from './collaborator-actions.tsx';
import cells from './permissions.module.css';

// FR-ED-45, FR-ED-46: the table of the permission set, for the Owner. A change
// is saved when it is made, and what the server says of it is said in text
// beside the control, as the server gives it. What a cell offers is never the
// rule: the route decides, again, under the lock of the document
// (src/lib/documents/permission-settings.ts). Text for a person: plan Q6;
// docs/plan/slice-16.md, §7.

/** One cell: its words where it cannot be changed, its state where it can. */
export type CellView = { state: 'always' | 'never' } | { state: 'adjustable'; checked: boolean };

export interface PermissionRowView {
  permission: Permission;
  /** The row's name: the first column of FR-ED-44. */
  text: string;
  /** What a checkbox of the row is called after the role. */
  short: string;
  /** The kind of the permission, in words. */
  kind: string;
  /** FR-ED-46: the row states that an Editor never acts on another Editor. */
  limit: boolean;
  cells: Record<(typeof SCREEN_ROLES)[number], CellView>;
}

type Roles = (typeof SCREEN_ROLES)[number];
const keyOf = (permission: Permission, role: Roles) => `${permission} ${role}`;
const RESET_CANCEL_ID = 'reset-cancel';

/** A stored set as the server answers with it: the cells of the screen are read out of it by name. */
type Stored = Partial<Record<Permission, Partial<Record<DocumentRole, boolean>>>>;

export function PermissionSettings({
  documentId,
  rows,
}: {
  documentId: string;
  rows: readonly PermissionRowView[];
}) {
  const ready = useReady();
  const path = `/api/documents/${documentId}/permissions`;
  // The stored state of each adjustable cell, as the server last said it.
  const [checked, setChecked] = useState<Record<string, boolean>>(() => {
    const first: Record<string, boolean> = {};
    for (const row of rows) {
      for (const role of SCREEN_ROLES) {
        const cell = row.cells[role];
        if (cell.state === 'adjustable') first[keyOf(row.permission, role)] = cell.checked;
      }
    }
    return first;
  });
  // What was said beside each cell, and of the reset.
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [resetSaid, setResetSaid] = useState('');
  // One request at a time, in the order of the clicks, so that each answer is the set as that change left
  // it and the last answer is the latest. A box shows what is stored, and so changes when its answer
  // comes. It is not disabled meanwhile, since a control that is disabled loses the focus (WCAG 2.4.3).
  const line = useRef<Promise<void>>(Promise.resolve());
  const [resetting, setResetting] = useState(false);
  const [resetFault, setResetFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const cancel = useCancel(RESET_CANCEL_ID);

  /** Takes what the server holds of every cell of the screen. */
  function adopt(stored: Stored) {
    setChecked((was) => {
      const next = { ...was };
      for (const key of Object.keys(was)) {
        const [permission, role] = key.split(' ') as [Permission, Roles];
        const value = stored[permission]?.[role];
        if (typeof value === 'boolean') next[key] = value;
      }
      return next;
    });
  }

  function change(permission: Permission, role: Roles, allowed: boolean) {
    line.current = line.current.then(() => save(permission, role, allowed));
  }

  async function save(permission: Permission, role: Roles, allowed: boolean) {
    const key = keyOf(permission, role);
    setNotes((was) => ({ ...was, [key]: '' }));
    const sent = await sendFor(path, { changes: { [permission]: { [role]: allowed } } }, 'PUT');
    if ('fault' in sent) {
      // The box is as it was stored, and the words say why.
      setNotes((was) => ({ ...was, [key]: sent.fault.message }));
      return;
    }
    const answer = (sent.answer ?? {}) as { message?: string; set?: Stored };
    if (answer.set) adopt(answer.set);
    else setChecked((was) => ({ ...was, [key]: allowed }));
    setNotes((was) => ({ ...was, [key]: answer.message ?? SETTINGS_TEXT.saved }));
  }

  async function reset() {
    setPending(true);
    const sent = await sendFor(path, { defaults: true }, 'PUT');
    setPending(false);
    if ('fault' in sent) {
      setResetFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    const answer = (sent.answer ?? {}) as { message?: string; set?: Stored };
    if (answer.set) adopt(answer.set);
    setNotes({});
    setResetFault(null);
    setResetSaid(answer.message ?? '');
    setResetting(false);
  }

  return (
    <Stack gap={3}>
      <h2 className={styles.heading}>{SETTINGS_TEXT.heading}</h2>
      <Table label={SETTINGS_TEXT.table}>
        <TableHead>
          <TableRow>
            <TableHeaderCell>Permission</TableHeaderCell>
            <TableHeaderCell>Kind</TableHeaderCell>
            {SCREEN_ROLES.map((role) => (
              <TableHeaderCell key={role}>{ROLE_NAME[role]}</TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody className={cells.rows}>
          {rows.map((row) => (
            <TableRow key={row.permission}>
              <TableHeaderCell className={cells.rowHeader}>
                {row.text}
                {row.limit ? <p className={cells.limit}>{EDITOR_LIMIT}</p> : null}
              </TableHeaderCell>
              <TableCell className={cells.kind}>{row.kind}</TableCell>
              {SCREEN_ROLES.map((role) => {
                const cell = row.cells[role];
                const key = keyOf(row.permission, role);
                if (cell.state !== 'adjustable') {
                  return (
                    <TableCell key={role}>
                      <span className={cells.fixed}>{cell.state === 'always' ? ALWAYS : NEVER}</span>
                    </TableCell>
                  );
                }
                const noteId = `note-${row.permission.replaceAll('.', '-')}-${role}`;
                return (
                  <TableCell key={role}>
                    <div className={cells.cell}>
                      <Checkbox
                        // The name states the permission and the role (FR-ED-46); the page shows the box.
                        label={<span className="sr-only">{`${ROLE_NAME[role]}: ${row.short}`}</span>}
                        checked={checked[key] ?? false}
                        disabled={!ready}
                        aria-describedby={noteId}
                        onChange={(event) => change(row.permission, role, event.target.checked)}
                      />
                      {/* Said without moving the focus (FR-ED-46: "announced without moving focus"). A live
                          region and not `role="status"`, which the page's own statement holds alone. */}
                      <span id={noteId} aria-live="polite" aria-atomic="true" className={cells.note}>
                        {notes[key] ?? ''}
                      </span>
                    </div>
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Cluster gap={3}>
        <Button disabled={!ready} onClick={() => setResetting(true)}>
          {SETTINGS_TEXT.reset}
        </Button>
        <span aria-live="polite" aria-atomic="true" className={cells.note}>
          {resetSaid}
        </span>
      </Cluster>
      <Dialog
        open={resetting}
        onClose={() => setResetting(false)}
        title={SETTINGS_TEXT.resetTitle}
        aria-describedby="reset-statement"
        initialFocusRef={cancel}
      >
        <Stack gap={5}>
          {resetFault ? <FormFault title={resetFault.message} headingLevel={3} focusKey={attempt} /> : null}
          <p id="reset-statement" className={styles.text}>
            {SETTINGS_TEXT.resetStatement}
          </p>
          <Cluster gap={3}>
            <Button
              variant="destructive"
              pending={pending}
              pendingLabel={SETTINGS_TEXT.resetPending}
              onClick={reset}
            >
              {SETTINGS_TEXT.resetConfirm}
            </Button>
            <Button id={RESET_CANCEL_ID} onClick={() => setResetting(false)}>
              Cancel
            </Button>
          </Cluster>
        </Stack>
      </Dialog>
    </Stack>
  );
}
