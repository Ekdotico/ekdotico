'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, FormFault, Stack, TextField } from '@ekdotico/domico/components';
import { useReady } from '../../../components/ready.ts';
import { send, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan).
const CHANGED = 'The name is changed.';

/**
 * FR-AU-90, FR-AU-88: "the user can change it in the account settings". A
 * refusal is the server's statement, word for word, at the head of the form;
 * the rule the name did not meet is also stated beside it.
 */
export function NameForm({ name }: { name: string }) {
  const router = useRouter();
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const ready = useReady();
  const [changed, setChanged] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const entered = new FormData(event.currentTarget);
    setPending(true);
    setChanged(false);
    const refused = await send('/api/auth/update-user', { name: entered.get('name') });
    setPending(false);
    setFault(refused);
    if (refused) {
      setAttempt((count) => count + 1);
      return;
    }
    setChanged(true);
    router.refresh();
  }

  const refusal = fault?.fields?.name;
  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? (
          <FormFault
            title={fault.message}
            faults={refusal ? [{ fieldId: 'name', message: refusal }] : []}
            focusKey={attempt}
            headingLevel={3}
          />
        ) : null}
        <TextField
          id="name"
          name="name"
          label="Name"
          hint="The name that collaborators see beside this account. It has 1 to 100 characters."
          autoComplete="name"
          defaultValue={name}
          required
          error={refusal}
        />
        <div>
          <Button
            variant="secondary"
            type="submit"
            disabled={!ready}
            pending={pending}
            pendingLabel="Changing name…"
          >
            Change name
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
