'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Cluster, Dialog, FormFault, RadioGroup, Select, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../../components/ready.ts';
import { PromptFields } from '../../../../components/prompt-fields.tsx';
import { sendFor, type Fault } from '../../../../components/send.ts';
import {
  confirmControl,
  confirmation,
  OPTION_LONGEST,
  OPTION_PERSON,
  offeredStatement,
  TRANSFER_ALL,
  TRANSFER_DIALOG,
  TRANSFER_PROMPT,
  TRANSFER_SCREEN,
} from '../../../../lib/account/transfer-texts.ts';
import { chosenPerson } from '../../../../lib/account/transfer-choice.ts';
import styles from '../../../pages.module.css';
import { InBrowser, LocalTime } from '../../local-time.tsx';

/** What the screen read of the states of the documents; the dates are ISO 8601, UTC. */
export type ShownState =
  | { kind: 'offered'; toName: string; expiresAt: string }
  | { kind: 'declined' | 'expired'; toName: string }
  | {
      kind: 'no_editor' | 'no_other_editor' | 'ready' | 'deleted' | 'being_deleted' | 'not_transferable';
    };

export interface ShownDocument {
  id: string;
  title: string;
  state: ShownState;
}

interface Counted {
  documentIds: string[];
  offered: number;
  kept: number;
  cannot: number;
}

const CANCEL_ID = 'transfer-cancel';

/** FR-AU-92: the state of one document, in the words of the screen. */
function StateText({ state }: { state: ShownState }) {
  switch (state.kind) {
    case 'offered':
      return (
        <InBrowser>
          <span>
            {TRANSFER_SCREEN.offered(state.toName)}, {TRANSFER_SCREEN.until}{' '}
            <LocalTime at={state.expiresAt} />.
          </span>
        </InBrowser>
      );
    case 'declined':
      return <span>{TRANSFER_SCREEN.declined(state.toName)}</span>;
    case 'expired':
      return <span>{TRANSFER_SCREEN.expired(state.toName)}</span>;
    case 'no_editor':
      return <span>{TRANSFER_SCREEN.noEditor}</span>;
    case 'no_other_editor':
      return <span>{TRANSFER_SCREEN.noOtherEditor}</span>;
    case 'ready':
      return <span>{TRANSFER_SCREEN.ready}</span>;
    case 'deleted':
      return (
        <span>
          {TRANSFER_SCREEN.deleted} <Link href="/deleted">{TRANSFER_SCREEN.deletedLink}</Link>
        </span>
      );
    case 'being_deleted':
      return <span>{TRANSFER_SCREEN.beingDeleted}</span>;
    case 'not_transferable':
      return <span>{TRANSFER_SCREEN.notTransferable}</span>;
  }
}

/**
 * FR-AU-92: "Transfer ownership of all documents" on the deletion screen: the state of each document, and the one
 * action with its choice ("To the longest-standing Editor", or "To one person") and its one confirmation, which
 * names the number of documents offered and the number that cannot be offered. The identifiers the screen counted go
 * with the request, and the server refuses (a 409) where the documents are not exactly those any more. The first
 * choice is preselected, so that the action and its confirmation are two clicks (FR-AU-58). A refusal is the
 * server's statement at the head of the dialog, with focus on it; focus opens on Cancel, the way that offers nothing.
 */
export function TransferDocuments({
  documents,
  accepted,
  longest,
  people,
  days,
  email,
  secondFactor,
}: {
  /** The account's address and whether it asks for a code: the prompt of FR-AU-92 (D285). */
  email: string;
  secondFactor: boolean;
  documents: ShownDocument[];
  accepted: { id: string; title: string; toName: string }[];
  longest: Counted;
  people: (Counted & { collaboratorId: string; name: string })[];
  days: number;
}) {
  const router = useRouter();
  const ready = useReady();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'longest' | 'person'>('longest');
  const [chosen, setChosen] = useState('');
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const statement = useRef<HTMLParagraphElement>(null);
  const [said, setSaid] = useState(0);
  // The offer was made, and the control that opened the dialog may be gone with the offers it was for: the
  // statement of what was done takes the focus, as for a clearing (WCAG 2.4.3).
  useEffect(() => {
    if (said > 0) statement.current?.focus();
  }, [said]);

  // The person chosen, as the list now holds them: one who has left it is no longer chosen, and none is put in their
  // place (src/lib/account/transfer-choice.ts); the action waits until a person is chosen again.
  const person = chosenPerson(people, chosen);
  const counted: Counted =
    mode === 'longest' ? longest : (person ?? { documentIds: [], offered: 0, kept: 0, cannot: 0 });
  const cancel = useMemo(
    () => ({
      get current() {
        return globalThis.document.getElementById(CANCEL_ID);
      },
    }),
    [],
  );
  const anything = longest.offered > 0 || people.length > 0;

  function close() {
    formRef.current?.reset();
    setFault(null);
    setOpen(false);
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    const prompt = {
      password: entered.get('password'),
      ...(secondFactor ? { code: entered.get('code') } : {}),
    };
    const sent = await sendFor(
      '/api/account/documents/transfer',
      mode === 'person' && person
        ? { mode, collaboratorId: person.collaboratorId, documentIds: person.documentIds, ...prompt }
        : { mode: 'longest', documentIds: longest.documentIds, ...prompt },
    );
    setPending(false);
    // Neither the password nor the code stays in the page, whatever the answer: a refused one is typed again.
    form.reset();
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      // What the server found is not what was shown: the screen is read again, and the dialog says so.
      router.refresh();
      return;
    }
    const answer = sent.answer as { offered: number; kept: number } | null;
    close();
    setStatus(
      answer ? offeredStatement(answer) : offeredStatement({ offered: counted.offered, kept: counted.kept }),
    );
    setSaid((count) => count + 1);
    router.refresh();
  }

  return (
    <Stack gap={4}>
      <h2 className={styles.heading}>{TRANSFER_SCREEN.heading}</h2>
      <p className={styles.text}>{TRANSFER_SCREEN.lead}</p>
      {/* Present from the first paint and empty until something is done: a status that arrives with its text is not announced. */}
      <p role="status" ref={statement} tabIndex={-1} className={styles.text}>
        {status}
      </p>

      <h3 className={styles.heading}>{TRANSFER_SCREEN.listHeading}</h3>
      {documents.length === 0 ? (
        <p className={styles.text}>{TRANSFER_SCREEN.none}</p>
      ) : (
        <ul className={styles.list}>
          {documents.map((document) => (
            <li key={document.id} className={styles.row}>
              <Stack gap={1}>
                {/* The title is text, whatever it holds (NFR-SE-08). */}
                <bdi className={styles.documentTitle}>{document.title}</bdi>
                <p className={styles.meta}>
                  <StateText state={document.state} />
                </p>
              </Stack>
            </li>
          ))}
        </ul>
      )}

      {accepted.length > 0 ? (
        <Stack gap={3}>
          <h3 className={styles.heading}>{TRANSFER_SCREEN.acceptedHeading}</h3>
          <ul className={styles.list}>
            {accepted.map((document) => (
              <li key={document.id} className={styles.row}>
                <Stack gap={1}>
                  <bdi className={styles.documentTitle}>{document.title}</bdi>
                  <p className={styles.meta}>{TRANSFER_SCREEN.accepted(document.toName)}</p>
                </Stack>
              </li>
            ))}
          </ul>
        </Stack>
      ) : null}

      {anything ? (
        <div>
          <Button
            disabled={!ready}
            onClick={() => {
              setFault(null);
              setOpen(true);
            }}
          >
            {TRANSFER_ALL}
          </Button>
        </div>
      ) : (
        <p className={styles.text}>{TRANSFER_SCREEN.nobodyToOffer}</p>
      )}

      <Dialog
        open={open}
        onClose={close}
        title={TRANSFER_DIALOG.title}
        aria-describedby="transfer-statement"
        initialFocusRef={cancel}
      >
        <form method="post" noValidate ref={formRef} onSubmit={confirm}>
          <Stack gap={5}>
            {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
            <RadioGroup
              legend={TRANSFER_DIALOG.legend}
              hint={TRANSFER_DIALOG.hint}
              name="transfer-mode"
              value={mode}
              onChange={(value) => setMode(value === 'person' ? 'person' : 'longest')}
              options={[
                { value: 'longest', label: OPTION_LONGEST },
                { value: 'person', label: OPTION_PERSON, disabled: people.length === 0 },
              ]}
            />
            {mode === 'person' ? (
              <Select
                label={TRANSFER_DIALOG.person}
                value={person?.collaboratorId ?? ''}
                onChange={(event) => setChosen(event.target.value)}
              >
                <option value="" disabled>
                  {TRANSFER_DIALOG.choose}
                </option>
                {people.map(({ collaboratorId, name, offered }) => (
                  <option key={collaboratorId} value={collaboratorId}>
                    {TRANSFER_DIALOG.personOption(name, offered)}
                  </option>
                ))}
              </Select>
            ) : null}
            <div id="transfer-statement">
              <Stack gap={3}>
                {confirmation({
                  mode,
                  personName: person ? person.name : null,
                  offered: counted.offered,
                  kept: counted.kept,
                  cannot: counted.cannot,
                }).map((line) => (
                  <p key={line} className={styles.text}>
                    {line}
                  </p>
                ))}
                {counted.offered > 0 ? (
                  <p className={styles.text}>{TRANSFER_DIALOG.acceptance(days)}</p>
                ) : null}
              </Stack>
            </div>
            <p className={styles.text}>
              {secondFactor ? TRANSFER_PROMPT.passwordAndCode : TRANSFER_PROMPT.password}
            </p>
            <PromptFields idPrefix="transfer" email={email} secondFactor={secondFactor} />
            <Cluster gap={3}>
              <Button
                type="submit"
                disabled={counted.offered === 0 || (mode === 'person' && !person)}
                pending={pending}
                pendingLabel={TRANSFER_DIALOG.pending}
              >
                {counted.offered > 0 ? confirmControl(counted.offered) : TRANSFER_DIALOG.legend}
              </Button>
              <Button id={CANCEL_ID} onClick={close}>
                {TRANSFER_DIALOG.cancel}
              </Button>
            </Cluster>
          </Stack>
        </form>
      </Dialog>
    </Stack>
  );
}
