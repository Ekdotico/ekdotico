'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Button, FormFault, Stack, TextField } from '@ekdotico/domico/components';
import { useReady } from '../../../components/ready.ts';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';

// FR-AU-86, the fixed statement, word for word. It is the answer to every
// request, whether or not the address belongs to an account.
const REQUESTED =
  'If this address belongs to an account, Ekdotico has sent it an email with a link to set a new password.';

/**
 * FR-AU-86, FR-AU-88. Once a request is answered the statement takes the
 * form's place and takes focus, which is how a screen reader comes to read it
 * and where the keyboard continues from: the button that was pressed is gone.
 */
export function ResetRequestForm() {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const [requested, setRequested] = useState(false);
  const statement = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (requested) statement.current?.focus();
  }, [requested]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    const refused = await send('/api/auth/request-password-reset', { email: form.get('email') });
    setPending(false);
    if (!refused) {
      setRequested(true);
      return;
    }
    setFault(refused);
    setAttempt((count) => count + 1);
  }

  if (requested) {
    return (
      <Stack gap={5}>
        <p ref={statement} tabIndex={-1} role="status" className={styles.text}>
          {REQUESTED}
        </p>
        <p className={styles.text}>
          <Link href="/sign-in" prefetch={false}>
            Sign in
          </Link>
        </p>
      </Stack>
    );
  }

  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
        <TextField
          id="email"
          name="email"
          type="email"
          label="Email address"
          hint="The address of the Ekdotico account."
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <div>
          <Button
            variant="primary"
            type="submit"
            disabled={!ready}
            pending={pending}
            pendingLabel="Sending link…"
          >
            Send link
          </Button>
        </div>
        <p className={styles.text}>
          <Link href="/sign-in" prefetch={false}>
            Sign in
          </Link>
        </p>
      </Stack>
    </form>
  );
}
