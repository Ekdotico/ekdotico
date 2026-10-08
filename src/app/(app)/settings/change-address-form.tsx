'use client';

import { useState } from 'react';
import { Button, FormFault, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { useReady } from '../../../components/ready.ts';
import { sendFor, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan). FR-AU-03: the
// address of an account of the founding team "cannot be changed … until the
// list itself has been changed".
const TEAM = 'This account belongs to the Ekdotico team, so its email address cannot be changed.';

/**
 * FR-AU-03, FR-AU-88: the request for a change of the address, "after entering
 * the current password". The answer to a request that passed its prompt is the
 * server's one statement, the same whatever the new address is, shown as it
 * is given. A refusal is the server's statement too, at the head of the form.
 *
 * Whether the account is of the founding team is the server's to say; the
 * form is not offered to such an account, and its endpoint sends it nothing.
 */
export function ChangeAddressForm({ email, foundingTeam }: { email: string; foundingTeam: boolean }) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const [asked, setAsked] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    setAsked(null);
    const sent = await sendFor('/api/auth/change-email', {
      newEmail: entered.get('newEmail'),
      password: entered.get('password'),
    });
    setPending(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    // The password does not stay in the page.
    form.reset();
    setFault(null);
    const message = (sent.answer as { message?: unknown } | null)?.message;
    setAsked(typeof message === 'string' ? message : null);
  }

  if (foundingTeam) {
    return (
      <Stack gap={5}>
        <p className={styles.text}>The email address of this account is {email}.</p>
        <p className={styles.text}>{TEAM}</p>
      </Stack>
    );
  }

  const refusal = fault?.fields?.newEmail;
  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? (
          <FormFault
            title={fault.message}
            faults={refusal ? [{ fieldId: 'newEmail', message: refusal }] : []}
            focusKey={attempt}
            headingLevel={3}
          />
        ) : null}
        {/* Read and not typed in: the address as it stands, and the one a
            password manager knows the password by (FR-AU-88). It is not sent. */}
        <TextField
          id="address-email"
          type="email"
          label="Current email address"
          hint="This address signs in to the account until a new one is confirmed."
          autoComplete="username"
          value={email}
          readOnly
        />
        <TextField
          id="newEmail"
          name="newEmail"
          type="email"
          label="New email address"
          hint="The change is made when a link sent to this address is opened."
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
          error={refusal}
        />
        <PasswordField
          id="address-password"
          name="password"
          label="Current password"
          toggleLabel="Show current password"
          autoComplete="current-password"
          required
        />
        <div>
          <Button
            variant="secondary"
            type="submit"
            disabled={!ready}
            pending={pending}
            pendingLabel="Sending request…"
          >
            Change email address
          </Button>
        </div>
        {/* Present from the first paint and empty until the answer: a status
            that arrives with its text is not announced (FR-AU-88). */}
        <p role="status" className={styles.text}>
          {asked}
        </p>
      </Stack>
    </form>
  );
}
