'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, FormFault, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { useReady } from '../../../components/ready.ts';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan). FR-AU-85: "every
// other session of the account ends".
const CHANGED = 'Password changed. Every other session of this account has ended.';

/**
 * FR-AU-85, FR-AU-88: the change of the password, which "requires the current
 * password". A refusal is the server's statement, word for word, at the head
 * of the form; a rule the new password did not meet is also stated beside it.
 */
export function ChangePasswordForm({
  email,
  passwordMinLength,
  passwordMaxLength,
}: {
  email: string;
  passwordMinLength: number;
  passwordMaxLength: number;
}) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const [changed, setChanged] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    setChanged(false);
    const refused = await send('/api/auth/change-password', {
      currentPassword: entered.get('currentPassword'),
      newPassword: entered.get('newPassword'),
    });
    setPending(false);
    setFault(refused);
    if (refused) {
      setAttempt((count) => count + 1);
      return;
    }
    // Neither password stays in the page, and the list of sessions is read again.
    form.reset();
    setChanged(true);
    router.refresh();
  }

  const refusal = fault?.fields?.newPassword;
  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? (
          <FormFault
            title={fault.message}
            faults={refusal ? [{ fieldId: 'newPassword', message: refusal }] : []}
            focusKey={attempt}
            headingLevel={3}
          />
        ) : null}
        {/* Read and not typed in, so that a password manager stores the new
            password under this address (FR-AU-88). It is not sent. */}
        <TextField
          id="email"
          type="email"
          label="Email address"
          hint="The password is for the account with this address."
          autoComplete="username"
          value={email}
          readOnly
        />
        <PasswordField
          id="currentPassword"
          name="currentPassword"
          label="Current password"
          toggleLabel="Show current password"
          autoComplete="current-password"
          required
        />
        <PasswordField
          id="newPassword"
          name="newPassword"
          label="New password"
          hint={`A password has ${passwordMinLength} to ${passwordMaxLength} characters. Letters, numbers, symbols, and spaces are all accepted.`}
          toggleLabel="Show new password"
          autoComplete="new-password"
          required
          error={refusal}
        />
        <div>
          <Button
            variant="primary"
            type="submit"
            disabled={!ready}
            pending={pending}
            pendingLabel="Changing password…"
          >
            Change password
          </Button>
        </div>
        {/* Present from the first paint and empty until the change: a status
            that arrives with its text is not announced (FR-AU-88). */}
        <p role="status" className={styles.text}>
          {changed ? CHANGED : null}
        </p>
      </Stack>
    </form>
  );
}
