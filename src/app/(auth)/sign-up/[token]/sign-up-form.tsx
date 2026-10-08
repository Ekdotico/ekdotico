'use client';

import { useState } from 'react';
import { Button, FormFault, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../../components/send.ts';
import styles from '../../../pages.module.css';

// FR-AU-90, the fixed statement, word for word.
const NOT_OPEN = 'This invitation is not open. Ask the Ekdotico team for a new one.';

/**
 * All that the page shows for an invitation that is not open (FR-AU-90).
 * `announce` is for the statement that takes the form's place after a
 * submission, so that a screen reader says it (FR-AU-88).
 */
export function NotOpen({ announce = false }: { announce?: boolean }) {
  return (
    <>
      <h1 className={styles.title}>Invitation</h1>
      <p className={styles.text} role={announce ? 'alert' : undefined}>
        {NOT_OPEN}
      </p>
    </>
  );
}

const FIELDS = ['name', 'password'] as const;

export function SignUp({
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

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    const refused = await send('/api/sign-up', {
      token,
      name: form.get('name'),
      password: form.get('password'),
    });
    if (!refused) {
      // Signed in (FR-AU-90). The first screen is the server's to decide: the
      // Closed α notice (FR-AU-55).
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- a full navigation on purpose: the server renders the next page under the new session
      window.location.assign('/');
      return;
    }
    setFault(refused);
    setAttempt((count) => count + 1);
    setPending(false);
  }

  // The invitation was accepted, revoked, or expired while the page was open.
  if (fault?.code === 'invitation_not_open') return <NotOpen announce />;

  const fields = fault?.fields ?? {};
  return (
    <>
      <h1 className={styles.title}>Create account</h1>
      <form method="post" noValidate onSubmit={submit}>
        <Stack gap={5}>
          {fault ? (
            // The one announcement (FR-AU-88). Each rule that was not met is
            // also stated beside its field, in the server's words (FR-AU-82).
            <FormFault
              title={fault.message}
              faults={FIELDS.flatMap((name) =>
                fields[name] ? [{ fieldId: name, message: fields[name] }] : [],
              )}
              focusKey={attempt}
            />
          ) : null}
          {/* The invited address cannot be changed here (FR-AU-90). A field
              that is read and not typed in, so that a password manager stores
              the password under this address (FR-AU-88). It is not sent: the
              server takes the address from the invitation. */}
          <TextField
            id="email"
            type="email"
            label="Email address"
            hint="The invitation was sent to this address. It cannot be changed here."
            autoComplete="username"
            value={email}
            readOnly
          />
          <TextField
            id="name"
            name="name"
            label="Name"
            hint="1 to 100 characters."
            autoComplete="name"
            required
            error={fields.name}
          />
          <PasswordField
            id="password"
            name="password"
            label="Password"
            hint={`A password has ${passwordMinLength} to ${passwordMaxLength} characters. Letters, numbers, symbols, and spaces are all accepted.`}
            toggleLabel="Show password"
            autoComplete="new-password"
            required
            error={fields.password}
          />
          <div>
            <Button variant="primary" type="submit" pending={pending} pendingLabel="Creating account…">
              Create account
            </Button>
          </div>
        </Stack>
      </form>
    </>
  );
}
