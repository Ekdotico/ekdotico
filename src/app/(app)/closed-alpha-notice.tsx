'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Cluster, FormFault, Stack } from '@ekdotico/domico/components';
import { send, type Fault } from '../../components/send.ts';
import styles from '../pages.module.css';
import { SignOutButton } from './sign-out-button.tsx';

// Rule 4 of the package: a Greek letter is never set in the reading serif,
// which has none. The heading keeps the serif and its α takes the sans.
function withGreek(text: string) {
  return text.split(/(\p{Script=Greek}+)/u).map((part, index) =>
    index % 2 ? (
      <span key={index} className={styles.greek}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

/**
 * The onboarding wizard and its one step, the Closed α notice (FR-AU-55,
 * FR-AU-56). The layout renders it in place of every page, so it is the page:
 * its own `<main>`, as the package's `AccessGate` is, and not a dialog. Nothing
 * opened it and nothing dismisses it, and a dialog would bring an Escape key
 * and a page behind it, neither of which exists here.
 *
 * FR-AU-56: focus moves to the title when the notice is shown, which is how a
 * screen reader comes to announce it, and stays within the notice because the
 * two controls below are the only things on the page that take focus.
 */
export function ClosedAlphaNotice({
  title,
  body,
  version,
}: {
  title: string;
  body: string;
  version: number;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  function state(refused: Fault | null) {
    setFault(refused);
    if (refused) setAttempt((count) => count + 1);
  }

  async function acknowledge() {
    setPending(true);
    const refused = await send('/api/account/onboarding/acknowledgement', { version });
    if (!refused) {
      // "After the acknowledgement the user continues to the address they had
      // asked for" (FR-AU-55): the notice stood in place of that address, so
      // the same address is asked for again, and the server now answers with
      // the page.
      window.location.reload();
      return;
    }
    state(refused);
    setPending(false);
  }

  return (
    <main className={styles.prose}>
      <Stack gap={5}>
        <h1 ref={heading} tabIndex={-1} className={styles.title}>
          {withGreek(title)}
        </h1>
        <p className={styles.text}>{body}</p>
        {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
        <Cluster gap={3}>
          <Button variant="primary" pending={pending} pendingLabel="Continuing…" onClick={acknowledge}>
            Continue
          </Button>
          <SignOutButton variant="quiet" onFault={state} />
        </Cluster>
      </Stack>
    </main>
  );
}
