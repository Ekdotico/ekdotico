'use client';

import { useRef, useState, type HTMLAttributes } from 'react';
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
import { TABLE_ROLES } from '../../../../../lib/documents/permission-rules.ts';
import {
  ALWAYS,
  EDITOR_LIMIT,
  NEVER,
  NOT_OFFERED_ROW,
  REVIEWER_HEADER,
  SETTINGS_TEXT,
} from '../../../../../lib/documents/permission-texts.ts';
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

// Register row S16-8 (b): the package types the props of `TableHeaderCell` as `HTMLAttributes`, which
// has no `scope`, though the component spreads its props onto the `th` (checked in 0.29.0). FR-ED-46
// needs row and column headers that a screen reader announces, and WebKit with VoiceOver needs
// `scope` for that. These two objects are the only place a `scope` is passed; delete them when the
// package types it.
const COLUMN = { scope: 'col' } as unknown as HTMLAttributes<HTMLTableCellElement>;
const ROW = { scope: 'row' } as unknown as HTMLAttributes<HTMLTableCellElement>;

/** One cell: its words where it cannot be changed, its state where it can. */
export type CellView =
  /** `note`: what the cell says beyond its word, for the screen reader (the Owner's "Leave", S16-3). */
  | { state: 'always' | 'never'; note?: string }
  /** `notOffered`: the cell is shown disabled, and this is why (S16-1). */
  | { state: 'adjustable'; checked: boolean; notOffered?: string };

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
  /** S16-1: the row is one α 0.1.0 does not offer, and says so under its name. */
  notOffered: boolean;
  /** S16-3: a sentence shown under the row's name that the Owner's cell also carries. */
  ownerNote?: string;
  cells: Record<DocumentRole, CellView>;
}

type Roles = DocumentRole;
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
      for (const role of TABLE_ROLES) {
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
    setResetSaid('');
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
    // Emptied first, in a render of its own, so that the statement of a second reset is a change of the
    // live region and is announced again.
    setResetSaid('');
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
            <TableHeaderCell {...COLUMN}>Permission</TableHeaderCell>
            <TableHeaderCell {...COLUMN}>Kind</TableHeaderCell>
            {TABLE_ROLES.map((role) => (
              <TableHeaderCell key={role} {...COLUMN}>
                {/* S16-1: the column of a role that α 0.1.0 does not offer says so in its header. */}
                {role === 'reviewer' ? REVIEWER_HEADER : ROLE_NAME[role]}
              </TableHeaderCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody className={cells.rows}>
          {rows.map((row) => (
            <TableRow key={row.permission}>
              <TableHeaderCell className={cells.rowHeader} {...ROW}>
                {row.text}
                {row.limit ? <p className={cells.limit}>{EDITOR_LIMIT}</p> : null}
                {row.notOffered ? <p className={cells.limit}>{NOT_OFFERED_ROW}</p> : null}
                {/* S16-3: shown to everyone; the Owner's cell carries the same sentence for a screen
                    reader, so this copy is hidden from one and is not read twice. */}
                {row.ownerNote ? (
                  <p className={cells.limit} aria-hidden="true">
                    {row.ownerNote}
                  </p>
                ) : null}
              </TableHeaderCell>
              <TableCell className={cells.kind}>{row.kind}</TableCell>
              {TABLE_ROLES.map((role) => {
                const cell = row.cells[role];
                const key = keyOf(row.permission, role);
                if (cell.state !== 'adjustable') {
                  return (
                    <TableCell key={role}>
                      <div className={cells.cell}>
                        <span className={cells.fixed}>{cell.state === 'always' ? ALWAYS : NEVER}</span>
                        {/* Read after the word, and not shown: the sentence is under the row's name. */}
                        {cell.note ? <span className="sr-only">{`. ${cell.note}`}</span> : null}
                      </div>
                    </TableCell>
                  );
                }
                if (cell.notOffered) {
                  // S16-1: shown, disabled, and described; no request is made from it, and the server
                  // refuses one (422 not_offered).
                  const whyId = `why-${row.permission.replaceAll('.', '-')}-${role}`;
                  return (
                    <TableCell key={role}>
                      <div className={cells.cell}>
                        <Checkbox
                          label={<span className="sr-only">{`${ROLE_NAME[role]}: ${row.short}`}</span>}
                          checked={cell.checked}
                          disabled
                          aria-describedby={whyId}
                          onChange={() => {}}
                        />
                        <span id={whyId} className="sr-only">
                          {cell.notOffered}
                        </span>
                      </div>
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
