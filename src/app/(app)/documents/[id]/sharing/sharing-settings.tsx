'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import {
  Button,
  Checkbox,
  Cluster,
  FormFault,
  RadioGroup,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  TextArea,
} from '@ekdotico/domico/components';
import type { DocumentRole } from '../../../../../lib/documents/permissions.ts';
import { useReady } from '../../../../../components/ready.ts';
import { sendFor, type Fault } from '../../../../../components/send.ts';
import styles from '../../../../pages.module.css';
import { InBrowser, LocalTime } from '../../../local-time.tsx';
import { LeaveDocument, RemoveDialog, RoleControl, type Answer } from './collaborator-actions.tsx';

export interface SharingView {
  documentId: string;
  people: number;
  limit: number;
  owner: string;
  collaborators: {
    id: string;
    name: string;
    /** The role as a person reads it, and as the request names it. */
    role: string;
    roleValue: DocumentRole;
    /** Whether the caller may change this person's role, or remove them (FR-ED-44 (b)): the server asks again. */
    mayChangeRole: boolean;
    mayRemove: boolean;
  }[];
  /** FR-ED-38: whether the caller may leave the document: every role but the Owner's. */
  mayLeave: boolean;
  /** Present for a caller who may invite (FR-ED-44). */
  invitations?: {
    id: string;
    email: string;
    role: string;
    expiresAt: string;
    /** Q49: the pseudonym where the title is hidden from the invitee, and null where it is shown. */
    titlePseudonym: string | null;
  }[];
}

// The refusals that are about the addresses entered (src/lib/documents/invitation-answers.ts).
const FIELD_FAULTS = ['invalid_request', 'invalid_address', 'own_address', 'collaborator_address'];

const ROLES = [
  { value: 'editor', label: 'Editor' },
  { value: 'viewer', label: 'Viewer' },
];

/**
 * The sharing settings of a document (FR-ED-21, FR-ED-37): its people against
 * the limit of ten, and, for a caller who may invite, the form and the
 * pending invitations with their address, role and expiry. Every answer is
 * the server's, shown as it is given; the list is read again after each.
 * Text for a person (plan Q6; docs/plan/slice-13.md, §5).
 */
export function SharingSettings({
  view,
  section,
  head,
}: {
  view: SharingView;
  section?: ReactNode;
  head: ReactNode;
}) {
  const router = useRouter();
  const ready = useReady();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState('editor');
  // Q49 (3): off unless the person turns it on.
  const [hideTitle, setHideTitle] = useState(false);
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  // What the last action answered: the confirmations of FR-ED-21, or a statement.
  const [said, setSaid] = useState<string[]>([]);
  const statusRef = useRef<HTMLDivElement>(null);
  const emailsRef = useRef<HTMLTextAreaElement>(null);
  // FR-ED-38: the person whose removal is being confirmed, and how many answers of the people's
  // controls there have been, so that focus goes to what was said once the dialog has closed.
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);
  const [answers, setAnswers] = useState(0);
  // A refusal of a control over a person is stated by itself, and is no error of the field of addresses
  // (the codes `invalid_request` and the others of FIELD_FAULTS name that field's faults).
  const [peopleFault, setPeopleFault] = useState<Fault | null>(null);
  useEffect(() => {
    // A refusal is met from its own statement (the `FormFault` takes focus, and again at each answer: WCAG 2.4.3, 4.1.3).
    if (answers > 0 && !peopleFault) statusRef.current?.focus();
  }, [answers, peopleFault]);

  /** What a control of a person answered: its statement, or its refusal. The list is read again. */
  function answered({ message, fault: refused }: Answer) {
    setFault(null);
    setPeopleFault(refused ?? null);
    setSaid(!refused && message ? [message] : []);
    setAnswers((count) => count + 1);
    router.refresh();
  }

  async function act(path: string, body?: unknown, method: 'POST' | 'DELETE' = 'POST') {
    setSending(true);
    setFault(null);
    setPeopleFault(null);
    setSaid([]);
    const sent = await sendFor(path, body, method);
    setSending(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      // A refusal of the addresses is the field's own: focus goes to the field,
      // which is described by it (WCAG 3.3.1).
      if (FIELD_FAULTS.includes(sent.fault.code)) emailsRef.current?.focus();
      return false;
    }
    const answer = (sent.answer ?? {}) as { confirmations?: string[]; message?: string };
    setSaid(answer.confirmations ?? (answer.message ? [answer.message] : []));
    // The control that was pressed may be gone with its row: focus goes to
    // what was said, and not to the page (WCAG 2.4.3).
    statusRef.current?.focus();
    router.refresh();
    return true;
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    const entered = emails
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (await act(`/api/documents/${view.documentId}/invitations`, { emails: entered, role, hideTitle })) {
      setEmails('');
      // Q49 (3): off unless the person turns it on, for each batch of invitations.
      setHideTitle(false);
    }
  }

  const fieldFault = fault && FIELD_FAULTS.includes(fault.code) ? fault.message : undefined;

  const base = `/api/documents/${view.documentId}/invitations`;
  return (
    <Stack gap={6}>
      {head}

      <Stack gap={3}>
        <h2 className={styles.heading}>People</h2>
        <p className={styles.text}>
          {view.people} of {view.limit} people
        </p>
        <ul className={styles.list}>
          <li className={styles.row}>
            <bdi>{view.owner}</bdi>, Owner
          </li>
          {view.collaborators.map((collaborator) => (
            <li key={collaborator.id} className={styles.row}>
              <Cluster gap={3}>
                <span>
                  <bdi id={`person-${collaborator.id}`}>{collaborator.name}</bdi>, {collaborator.role}
                </span>
                {collaborator.mayChangeRole ? (
                  <RoleControl
                    // A new role is a new control, whose choice is the role held.
                    key={collaborator.roleValue}
                    collaboratorId={collaborator.id}
                    documentId={view.documentId}
                    name={collaborator.name}
                    role={collaborator.roleValue}
                    busy={sending}
                    onAnswer={answered}
                  />
                ) : null}
                {collaborator.mayRemove ? (
                  <Button
                    variant="quiet"
                    disabled={!ready}
                    pending={sending}
                    // The visible words are "Remove"; the name begins with them and names the person (WCAG 2.5.3, 2.4.6).
                    aria-label={`Remove ${collaborator.name}`}
                    onClick={() => setRemoving({ id: collaborator.id, name: collaborator.name })}
                  >
                    Remove
                  </Button>
                ) : null}
              </Cluster>
            </li>
          ))}
        </ul>
      </Stack>
      <RemoveDialog
        documentId={view.documentId}
        person={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(message) => {
          setRemoving(null);
          answered({ message });
        }}
      />

      {/* The confirmations, or the statement of a revocation; focus comes here after an action. */}
      <div role="status" ref={statusRef} tabIndex={-1}>
        {said.map((line) => (
          <p key={line} className={styles.text}>
            {line}
          </p>
        ))}
      </div>
      {fault && !fieldFault ? <FormFault title={fault.message} autoFocus={false} /> : null}
      {peopleFault ? <FormFault title={peopleFault.message} focusKey={answers} /> : null}

      {view.invitations ? (
        <>
          <form onSubmit={(event) => void invite(event)} noValidate>
            <Stack gap={4}>
              <h2 className={styles.heading}>Invite</h2>
              {/* UI audit F02: said before the form, and of no address (FR-ED-21's answer stays neutral). */}
              <p className={styles.text}>The person you invite needs an Ekdotico account first.</p>
              <TextArea
                id="invite-emails"
                name="emails"
                label="Email addresses"
                hint="One address on each line."
                rows={4}
                value={emails}
                onChange={(event) => setEmails(event.target.value)}
                ref={emailsRef}
                error={fieldFault}
              />
              <RadioGroup legend="Role" name="role" value={role} onChange={setRole} options={ROLES} />
              <Checkbox
                id="invite-hide-title"
                name="hideTitle"
                label="Hide the title"
                hint="Until the person accepts, they see a generated name in place of the title. After they accept, they see the title."
                checked={hideTitle}
                onChange={(event) => setHideTitle(event.target.checked)}
              />
              <Cluster>
                <Button type="submit" disabled={!ready} pending={sending}>
                  Invite
                </Button>
              </Cluster>
            </Stack>
          </form>

          <Stack gap={3}>
            <h2 className={styles.heading}>Pending invitations</h2>
            {view.invitations.length === 0 ? (
              <p className={styles.text}>There are no pending invitations.</p>
            ) : (
              <Table label="Pending invitations">
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Address</TableHeaderCell>
                    <TableHeaderCell>Role</TableHeaderCell>
                    <TableHeaderCell>Expires</TableHeaderCell>
                    <TableHeaderCell>Title</TableHeaderCell>
                    <TableHeaderCell>Actions</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {view.invitations.map((invitation) => (
                    <TableRow key={invitation.id}>
                      <TableCell id={`invitation-${invitation.id}`}>
                        <bdi>{invitation.email}</bdi>
                      </TableCell>
                      <TableCell>{invitation.role}</TableCell>
                      <TableCell>
                        <InBrowser>
                          <LocalTime at={invitation.expiresAt} />
                        </InBrowser>
                      </TableCell>
                      <TableCell>
                        {invitation.titlePseudonym === null ? (
                          'Shown'
                        ) : (
                          <>
                            Hidden, shown as <bdi>{invitation.titlePseudonym}</bdi>
                          </>
                        )}
                      </TableCell>
                      <TableCell>
                        <Cluster gap={2}>
                          <Button
                            variant="quiet"
                            disabled={!ready}
                            pending={sending}
                            aria-describedby={`invitation-${invitation.id}`}
                            onClick={() => void act(`${base}/${invitation.id}`, undefined, 'DELETE')}
                          >
                            Revoke
                          </Button>
                          <Button
                            variant="quiet"
                            disabled={!ready}
                            pending={sending}
                            aria-describedby={`invitation-${invitation.id}`}
                            onClick={() => void act(`${base}/${invitation.id}/resend`)}
                          >
                            Send again
                          </Button>
                        </Cluster>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Stack>
        </>
      ) : null}

      {section}

      {view.mayLeave ? <LeaveDocument documentId={view.documentId} /> : null}
    </Stack>
  );
}
