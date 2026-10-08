'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, FormFault, PageHeading, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../../components/send.ts';
import styles from '../../../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan): FR-AU-86 fixes no
// statement for a link that no longer works. The same words as the server's.
const NOT_VALID =
  'This link is no longer valid. A link to set a new password works once and is valid for 1 hour. Ask for a new one.';
// FR-AU-86: "a reset … does not sign the person in: the person then signs in
// with the new password", and "setting it ends every session of the account".
const CHANGED =
  'The password is changed, and every session of the account has ended. Sign in with the new password.';

/**
 * All that the page shows for a link that is spent, expired, or not known, and
 * the way to a new one. `announce` is for the statement that takes the form's
 * place after a submission: a screen reader says it, and it takes focus
 * (FR-AU-88). On a page that opens with the statement it is part of the page
 * and no alert, since an alert there from the first paint announces nothing.
 */
export function NotValid({ announce = false }: { announce?: boolean }) {
  return (
    <>
      <PageHeading>Set a new password</PageHeading>
      <FormFault title={NOT_VALID} announce={announce ? undefined : 'off'} />
      <p className={styles.text}>
        <Link href="/reset-password" prefetch={false}>
          Set a new password
        </Link>
      </p>
    </>
  );
}

export function ResetForm({
  token,
  email,
  passwordMinLength,
  passwordMaxLength,
}: {
  token: string;
  email: string;
  passwordMinLength: number;
  passwordMaxLength: number;
}) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const [changed, setChanged] = useState(false);
  const statement = useRef<HTMLParagraphElement>(null);

  // The statement takes the form's place and takes focus: the button that
  // was pressed is gone, and a screen reader reads what focus lands on.
  useEffect(() => {
    if (changed) statement.current?.focus();
  }, [changed]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    const refused = await send('/api/auth/reset-password', { token, newPassword: form.get('newPassword') });
    setPending(false);
    if (!refused) {
      setChanged(true);
      return;
    }
    setFault(refused);
    setAttempt((count) => count + 1);
  }

  // The link was used, or its hour passed, while the page was open.
  if (fault?.code === 'reset_link_not_valid') return <NotValid announce />;

  if (changed) {
    return (
      <>
        <PageHeading>Set a new password</PageHeading>
        <p ref={statement} tabIndex={-1} role="status" className={styles.text}>
          {CHANGED}
        </p>
        <p className={styles.text}>
          <Link href="/sign-in" prefetch={false}>
            Sign in
          </Link>
        </p>
      </>
    );
  }

  const refusal = fault?.fields?.newPassword;
  return (
    <>
      <PageHeading>Set a new password</PageHeading>
      <form method="post" noValidate onSubmit={submit}>
        <Stack gap={5}>
          {fault ? (
            // The one announcement (FR-AU-88). The rule that was not met is
            // also stated beside the field, in the server's words (FR-AU-82).
            <FormFault
              title={fault.message}
              faults={refusal ? [{ fieldId: 'newPassword', message: refusal }] : []}
              focusKey={attempt}
            />
          ) : null}
          {/* Read and not typed in, so that a password manager stores the new
              password under this address (FR-AU-88). It is not sent: the
              server takes the account from the link. */}
          <TextField
            id="email"
            type="email"
            label="Email address"
            hint="The new password is for the account with this address."
            autoComplete="username"
            value={email}
            readOnly
          />
          <PasswordField
            id="newPassword"
            name="newPassword"
            label="New password"
            hint={`A password has ${passwordMinLength} to ${passwordMaxLength} characters. Letters, numbers, symbols, and spaces are all accepted.`}
            toggleLabel="Show password"
            autoComplete="new-password"
            required
            error={refusal}
          />
          <div>
            <Button variant="primary" type="submit" pending={pending} pendingLabel="Setting password…">
              Set password
            </Button>
          </div>
        </Stack>
      </form>
    </>
  );
}
