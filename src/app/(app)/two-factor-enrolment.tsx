'use client';

import { useEffect, useRef, useState } from 'react';
import {
  Button,
  FormFault,
  OneTimeCodeField,
  PasswordField,
  Stack,
  TextArea,
  TextField,
} from '@ekdotico/domico/components';
import { sendFor, type Fault } from '../../components/send.ts';
import styles from '../pages.module.css';

// Text for a person (the owner's answer to Q6 of the plan). FR-AU-83 fixes
// none of it.
const TEXT = {
  secretHeading: 'Add this account to an authenticator application',
  secretBody:
    'An authenticator application shows a six-digit code that changes every 30 seconds. Add this account to one: open the link on a device that has the application, or type the secret into it. Then enter the code it shows.',
  secretLink: 'Open in the authenticator application on this device',
  secretHint:
    'Type this into the authenticator application where the link cannot be opened. The account is named Ekdotico, and the code is based on the time.',
  codesHeading: 'Keep the recovery codes',
  codesHint:
    'Each recovery code signs this account in once, in place of a code from the authenticator application. Keep them where only you can read them. They are shown here once and cannot be shown again.',
};

/** What the server answered with, where it is the shape that was asked for. */
const texts = (answer: unknown, ...names: string[]) =>
  typeof answer === 'object' && answer !== null && names.every((name) => name in answer)
    ? (answer as Record<string, unknown>)
    : null;

/**
 * The recovery codes, "shown once", with the statement "to keep them"
 * (FR-AU-83). A field that is read and not typed in: each code can be selected
 * and copied, by keyboard too (FR-AU-88). `done` is the one way on from them.
 */
export function RecoveryCodes({
  codes,
  doneLabel,
  onDone,
  level,
}: {
  codes: readonly string[];
  doneLabel: string;
  onDone: () => void;
  /** The level of the heading, under that of the part of the page it stands in. */
  level: 2 | 3;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const Heading = `h${level}` as const;
  // The form that asked for them is gone, and focus with it (FR-AU-88).
  useEffect(() => heading.current?.focus(), []);
  return (
    <Stack gap={5}>
      <Heading ref={heading} tabIndex={-1} className={styles.heading}>
        {TEXT.codesHeading}
      </Heading>
      <TextArea
        id="two-factor-recovery-codes"
        label="Recovery codes"
        hint={TEXT.codesHint}
        value={codes.join('\n')}
        rows={codes.length}
        readOnly
        spellCheck={false}
      />
      <div>
        <Button variant="primary" onClick={onDone}>
          {doneLabel}
        </Button>
      </div>
    </Stack>
  );
}

type Stage =
  { name: 'password' } | { name: 'code'; secret: string; uri: string } | { name: 'codes'; codes: string[] };

/**
 * FR-AU-83, FR-AU-88: turning two-factor authentication on. "The user enters
 * the current password, adds to an authenticator application the secret the
 * application shows, …, and confirms with one code from it; only then is it
 * on", and then the recovery codes, once.
 *
 * The secret is shown as text and as a link that holds it. FR-AU-83 asks for
 * a QR code as well; the package has no control that draws one and the
 * application has no encoder, so the image waits for one (reported to the
 * owner with the pull request).
 */
export function TwoFactorEnrolment({
  email,
  onDone,
  level,
  intro,
}: {
  email: string;
  /** Called when the person leaves the recovery codes: two-factor authentication is on by then. */
  onDone: () => void;
  level: 2 | 3;
  /** What stands above the password, and only there: once the first code is accepted it is no longer so. */
  intro?: string;
}) {
  const Heading = `h${level}` as const;
  const [stage, setStage] = useState<Stage>({ name: 'password' });
  const [fault, setFault] = useState<Fault | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [pending, setPending] = useState(false);
  const secretHeading = useRef<HTMLHeadingElement>(null);

  // The form of the password is gone when the secret is shown, and focus with it.
  useEffect(() => {
    if (stage.name === 'code') secretHeading.current?.focus();
  }, [stage.name]);

  async function post(path: string, body: unknown): Promise<unknown> {
    if (pending) return null;
    setPending(true);
    const sent = await sendFor(path, body);
    setPending(false);
    if ('fault' in sent) {
      setFault(sent.fault);
      setAttempt((count) => count + 1);
      return null;
    }
    setFault(null);
    return sent.answer;
  }

  async function begin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = new FormData(event.currentTarget);
    const answer = texts(
      await post('/api/auth/two-factor/enable', { password: entered.get('password') }),
      'secret',
      'totpURI',
    );
    if (answer) setStage({ name: 'code', secret: String(answer.secret), uri: String(answer.totpURI) });
  }

  async function confirm(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const entered = new FormData(event.currentTarget);
    const answer = texts(
      await post('/api/auth/two-factor/verify-totp', { code: entered.get('code') }),
      'recoveryCodes',
    );
    if (answer && Array.isArray(answer.recoveryCodes)) {
      setStage({ name: 'codes', codes: answer.recoveryCodes.map(String) });
    }
  }

  if (stage.name === 'codes') {
    return <RecoveryCodes codes={stage.codes} doneLabel="Continue" onDone={onDone} level={level} />;
  }

  const head = fault ? (
    <FormFault
      title={fault.message}
      faults={fault.fields?.code ? [{ fieldId: 'two-factor-code', message: fault.fields.code }] : []}
      focusKey={attempt}
      headingLevel={level}
    />
  ) : null;

  if (stage.name === 'code') {
    return (
      <form method="post" noValidate onSubmit={confirm}>
        <Stack gap={5}>
          <Heading ref={secretHeading} tabIndex={-1} className={styles.heading}>
            {TEXT.secretHeading}
          </Heading>
          <p className={styles.text}>{TEXT.secretBody}</p>
          <p className={styles.text}>
            <a href={stage.uri}>{TEXT.secretLink}</a>
          </p>
          <TextField
            id="two-factor-secret"
            label="Secret"
            hint={TEXT.secretHint}
            value={stage.secret}
            readOnly
            spellCheck={false}
            autoComplete="off"
          />
          {head}
          <OneTimeCodeField
            id="two-factor-code"
            name="code"
            label="Six-digit code"
            hint="The code that the authenticator application shows for Ekdotico now."
            required
            error={fault?.fields?.code}
          />
          <div>
            <Button variant="primary" type="submit" pending={pending} pendingLabel="Turning on…">
              Turn on two-factor authentication
            </Button>
          </div>
        </Stack>
      </form>
    );
  }

  return (
    <form method="post" noValidate onSubmit={begin}>
      <Stack gap={5}>
        {intro ? <p className={styles.text}>{intro}</p> : null}
        {head}
        {/* Read and not typed in, so that a password manager offers the
            password of this address (FR-AU-88). It is not sent. */}
        <TextField
          id="two-factor-email"
          type="email"
          label="Email address"
          hint="The password is that of the account with this address."
          autoComplete="username"
          value={email}
          readOnly
        />
        <PasswordField
          id="two-factor-password"
          name="password"
          label="Current password"
          toggleLabel="Show current password"
          autoComplete="current-password"
          required
        />
        <div>
          <Button variant="primary" type="submit" pending={pending} pendingLabel="Continuing…">
            Continue
          </Button>
        </div>
      </Stack>
    </form>
  );
}
