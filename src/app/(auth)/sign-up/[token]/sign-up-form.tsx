'use client';

import { useState } from 'react';
import { Button, FormFault, PageHeading, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { useReady } from '../../../../components/ready.ts';
import { sendFor, type Fault } from '../../../../components/send.ts';
import { INVITATION_NOT_OPEN } from '../../../../lib/admission/statements.ts';

/**
 * All that the page shows for an invitation that is not open (FR-AU-90).
 * `announce` is for the statement that takes the form's place after a
 * submission: a screen reader says it, and it takes focus (FR-AU-88). On a
 * page that opens with the statement it is part of the page and no alert,
 * since an alert there from the first paint announces nothing.
 */
export function NotOpen({ announce = false }: { announce?: boolean }) {
  return (
    <>
      <PageHeading>Invitation</PageHeading>
      <FormFault title={INVITATION_NOT_OPEN} announce={announce ? undefined : 'off'} />
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
  const ready = useReady();

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    const sent = await sendFor('/api/sign-up', {
      token,
      name: form.get('name'),
      password: form.get('password'),
    });
    if (!('fault' in sent)) {
      // Signed in (FR-AU-90). The first screen is the server's to decide: the
      // Closed α notice (FR-AU-55). Where the account was created and its
      // session could not be started, the answer says so, and the person signs
      // in on the sign-in page.
      const signedIn = (sent.answer as { signedIn?: unknown } | null)?.signedIn !== false;
      // A full navigation on purpose: the server renders the next page under the new session.
      window.location.assign(signedIn ? '/' : '/sign-in');
      return;
    }
    setFault(sent.fault);
    setAttempt((count) => count + 1);
    setPending(false);
  }

  // The invitation was accepted, revoked, or expired while the page was open.
  if (fault?.code === 'invitation_not_open') return <NotOpen announce />;

  const fields = fault?.fields ?? {};
  return (
    <>
      <PageHeading>Create account</PageHeading>
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
            <Button
              variant="primary"
              type="submit"
              disabled={!ready}
              pending={pending}
              pendingLabel="Creating account…"
            >
              Create account
            </Button>
          </div>
        </Stack>
      </form>
    </>
  );
}
