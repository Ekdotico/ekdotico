'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../../../components/ready.ts';
import { sendFor, type Fault } from '../../../../../components/send.ts';
import styles from '../../../../pages.module.css';

// FR-AU-81, verbatim: the one statement of a link that is spent, void, or not
// known. The same words as the server's (src/lib/auth/sign-in-lock.ts).
const NOT_VALID =
  'This link is no longer valid. Sign in with your email address and password, or set a new password from the sign-in page.';
// Text for a person (the owner's answer to Q6 of the plan): FR-AU-81 says what
// the page states and fixes no words for it.
const OTHER_ACCOUNT = 'This browser is signed in to another account. Signing in here ends that session.';

/**
 * All that the page shows for a link that no longer works, and the way to the
 * sign-in page its statement names. `announce` is for the statement that takes
 * the control's place after it was pressed (FR-AU-88); on a page that opens
 * with the statement it is part of the page and no alert.
 */
export function NotValid({ announce = false }: { announce?: boolean }) {
  return (
    <>
      <PageHeading>Sign in</PageHeading>
      <FormFault title={NOT_VALID} announce={announce ? undefined : 'off'} />
      <p className={styles.text}>
        <Link href="/sign-in" prefetch={false}>
          Sign in
        </Link>
      </p>
    </>
  );
}

/** FR-AU-81: the address that will be signed in, and the one control. */
export function LinkForm({
  token,
  email,
  otherAccount,
}: {
  token: string;
  email: string;
  otherAccount: boolean;
}) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    const sent = await sendFor('/api/auth/sign-in/link', { token });
    if (!('fault' in sent)) {
      // FR-AU-83: where the account has two-factor authentication on, a code
      // is asked for, and there is no session yet. A full navigation: the
      // next page is rendered by the server, and nothing of this one is kept.
      const secondStep = (sent.answer as { twoFactorRedirect?: unknown } | null)?.twoFactorRedirect === true;
      window.location.assign(secondStep ? '/sign-in/two-factor' : '/');
      return;
    }
    setFault(sent.fault);
    setAttempt((count) => count + 1);
    setPending(false);
  }

  // The link was used, or its lock ended, while the page was open.
  if (fault?.code === 'sign_in_link_not_valid') return <NotValid announce />;

  return (
    <>
      <PageHeading>Sign in</PageHeading>
      <form method="post" noValidate onSubmit={submit}>
        <Stack gap={5}>
          {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
          <p className={styles.text}>
            This link signs in to the Ekdotico account with the email address {email}, and lifts the lock on
            sign-in to it.
          </p>
          {otherAccount ? <p className={styles.text}>{OTHER_ACCOUNT}</p> : null}
          <div>
            <Button
              variant="primary"
              type="submit"
              disabled={!ready}
              pending={pending}
              pendingLabel="Signing in…"
            >
              Sign in
            </Button>
          </div>
        </Stack>
      </form>
    </>
  );
}
