'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, Cluster, FormFault, OneTimeCodeField, Stack, TextField } from '@ekdotico/domico/components';
import { useReady } from '../../../../components/ready.ts';
import { send, type Fault } from '../../../../components/send.ts';
import styles from '../../../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan).
const TEXT = {
  code: 'To finish signing in, enter the six-digit code that the authenticator application shows for Ekdotico now.',
  recovery:
    'To finish signing in, enter one of the recovery codes of the account. A recovery code works once.',
};

/**
 * FR-AU-83, FR-AU-88: the code after the password. One field: the field for a
 * one-time code, or, where the person says so, a text field for a recovery
 * code, which "is accepted in its place" and holds letters. A refusal is the
 * server's statement, word for word, at the head of the form. Nothing here is
 * timed by the page; the server says when the step can no longer be completed,
 * and the page then leads back to the sign-in page.
 */
export function SecondStepForm({ returnTo }: { returnTo: string }) {
  const [recovery, setRecovery] = useState(false);
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    const refused = await send(
      recovery ? '/api/auth/two-factor/verify-backup-code' : '/api/auth/two-factor/verify-totp',
      { code: form.get('code') },
    );
    if (!refused) {
      // A full navigation: the next page is rendered by the server under the
      // new session, and nothing of this one is kept.
      window.location.assign(returnTo);
      return;
    }
    setFault(refused);
    setAttempt((count) => count + 1);
    setPending(false);
  }

  // The sign-in "begins again with the password" (NFR-SE-07): no field is left
  // to fill. Nor is one where the step began from the link of a lock email and
  // the link is spent or void (FR-AU-81): the statement is the link's own.
  if (fault?.code === 'sign_in_again' || fault?.code === 'sign_in_link_not_valid') {
    const signIn = returnTo === '/' ? '/sign-in' : `/sign-in?return=${encodeURIComponent(returnTo)}`;
    return (
      <FormFault title={fault.message} focusKey={attempt}>
        <p>
          <Link href={signIn} prefetch={false}>
            Sign in again
          </Link>
        </p>
      </FormFault>
    );
  }

  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
        <p className={styles.text}>{recovery ? TEXT.recovery : TEXT.code}</p>
        {recovery ? (
          <TextField
            key="recovery"
            id="code"
            name="code"
            label="Recovery code"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        ) : (
          <OneTimeCodeField key="code" id="code" name="code" label="Six-digit code" required />
        )}
        <Cluster gap={3}>
          <Button
            variant="primary"
            type="submit"
            disabled={!ready}
            pending={pending}
            pendingLabel="Signing in…"
          >
            Sign in
          </Button>
          <Button
            variant="quiet"
            disabled={!ready}
            onClick={() => {
              setRecovery((now) => !now);
              setFault(null);
            }}
          >
            {recovery ? 'Use a code from the authenticator application' : 'Use a recovery code'}
          </Button>
        </Cluster>
      </Stack>
    </form>
  );
}
