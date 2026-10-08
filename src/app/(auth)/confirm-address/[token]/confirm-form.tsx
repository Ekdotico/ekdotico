'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Button, FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import { useReady } from '../../../../components/ready.ts';
import { send, type Fault } from '../../../../components/send.ts';
import styles from '../../../pages.module.css';

const TITLE = 'Confirm the new email address';
// Text for a person (the owner's answer to Q6 of the plan): FR-AU-03 fixes no
// statement for a link that no longer works. The same words as the server's
// (src/lib/auth/name-and-address.ts).
const NOT_VALID =
  'This link is no longer valid. A link to confirm a new email address works once and is valid for 1 hour. Ask for a new one in the account settings.';

/**
 * All that the page shows for a link that no longer works. `announce` is for
 * the statement that takes the control's place after it was pressed
 * (FR-AU-88); on a page that opens with the statement it is part of the page
 * and no alert.
 */
export function NotValid({ announce = false }: { announce?: boolean }) {
  return (
    <>
      <PageHeading>{TITLE}</PageHeading>
      <FormFault title={NOT_VALID} announce={announce ? undefined : 'off'} />
      <p className={styles.text}>
        {/* The proxy sends a browser without a session to sign in first. */}
        <Link href="/settings" prefetch={false}>
          Account settings
        </Link>
      </p>
    </>
  );
}

/**
 * All that the page shows to a browser without a session (the owner's decision
 * of 9 October 2026): no control, and nothing of the link, of whether it is
 * valid, or of the address. The way to the sign-in page carries no token and
 * no place to return to; the person opens the link in the email again. Text
 * for a person, for the owner's approval.
 */
export function SignInFirst() {
  return (
    <>
      <PageHeading>{TITLE}</PageHeading>
      <p className={styles.text}>
        To confirm a new email address, sign in to the Ekdotico account that asked for the change, then open
        the link in the email again.
      </p>
      <p className={styles.text}>
        <Link href="/sign-in" prefetch={false}>
          Sign in
        </Link>
      </p>
    </>
  );
}

/** FR-AU-03: the address the account will have, and the one control. */
export function ConfirmForm({ token, newEmail }: { token: string; newEmail: string }) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const [done, setDone] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    const refused = await send('/api/auth/verify-email', { token });
    setPending(false);
    setFault(refused);
    if (refused) setAttempt((count) => count + 1);
    else setDone(true);
  }

  // The link was used, or made void, while the page was open.
  if (fault?.code === 'address_link_not_valid') return <NotValid announce />;

  return (
    <>
      <PageHeading>{TITLE}</PageHeading>
      {done ? (
        <>
          {/* FR-AU-03: what the change did, and what follows from it. */}
          <p className={styles.text}>
            The email address of the Ekdotico account is now {newEmail}. Sign-in uses this address from now
            on, and every other session of the account has ended.
          </p>
          <p className={styles.text}>
            <Link href="/" prefetch={false}>
              Open Ekdotico
            </Link>
          </p>
        </>
      ) : (
        <form method="post" noValidate onSubmit={submit}>
          <Stack gap={5}>
            {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
            <p className={styles.text}>
              This link changes the email address of an Ekdotico account to {newEmail}. After the change, the
              account signs in with this address, and every other session of the account ends.
            </p>
            <div>
              <Button
                variant="primary"
                type="submit"
                disabled={!ready}
                pending={pending}
                pendingLabel="Confirming…"
              >
                Confirm the new address
              </Button>
            </div>
          </Stack>
        </form>
      )}
      {/* Present from the first paint and empty until the change: a status
          that arrives with its text is not announced (FR-AU-88). */}
      <p role="status" className={styles.text}>
        {done ? 'The email address is changed.' : null}
      </p>
    </>
  );
}
