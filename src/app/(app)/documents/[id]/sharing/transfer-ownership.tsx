'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button, Cluster, Dialog, FormFault, Select, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../../../components/ready.ts';
import { PromptFields } from '../../../../../components/prompt-fields.tsx';
import { sendFor, type Fault } from '../../../../../components/send.ts';
import { OFFER_PROMPT } from '../../../../../lib/documents/ownership-texts.ts';
import styles from '../../../../pages.module.css';
import { InBrowser, LocalTime } from '../../../local-time.tsx';
import { useCancel } from './collaborator-actions.tsx';

// FR-ED-47: the Owner offers the ownership of the document to one of its
// Editors, and withdraws the offer, from the sharing settings. Every refusal is
// the server's, shown as it is given: what the section offers is never the rule
// (src/lib/documents/ownership.ts decides, again, under the lock of the
// document). Text for a person (plan Q6; docs/plan/slice-17.md, section 7).

const CANCEL_ID = 'offer-cancel';

const statementOf = (answer: unknown) => (answer as { message?: string } | null)?.message;

/**
 * The section "Transfer ownership", shown to the Owner alone: the form with
 * the Editors, or the offer that is open with its withdrawal. `days` is the
 * setting that gives an offer its period (FR-ED-47: 14, an initial value).
 */
export function TransferOwnership({
  documentId,
  editors,
  offer,
  days,
  email,
  secondFactor,
}: {
  documentId: string;
  /** The account's address and whether it asks for a code: the prompt of FR-ED-47 (D285). */
  email: string;
  secondFactor: boolean;
  /** The collaborators who hold the Editor role, by the identifier of their row. */
  editors: { id: string; name: string }[];
  /** The offer that is open, with its expiry as ISO 8601 in UTC. */
  offer: { toName: string; expiresAt: string } | null;
  days: number;
}) {
  const router = useRouter();
  const ready = useReady();
  const cancel = useCancel(CANCEL_ID);
  const [chosen, setChosen] = useState(editors[0]?.id ?? '');
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  // What the last action answered; focus comes here once the control that was pressed is gone.
  const [said, setSaid] = useState('');
  const [answers, setAnswers] = useState(0);
  const statusRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (answers > 0) statusRef.current?.focus();
  }, [answers]);

  // The person chosen, as the list now holds them: an Editor removed meanwhile is no longer chosen.
  const person = editors.find(({ id }) => id === chosen) ?? editors[0];

  // A refusal shown in the dialog stays in the dialog: closing it clears it, so that it is not stated again outside.
  function close() {
    formRef.current?.reset();
    setOpen(false);
    setFault(null);
  }

  async function offerOwnership(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!person || pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    const sent = await sendFor(`/api/documents/${documentId}/ownership-offer`, {
      collaboratorId: person.id,
      password: entered.get('password'),
      ...(secondFactor ? { code: entered.get('code') } : {}),
    });
    setPending(false);
    // Neither the password nor the code stays in the page, whatever the answer: a refused one is typed again.
    form.reset();
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    setOpen(false);
    setFault(null);
    setSaid(statementOf(sent.answer) ?? '');
    setAnswers((count) => count + 1);
    router.refresh();
  }

  async function withdraw() {
    setWithdrawing(true);
    setFault(null);
    const sent = await sendFor(`/api/documents/${documentId}/ownership-offer`, undefined, 'DELETE');
    setWithdrawing(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      setSaid('');
      setAttempt((count) => count + 1);
      return;
    }
    setSaid(statementOf(sent.answer) ?? '');
    setAnswers((count) => count + 1);
    router.refresh();
  }

  return (
    <Stack gap={3}>
      <h2 className={styles.heading}>Transfer ownership</h2>
      {offer ? (
        <>
          <p className={styles.text}>
            Ownership of this document is offered to <bdi>{offer.toName}</bdi>.{' '}
            <InBrowser>
              The offer is open until <LocalTime at={offer.expiresAt} />.
            </InBrowser>
          </p>
          <Cluster>
            <Button
              variant="quiet"
              disabled={!ready}
              pending={withdrawing}
              pendingLabel="Withdrawing offer…"
              onClick={() => void withdraw()}
            >
              Withdraw offer
            </Button>
          </Cluster>
        </>
      ) : person ? (
        <>
          <p className={styles.text}>
            Offer ownership of this document to one of its Editors. Ownership changes only when they accept.
            If they accept, they become the Owner, you become an Editor, and the document moves to their
            personal workspace.
          </p>
          <Select
            label="Editor"
            value={person.id}
            disabled={!ready}
            onChange={(event) => setChosen(event.target.value)}
          >
            {editors.map(({ id, name }) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
          <Cluster>
            <Button
              disabled={!ready}
              onClick={() => {
                setFault(null);
                setOpen(true);
              }}
            >
              Offer ownership
            </Button>
          </Cluster>
        </>
      ) : (
        <p className={styles.text}>
          This document has no Editor to offer ownership to. Give a collaborator the Editor role first.
        </p>
      )}

      {/* What the last action answered; focus comes here after an action. `aria-live` and not
          `role="status"`, which the statement of the people holds alone on this page (slice 16). */}
      <div aria-live="polite" ref={statusRef} tabIndex={-1}>
        {said ? <p className={styles.text}>{said}</p> : null}
      </div>
      {fault && !open ? <FormFault title={fault.message} focusKey={attempt} /> : null}

      <Dialog
        open={open}
        onClose={close}
        title="Offer ownership"
        aria-describedby="offer-name offer-statement"
        initialFocusRef={cancel}
      >
        <form method="post" noValidate ref={formRef} onSubmit={offerOwnership}>
          <Stack gap={5}>
            {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
            <Stack gap={1}>
              <p className={styles.meta}>Editor</p>
              <p className={styles.text}>
                <bdi id="offer-name" className={styles.documentTitle}>
                  {person?.name}
                </bdi>
              </p>
            </Stack>
            <p id="offer-statement" className={styles.text}>
              You are asking this Editor to accept ownership of this document. You stay the Owner until they
              accept. If they accept, they become the Owner, you become an Editor, and the document moves to
              their personal workspace. Everything else stays as it is. The offer is open for {days}{' '}
              {days === 1 ? 'day' : 'days'}.{' '}
              {secondFactor ? OFFER_PROMPT.passwordAndCode : OFFER_PROMPT.password}
            </p>
            <PromptFields idPrefix="offer" email={email} secondFactor={secondFactor} />
            <Cluster gap={3}>
              <Button type="submit" pending={pending} pendingLabel="Offering ownership…">
                Offer ownership
              </Button>
              <Button id={CANCEL_ID} onClick={close}>
                Cancel
              </Button>
            </Cluster>
          </Stack>
        </form>
      </Dialog>
    </Stack>
  );
}
