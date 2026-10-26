'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
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
import { sendFor, type Fault } from '../../../../components/send.ts';
import { DELETED_ACCOUNT } from '../../../../lib/account/deleted-account.ts';
import styles from '../../../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan: approved with the pull request, docs/plan/slice-22.md,
// section 7). FR-AU-58 asks for "a confirmation that names what is replaced and what is kept and states that the
// deletion cannot be undone", and gives none of the words. Under the Expression Guidelines, system feedback,
// rule 13: what will happen, what cannot be undone, two options; and rule 13 of the instructional register,
// that what is irreversible is explained before the control and not after it.
const TEXT = {
  lead: 'Deleting the account ends your access to Ekdotico, and it cannot be undone.',
  replaced: 'What is replaced',
  replacedList: [
    'Your name and your email address are cleared. Nothing from which you could be found is put in their place.',
    'Your password, your two-factor authentication, and every session are deleted. No one can sign in to the account again.',
    'Your roles on other people’s documents end, and your pending invitations and offers of ownership end.',
    `Wherever Ekdotico would show your name, it shows “${DELETED_ACCOUNT}”.`,
  ],
  kept: 'What is kept',
  keptList: [
    'What you wrote in other people’s documents stays in them.',
    'The records that refer to the account stay, without a name or an address: invitations, notifications, and the security log, which is kept for a limited time.',
    'The time of the deletion, and your acknowledgement of the Closed α notice.',
  ],
  before:
    'Ekdotico carries out the deletion without you, in steps, and repeats a step that does not complete. From the moment you confirm, you are signed out and the account cannot be used.',
  control: 'Delete account',
  statement:
    'Deleting this account signs you out everywhere, closes every open connection, and clears your name and email address. This cannot be undone.',
  password: 'Enter your current password to confirm.',
  passwordAndCode: 'Enter your current password and a code to confirm.',
  codeHint: 'The six-digit code that the authenticator application shows now, or a recovery code.',
  done: 'The account is being deleted. Ekdotico has ended your access and completes the deletion without you. You can close this page.',
};

const DIALOG_STATEMENT_ID = 'delete-account-statement';
const CANCEL_ID = 'delete-account-cancel';

/**
 * FR-AU-58: the means to delete the account, for an account that owns no document (the page decides;
 * the route refuses one that does, and does not rest on this). The password, and the code where
 * two-factor authentication is on, are asked in the confirmation, "immediately before the action".
 * Neither stays in the page. A refusal is the server's statement at the head of the form, with focus
 * on it; focus opens on Cancel, the way that deletes nothing.
 */
export function DeleteAccount({ email, secondFactor }: { email: string; secondFactor: boolean }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const statement = useRef<HTMLParagraphElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The control that had focus is gone with the page's state: focus goes to the statement of what was done.
  useEffect(() => {
    if (done) statement.current?.focus();
  }, [done]);
  // Where the confirmation opens: on Cancel. The package's Button takes no ref, so the control is found by its id.
  const cancel = useMemo(
    () => ({
      get current() {
        return globalThis.document.getElementById(CANCEL_ID);
      },
    }),
    [],
  );

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    const sent = await sendFor(
      '/api/account',
      {
        password: entered.get('password'),
        ...(secondFactor ? { code: entered.get('code') } : {}),
      },
      'DELETE',
    );
    setPending(false);
    // Neither the password nor the code stays in the page, whatever the answer: a refused one is typed again.
    form.reset();
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    close();
    setDone(true);
  }

  /**
   * Cancel, Escape and the end of a deletion: the dialog keeps its children mounted, so what was typed
   * and the statement of the last refusal would be there when it is opened again. Neither is.
   */
  function close() {
    formRef.current?.reset();
    setFault(null);
    setOpen(false);
  }

  return (
    <Stack gap={5}>
      <p className={styles.text}>{TEXT.lead}</p>
      <Stack gap={3}>
        <h2 className={styles.heading}>{TEXT.replaced}</h2>
        <ul className={styles.statements}>
          {TEXT.replacedList.map((each) => (
            <li key={each}>{each}</li>
          ))}
        </ul>
      </Stack>
      <Stack gap={3}>
        <h2 className={styles.heading}>{TEXT.kept}</h2>
        <ul className={styles.statements}>
          {TEXT.keptList.map((each) => (
            <li key={each}>{each}</li>
          ))}
        </ul>
      </Stack>
      <p className={styles.text}>{TEXT.before}</p>
      {done ? null : (
        <div>
          <Button variant="destructive" disabled={!ready} onClick={() => setOpen(true)}>
            {TEXT.control}
          </Button>
        </div>
      )}
      {/* Present from the first paint and empty until the deletion: a status that arrives with its text is
          not announced (FR-AU-88). It takes focus once it has its text. */}
      <p role="status" ref={statement} tabIndex={-1} className={styles.text}>
        {done ? TEXT.done : null}
      </p>
      <Dialog
        open={open}
        onClose={close}
        title={TEXT.control}
        aria-describedby={DIALOG_STATEMENT_ID}
        initialFocusRef={cancel}
      >
        <form method="post" noValidate ref={formRef} onSubmit={confirm}>
          <Stack gap={5}>
            {fault ? <FormFault title={fault.message} headingLevel={3} focusKey={attempt} /> : null}
            <p id={DIALOG_STATEMENT_ID} className={styles.text}>
              {TEXT.statement} {secondFactor ? TEXT.passwordAndCode : TEXT.password}
            </p>
            {/* Read and not typed in, for a password manager (FR-AU-88). It is not sent. */}
            <TextField
              id="delete-account-email"
              type="email"
              label="Email address"
              hint="The password is for the account with this address."
              autoComplete="username"
              value={email}
              readOnly
            />
            <PasswordField
              id="delete-account-password"
              name="password"
              label="Current password"
              toggleLabel="Show current password"
              autoComplete="current-password"
              required
            />
            {secondFactor ? (
              // A text field, and not the field for a one-time code: a recovery code holds letters, which
              // that field's keypad cannot type.
              <TextField
                id="delete-account-code"
                name="code"
                label="Code"
                hint={TEXT.codeHint}
                autoComplete="one-time-code"
                autoCapitalize="none"
                spellCheck={false}
                required
              />
            ) : null}
            <Cluster gap={3}>
              <Button variant="destructive" type="submit" pending={pending} pendingLabel="Deleting account…">
                {TEXT.control}
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
