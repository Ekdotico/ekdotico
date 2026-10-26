'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Button,
  Cluster,
  Dialog,
  FormFault,
  PasswordField,
  Stack,
  TextField,
} from '@ekdotico/domico/components';
import { useReady } from '../../../../components/ready.ts';
import { send, sendFor, type Fault } from '../../../../components/send.ts';
import {
  CLEAR_ALL,
  CLEAR_DELETED,
  cleared,
  confirmation,
  confirmControl,
  SCREEN,
} from '../../../../lib/clearing/texts.ts';
import { dateText } from '../../../../lib/date-text.ts';
import styles from '../../../pages.module.css';
import { InBrowser, LocalTime } from '../../local-time.tsx';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the screen read of a scope: the documents the confirmation will name, the identifiers it will send. */
export interface Scope {
  scope: 'all' | 'deleted';
  documentIds: string[];
  shared: number;
  people: number;
}

/**
 * FR-AU-91: "Clear all documents", and the deletion of the already-deleted documents alone, each a control and
 * one confirmation (the password, and a code where two-factor authentication is on). The confirmation names what
 * the screen counted; the identifiers go with the request, and the server refuses (a 409) where the documents are
 * not exactly those any more. Neither the password nor the code stays in the page. A refusal is the server's
 * statement at the head of the form, with focus on it; focus opens on Cancel, the way that deletes nothing.
 */
export function ClearDocuments({
  scope,
  email,
  secondFactor,
  noticeDays,
  onDone,
}: {
  scope: Scope;
  email: string;
  secondFactor: boolean;
  noticeDays: number;
  /** What was done, in words, for the status of the screen. */
  onDone: (statement: string) => void;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const formRef = useRef<HTMLFormElement>(null);
  const ids = useMemo(
    () => ({
      title: `clear-${scope.scope}-title`,
      statement: `clear-${scope.scope}-statement`,
      cancel: `clear-${scope.scope}-cancel`,
    }),
    [scope.scope],
  );
  const documents = scope.documentIds.length;
  const control = scope.scope === 'all' ? CLEAR_ALL : CLEAR_DELETED;
  // The day, as of the moment the dialog is opened, in the reader's own zone: the server's own day is told after.
  const [day, setDay] = useState<string | null>(null);
  const cancel = useMemo(
    () => ({
      get current() {
        return globalThis.document.getElementById(ids.cancel);
      },
    }),
    [ids.cancel],
  );

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    const sent = await sendFor('/api/account/documents/clear', {
      scope: scope.scope,
      documentIds: scope.documentIds,
      password: entered.get('password'),
      ...(secondFactor ? { code: entered.get('code') } : {}),
    });
    setPending(false);
    form.reset();
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    const answer = sent.answer as { documents: number; shared: number; deleteOn: string | null } | null;
    close();
    onDone(
      answer
        ? cleared({
            documents: answer.documents,
            shared: answer.shared,
            day: answer.deleteOn === null ? null : dateText(new Date(answer.deleteOn)),
          })
        : cleared({ documents, shared: scope.shared, day }),
    );
    // The screen is read again: the documents that are gone leave it, and those that wait are listed.
    router.refresh();
  }

  /** Cancel, Escape and the end of a clearing: neither the password nor the last refusal is there when it is opened again. */
  function close() {
    formRef.current?.reset();
    setFault(null);
    setOpen(false);
  }

  return (
    <Stack gap={4}>
      <h2 className={styles.heading}>{scope.scope === 'all' ? SCREEN.heading : SCREEN.headingDeleted}</h2>
      <p className={styles.text}>{scope.scope === 'all' ? SCREEN.lead : SCREEN.leadDeleted}</p>
      <div>
        <Button
          variant="destructive"
          disabled={!ready}
          onClick={() => {
            setDay(dateText(new Date(Date.now() + noticeDays * DAY_MS)));
            setOpen(true);
          }}
        >
          {control}
        </Button>
      </div>
      <Dialog
        open={open}
        onClose={close}
        title={control}
        aria-describedby={ids.statement}
        initialFocusRef={cancel}
      >
        <form method="post" noValidate ref={formRef} onSubmit={confirm}>
          <Stack gap={5}>
            {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
            <div id={ids.statement}>
              <Stack gap={3}>
                {confirmation({
                  documents,
                  shared: scope.shared,
                  people: scope.people,
                  day,
                  noticeDays,
                }).map((line) => (
                  <p key={line} className={styles.text}>
                    {line}
                  </p>
                ))}
                <p className={styles.text}>
                  {secondFactor
                    ? 'Enter your current password and a code to confirm.'
                    : 'Enter your current password to confirm.'}
                </p>
              </Stack>
            </div>
            {/* Read and not typed in, for a password manager (FR-AU-88). It is not sent. */}
            <TextField
              id={`clear-${scope.scope}-email`}
              type="email"
              label="Email address"
              hint="The password is for the account with this address."
              autoComplete="username"
              value={email}
              readOnly
            />
            <PasswordField
              id={`clear-${scope.scope}-password`}
              name="password"
              label="Current password"
              toggleLabel="Show current password"
              autoComplete="current-password"
              required
            />
            {secondFactor ? (
              // A text field, and not the field for a one-time code: a recovery code holds letters.
              <TextField
                id={`clear-${scope.scope}-code`}
                name="code"
                label="Code"
                hint="The six-digit code that the authenticator application shows now, or a recovery code."
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            ) : null}
            <Cluster gap={3}>
              <Button
                variant="destructive"
                type="submit"
                pending={pending}
                pendingLabel="Deleting documents…"
              >
                {confirmControl(documents)}
              </Button>
              <Button id={ids.cancel} onClick={close}>
                Cancel
              </Button>
            </Cluster>
          </Stack>
        </form>
      </Dialog>
    </Stack>
  );
}

/**
 * What the deletion screen offers for the documents the account owns (FR-AU-58, FR-AU-91): the documents that wait
 * for their day with the means to cancel, "Clear all documents", and the deletion of the deleted documents alone.
 * One status for the screen, which survives the reading of the page again: the control that was used may be gone.
 */
export function Clearing({
  all,
  deleted,
  waiting,
  deleting,
  email,
  secondFactor,
  noticeDays,
  lastDay,
}: {
  all: Scope;
  deleted: Scope;
  waiting: Waiting[];
  /** Documents whose day has come and which the timer has not yet deleted. */
  deleting: number;
  email: string;
  secondFactor: boolean;
  noticeDays: number;
  /** ISO 8601, UTC: the last day on which a document waits; the account cannot be deleted before it. */
  lastDay: string | null;
}) {
  const [status, setStatus] = useState<{ text: string; time: number } | null>(null);
  const statement = useRef<HTMLParagraphElement>(null);
  // The control that had focus is gone with the document it was for: the statement of what was done takes it.
  useEffect(() => {
    if (status) statement.current?.focus();
  }, [status]);
  const say = (text: string) => setStatus({ text, time: Date.now() });
  return (
    <Stack gap={8}>
      {/* Present from the first paint and empty until something is done: a status that arrives with its text is not announced. */}
      <p role="status" ref={statement} tabIndex={-1} className={styles.text}>
        {status?.text}
      </p>
      {deleting > 0 ? <p className={styles.text}>{SCREEN.deleting(deleting)}</p> : null}
      {waiting.length > 0 ? (
        <Stack gap={4}>
          <WaitingDocuments documents={waiting} onCancelled={() => say(SCREEN.cancelled)} />
          {lastDay ? (
            <InBrowser>
              <p className={styles.text}>
                The account cannot be deleted before <LocalTime at={lastDay} />.
              </p>
            </InBrowser>
          ) : null}
        </Stack>
      ) : null}
      {all.documentIds.length > 0 ? (
        <ClearDocuments
          scope={all}
          email={email}
          secondFactor={secondFactor}
          noticeDays={noticeDays}
          onDone={say}
        />
      ) : null}
      {deleted.documentIds.length > 0 ? (
        <ClearDocuments
          scope={deleted}
          email={email}
          secondFactor={secondFactor}
          noticeDays={noticeDays}
          onDone={say}
        />
      ) : null}
    </Stack>
  );
}

export interface Waiting {
  id: string;
  title: string;
  /** ISO 8601, UTC. */
  deleteOn: string;
}

/**
 * FR-AU-91: the documents that wait for their day, each with the means to cancel its deletion, and one to cancel
 * them all. "The Owner may cancel the clearing during the period, for one shared document or for all of them,
 * from the deletion screen." Cancelling asks for no password (docs/plan/slice-23.md, S23-5).
 */
export function WaitingDocuments({
  documents,
  onCancelled,
}: {
  documents: Waiting[];
  onCancelled: () => void;
}) {
  const router = useRouter();
  const ready = useReady();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [working, setWorking] = useState<string | null>(null);

  async function cancel(path: string, which: string) {
    if (working) return;
    setWorking(which);
    setFault(null);
    const refused = await send(path, undefined, 'DELETE');
    setWorking(null);
    if (refused) {
      setFault(refused);
      setAttempt((count) => count + 1);
    } else {
      onCancelled();
    }
    router.refresh();
  }

  return (
    <Stack gap={4}>
      <h2 className={styles.heading}>{SCREEN.waiting}</h2>
      {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
      {documents.length === 0 ? null : (
        <>
          <p className={styles.text}>{SCREEN.waitingLead}</p>
          <ul className={styles.list}>
            {documents.map((document) => (
              <li key={document.id} className={styles.row}>
                <Cluster justify="between" gap={4}>
                  <Stack gap={1}>
                    {/* The title is text, whatever it holds (NFR-SE-08). */}
                    <bdi id={`waiting-${document.id}`} className={styles.documentTitle}>
                      {document.title}
                    </bdi>
                    <InBrowser>
                      <p className={styles.meta}>
                        Deleted on <LocalTime at={document.deleteOn} />
                      </p>
                    </InBrowser>
                  </Stack>
                  <Button
                    disabled={!ready || working !== null}
                    aria-describedby={`waiting-${document.id}`}
                    pending={working === document.id}
                    pendingLabel="Cancelling deletion…"
                    onClick={() => cancel(`/api/account/documents/clear/${document.id}`, document.id)}
                  >
                    {SCREEN.cancel}
                  </Button>
                </Cluster>
              </li>
            ))}
          </ul>
          {documents.length > 1 ? (
            <div>
              <Button
                disabled={!ready || working !== null}
                pending={working === 'all'}
                pendingLabel="Cancelling deletion…"
                onClick={() => cancel('/api/account/documents/clear', 'all')}
              >
                {SCREEN.cancelAll(documents.length)}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Stack>
  );
}
