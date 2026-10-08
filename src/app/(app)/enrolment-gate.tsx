'use client';

import { useEffect, useRef, useState } from 'react';
import { FormFault, PageHeading, Stack } from '@ekdotico/domico/components';
import type { Fault } from '../../components/send.ts';
import styles from '../pages.module.css';
import { SignOutButton } from './sign-out-button.tsx';
import { TwoFactorEnrolment } from './two-factor-enrolment.tsx';

// Text for a person (the owner's answer to Q6 of the plan).
const WHY =
  'This account belongs to the Ekdotico team. An account of the team can be used only once two-factor authentication is turned on for it, and it stays on.';

/**
 * FR-AU-83: what an account of the founding team is shown in place of every
 * page until two-factor authentication is on: "the screen that turns
 * two-factor authentication on, …, with only the means to sign out beside
 * it". The layout renders it alone, so it is the page, with its own `<main>`,
 * as the Closed α notice is; that notice follows it (FR-AU-90).
 */
export function EnrolmentGate({ title, email }: { title: string; email: string }) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [fault, setFault] = useState<Fault | null>(null);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  return (
    <main className={styles.column}>
      <Stack gap={6}>
        <PageHeading ref={heading} tabIndex={-1}>
          {title}
        </PageHeading>
        <p className={styles.text}>{WHY}</p>
        {/* Once it is on, the address that was asked for is asked for again,
            and the server answers with the notice or with the page. */}
        <TwoFactorEnrolment email={email} level={2} onDone={() => window.location.reload()} />
        {/* Announced, and focus stays on the button that was pressed. */}
        {fault ? <FormFault title={fault.message} autoFocus={false} /> : null}
        <div>
          <SignOutButton variant="quiet" onFault={setFault} />
        </div>
      </Stack>
    </main>
  );
}
