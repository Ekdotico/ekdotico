'use client';

import { useState } from 'react';
import { Button, FormFault, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { send, type Fault } from '../../../components/send.ts';

/**
 * FR-AU-81, FR-AU-88. The refusal is the server's statement, word for word, at
 * the head of the form, where `FormFault` announces it and takes focus. The
 * form says nothing of its own about which of the two fields was wrong.
 */
export function SignInForm({ returnTo }: { returnTo: string }) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    const refused = await send('/api/auth/sign-in/email', {
      email: form.get('email'),
      password: form.get('password'),
    });
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

  return (
    // `method="post"`: a form sent before the script has loaded must never put
    // a password in an address. `noValidate`: the server decides, and its
    // answer is the one statement of a fault.
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? <FormFault title={fault.message} focusKey={attempt} /> : null}
        <TextField
          id="email"
          name="email"
          type="email"
          label="Email address"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
        <PasswordField
          id="password"
          name="password"
          label="Password"
          toggleLabel="Show password"
          autoComplete="current-password"
          required
        />
        <div>
          <Button variant="primary" type="submit" pending={pending} pendingLabel="Signing in…">
            Sign in
          </Button>
        </div>
      </Stack>
    </form>
  );
}
