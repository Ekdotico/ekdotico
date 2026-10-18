'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import {
  Button,
  Cluster,
  FormFault,
  PageHeading,
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
import { useReady } from '../../../../../components/ready.ts';
import { sendFor, type Fault } from '../../../../../components/send.ts';
import styles from '../../../../pages.module.css';
import { InBrowser, LocalTime } from '../../../local-time.tsx';

export interface SharingView {
  documentId: string;
  people: number;
  limit: number;
  owner: string;
  collaborators: { userId: string; name: string; role: string }[];
  /** Present for a caller who may invite (FR-ED-44). */
  invitations?: { id: string; email: string; role: string; expiresAt: string }[];
}

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
export function SharingSettings({ view }: { view: SharingView }) {
  const router = useRouter();
  const ready = useReady();
  const [emails, setEmails] = useState('');
  const [role, setRole] = useState('editor');
  const [sending, setSending] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  // What the last action answered: the confirmations of FR-ED-21, or a statement.
  const [said, setSaid] = useState<string[]>([]);

  async function act(path: string, body?: unknown, method: 'POST' | 'DELETE' = 'POST') {
    setSending(true);
    setFault(null);
    setSaid([]);
    const sent = await sendFor(path, body, method);
    setSending(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      return false;
    }
    const answer = (sent.answer ?? {}) as { confirmations?: string[]; message?: string };
    setSaid(answer.confirmations ?? (answer.message ? [answer.message] : []));
    router.refresh();
    return true;
  }

  async function invite(event: FormEvent) {
    event.preventDefault();
    const entered = emails
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (await act(`/api/documents/${view.documentId}/invitations`, { emails: entered, role })) setEmails('');
  }

  const base = `/api/documents/${view.documentId}/invitations`;
  return (
    <Stack gap={6}>
      <PageHeading>Sharing</PageHeading>

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
            <li key={collaborator.userId} className={styles.row}>
              <bdi>{collaborator.name}</bdi>, {collaborator.role}
            </li>
          ))}
        </ul>
      </Stack>

      {/* Announced without moving focus: the confirmations, or the refusal. */}
      <div role="status">
        {said.map((line) => (
          <p key={line} className={styles.text}>
            {line}
          </p>
        ))}
      </div>
      {fault ? <FormFault title={fault.message} autoFocus={false} /> : null}

      {view.invitations ? (
        <>
          <form onSubmit={(event) => void invite(event)} noValidate>
            <Stack gap={4}>
              <h2 className={styles.heading}>Invite</h2>
              <TextArea
                id="invite-emails"
                name="emails"
                label="Email addresses"
                hint="One address on each line."
                rows={4}
                value={emails}
                onChange={(event) => setEmails(event.target.value)}
              />
              <RadioGroup legend="Role" name="role" value={role} onChange={setRole} options={ROLES} />
              <Cluster>
                <Button type="submit" disabled={!ready || sending}>
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
                        <Cluster gap={2}>
                          <Button
                            variant="quiet"
                            disabled={!ready || sending}
                            aria-describedby={`invitation-${invitation.id}`}
                            onClick={() => void act(`${base}/${invitation.id}`, undefined, 'DELETE')}
                          >
                            Revoke
                          </Button>
                          <Button
                            variant="quiet"
                            disabled={!ready || sending}
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
    </Stack>
  );
}
