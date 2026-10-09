'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button, FormFault, PasswordField, Stack, TextField } from '@ekdotico/domico/components';
import { sendFor, type Fault } from '../../../components/send.ts';
import styles from '../../pages.module.css';
import { RecoveryCodes, TwoFactorEnrolment } from '../two-factor-enrolment.tsx';

// Text for a person (the owner's answer to Q6 of the plan). FR-AU-83 fixes
// none of it.
const TEXT = {
  off: 'Two-factor authentication is turned off. With it turned on, each sign-in asks for the password and then for a code from an authenticator application.',
  on: 'Two-factor authentication is turned on. Each sign-in asks for the password and then for a code from the authenticator application.',
  replace:
    'Replacing the recovery codes gives ten new ones. All earlier codes stop working, including the codes that have not been used.',
  team: 'This account belongs to the Ekdotico team, so two-factor authentication cannot be turned off for it.',
  turnOff:
    'Turning two-factor authentication off needs the current password and either the code that the authenticator application shows now or a recovery code.',
};

/** One form of this part of the page: the address for a password manager, the current password, and what else it asks. */
function PasswordForm({
  name,
  email,
  path,
  withCode,
  label,
  pendingLabel,
  variant,
  onAnswer,
}: {
  /** Tells the fields of this form from those of the others on the page. */
  name: string;
  email: string;
  path: string;
  withCode?: boolean;
  label: string;
  pendingLabel: string;
  variant: 'secondary' | 'destructive';
  onAnswer: (answer: unknown) => void;
}) {
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const entered = new FormData(form);
    setPending(true);
    const sent = await sendFor(path, {
      password: entered.get('password'),
      ...(withCode ? { code: entered.get('code') } : {}),
    });
    setPending(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return;
    }
    // No password and no code stays in the page.
    form.reset();
    setFault(null);
    onAnswer(sent.answer);
  }

  return (
    <form method="post" noValidate onSubmit={submit}>
      <Stack gap={5}>
        {fault ? <FormFault title={fault.message} focusKey={attempt} headingLevel={4} /> : null}
        {/* Read and not typed in, for a password manager (FR-AU-88). It is not sent. */}
        <TextField
          id={`${name}-email`}
          type="email"
          label="Email address"
          hint="The password is for the account with this address."
          autoComplete="username"
          value={email}
          readOnly
        />
        <PasswordField
          id={`${name}-password`}
          name="password"
          label="Current password"
          toggleLabel="Show current password"
          autoComplete="current-password"
          required
        />
        {withCode ? (
          // A text field, and not the field for a one-time code: a recovery
          // code holds letters, which that field's keypad cannot type.
          <TextField
            id={`${name}-code`}
            name="code"
            label="Code"
            hint="The six-digit code that the authenticator application shows now, or a recovery code."
            autoComplete="one-time-code"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        ) : null}
        <div>
          <Button variant={variant} type="submit" pending={pending} pendingLabel={pendingLabel}>
            {label}
          </Button>
        </div>
      </Stack>
    </form>
  );
}

/**
 * FR-AU-83, FR-AU-88: the part of the account settings in which a user turns
 * two-factor authentication on or off and replaces the recovery codes. Whether
 * it is on, and whether the account is of the founding team, are the server's
 * to say; the control that turns it off "is not offered" to such an account,
 * and its endpoint refuses one as well.
 */
export function TwoFactorSettings({
  email,
  on,
  foundingTeam,
}: {
  email: string;
  on: boolean;
  foundingTeam: boolean;
}) {
  const router = useRouter();
  const [codes, setCodes] = useState<string[] | null>(null);

  if (!on) {
    return <TwoFactorEnrolment email={email} level={3} intro={TEXT.off} onDone={() => router.refresh()} />;
  }
  if (codes) {
    return <RecoveryCodes codes={codes} doneLabel="Done" level={3} onDone={() => setCodes(null)} />;
  }
  return (
    <Stack gap={7}>
      <p className={styles.text}>{TEXT.on}</p>
      <Stack gap={5}>
        <h3 className={styles.heading}>Recovery codes</h3>
        <p className={styles.text}>{TEXT.replace}</p>
        <PasswordForm
          name="replace-codes"
          email={email}
          path="/api/auth/two-factor/generate-backup-codes"
          label="Replace recovery codes"
          pendingLabel="Replacing…"
          variant="secondary"
          onAnswer={(answer) => {
            const made = (answer as { recoveryCodes?: unknown } | null)?.recoveryCodes;
            if (Array.isArray(made)) setCodes(made.map(String));
          }}
        />
      </Stack>
      <Stack gap={5}>
        <h3 className={styles.heading}>Turn off</h3>
        {foundingTeam ? (
          <p className={styles.text}>{TEXT.team}</p>
        ) : (
          <>
            <p className={styles.text}>{TEXT.turnOff}</p>
            <PasswordForm
              name="turn-off"
              email={email}
              path="/api/auth/two-factor/disable"
              withCode
              label="Turn off two-factor authentication"
              pendingLabel="Turning off…"
              variant="destructive"
              onAnswer={() => router.refresh()}
            />
          </>
        )}
      </Stack>
    </Stack>
  );
}
