'use client';

import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { Button, Cluster, Dialog, FormFault, Select, Stack } from '@ekdotico/domico/components';
import { ROLE_NAME, type DocumentRole } from '../../../../../lib/documents/permissions.ts';
import { useReady } from '../../../../../components/ready.ts';
import { sendFor, type Fault } from '../../../../../components/send.ts';
import styles from '../../../../pages.module.css';

// FR-ED-38: changing a collaborator's role, removing one, and leaving a
// document, from the sharing settings. Every refusal is the server's, shown as
// it is given: what a control offers is never the rule (src/lib/documents/
// collaborators.ts decides, again, under the lock of the document). Text for a
// person (plan Q6; docs/plan/slice-15.md, §7).

/** The roles that may be chosen (FR-ED-44: the Reviewer is not offered in α 0.1.0). */
const ROLES = [
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
];

const REMOVE_CANCEL_ID = 'remove-cancel';
const LEAVE_CANCEL_ID = 'leave-cancel';

/** The package's `Button` takes no ref (reported), so a dialog opens on Cancel by finding it by its id. */
export function useCancel(id: string) {
  return useMemo(
    () => ({
      get current() {
        return globalThis.document.getElementById(id);
      },
    }),
    [id],
  );
}

/** What a request answered: the statement of the server, or its refusal. */
export interface Answer {
  message?: string;
  fault?: Fault;
}

const statementOf = (answer: unknown) => (answer as { message?: string } | null)?.message;

/** The person's role control and its button. `onAnswer` is the page's, which says what was answered. */
export function RoleControl({
  collaboratorId,
  documentId,
  name,
  role,
  busy,
  onAnswer,
}: {
  collaboratorId: string;
  documentId: string;
  name: string;
  /** The role held now: `editor`, `viewer`, or a role that is not offered. */
  role: DocumentRole;
  busy: boolean;
  onAnswer: (answer: Answer) => void;
}) {
  const ready = useReady();
  const [chosen, setChosen] = useState<string>(role);
  const [sending, setSending] = useState(false);
  const offered = ROLES.some(({ value }) => value === role);

  async function change() {
    setSending(true);
    const sent = await sendFor(
      `/api/documents/${documentId}/collaborators/${collaboratorId}`,
      { role: chosen },
      'PATCH',
    );
    setSending(false);
    if ('fault' in sent) return onAnswer({ fault: sent.fault });
    onAnswer({ message: statementOf(sent.answer) });
  }

  return (
    <Cluster gap={2}>
      <Select
        label={`Role of ${name}`}
        labelHidden
        size="small"
        value={chosen}
        // Until the page is ready a choice reaches no handler and is lost when the page takes over (NFR-IC-19).
        disabled={!ready}
        onChange={(event) => setChosen(event.target.value)}
      >
        {!offered ? (
          <option value={role} disabled>
            {ROLE_NAME[role]}
          </option>
        ) : null}
        {ROLES.map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </Select>
      <Button
        variant="quiet"
        disabled={!ready || busy || sending || chosen === role}
        // The visible words are "Change role"; the name begins with them and names the person (WCAG 2.5.3, 2.4.6).
        aria-label={`Change role of ${name}`}
        onClick={() => void change()}
      >
        Change role
      </Button>
    </Cluster>
  );
}

/**
 * FR-ED-38: the confirmation of a removal, which states what happens before
 * anything does (Expression Guidelines, system feedback, rule 13). The name is
 * whatever the person gave, so it stands on a line of its own under a label,
 * and the statement is the same sentence for every collaborator.
 */
function RemoveConfirmation({
  documentId,
  person,
  onRemoved,
  onCancel,
}: {
  documentId: string;
  person: { id: string; name: string };
  onRemoved: (message?: string) => void;
  onCancel: () => void;
}) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    const sent = await sendFor(
      `/api/documents/${documentId}/collaborators/${person.id}`,
      undefined,
      'DELETE',
    );
    setPending(false);
    if (!('fault' in sent)) return onRemoved(statementOf(sent.answer));
    setFault(sent.fault);
    setAttempt((count) => count + 1);
  }

  return (
    <Stack gap={5}>
      {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
      <Stack gap={1}>
        <p className={styles.meta}>Collaborator</p>
        <p className={styles.text}>
          <bdi id="remove-name" className={styles.documentTitle}>
            {person.name}
          </bdi>
        </p>
      </Stack>
      <p id="remove-statement" className={styles.text}>
        Removing this collaborator ends their access to the document and closes their open connections to it.
        Their edits stay in the document. They can be invited again.
      </p>
      <Cluster gap={3}>
        <Button
          variant="destructive"
          pending={pending}
          pendingLabel="Removing collaborator…"
          onClick={confirm}
        >
          Remove collaborator
        </Button>
        <Button id={REMOVE_CANCEL_ID} onClick={onCancel}>
          Cancel
        </Button>
      </Cluster>
    </Stack>
  );
}

/** The dialog of a removal, for the person it is open for, or closed where there is none. */
export function RemoveDialog({
  documentId,
  person,
  onClose,
  onRemoved,
}: {
  documentId: string;
  person: { id: string; name: string } | null;
  onClose: () => void;
  onRemoved: (message?: string) => void;
}) {
  const cancel = useCancel(REMOVE_CANCEL_ID);
  return (
    <Dialog
      open={person !== null}
      onClose={onClose}
      title="Remove collaborator"
      aria-describedby="remove-name remove-statement"
      initialFocusRef={cancel}
    >
      {person ? (
        <RemoveConfirmation
          key={person.id}
          documentId={documentId}
          person={person}
          onCancel={onClose}
          onRemoved={onRemoved}
        />
      ) : null}
    </Dialog>
  );
}

/** FR-ED-38: what leaving does, in the section before the control and in its confirmation. */
const LEAVING =
  'Leaving removes this document from your list of documents and closes your open connections to it. Your edits stay in the document. You can be invited again.';

/**
 * FR-ED-38: a collaborator leaves, "which has the effect of a removal". The
 * Owner is not offered it (FR-ED-38, FR-ED-44). Shown whatever the role's
 * permission set shows of the people, since going is the person's own.
 */
export function LeaveDocument({ documentId }: { documentId: string }) {
  const router = useRouter();
  const ready = useReady();
  const cancel = useCancel(LEAVE_CANCEL_ID);
  const [open, setOpen] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  /** Closing forgets a refusal, so the next opening starts clean (WCAG 3.3.1). */
  function close() {
    setFault(null);
    setOpen(false);
  }
  async function confirm() {
    setPending(true);
    const sent = await sendFor(`/api/documents/${documentId}/leave`);
    setPending(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    setOpen(false);
    // The document is no longer in the person's list, and this page is of no use to them.
    router.push('/');
    router.refresh();
  }

  return (
    <Stack gap={3}>
      <h2 className={styles.heading}>Leave document</h2>
      <p className={styles.text}>{LEAVING}</p>
      <Cluster>
        <Button variant="destructive" disabled={!ready} onClick={() => setOpen(true)}>
          Leave document
        </Button>
      </Cluster>
      <Dialog
        open={open}
        onClose={close}
        title="Leave document"
        aria-describedby="leave-statement"
        initialFocusRef={cancel}
      >
        <Stack gap={5}>
          {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
          <p id="leave-statement" className={styles.text}>
            {LEAVING}
          </p>
          <Cluster gap={3}>
            <Button
              variant="destructive"
              pending={pending}
              pendingLabel="Leaving document…"
              onClick={confirm}
            >
              Leave document
            </Button>
            <Button id={LEAVE_CANCEL_ID} onClick={close}>
              Cancel
            </Button>
          </Cluster>
        </Stack>
      </Dialog>
    </Stack>
  );
}
