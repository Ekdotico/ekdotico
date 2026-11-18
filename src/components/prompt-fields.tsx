'use client';

import { PasswordField, TextField } from '@ekdotico/domico/components';

// The fields of the prompt that FR-ED-47 and FR-AU-92 put in front of an offer of ownership and of the transfer of all
// documents (D285; register Q82 point 6), as the deletion of an account has them (FR-AU-58): the password, and the
// code where two-factor authentication is on. The words are those of the deletion dialog, which the owner approved.
// Neither value stays in the page: the form that holds them is reset after every answer.

/** The hint of the code: "The six-digit code that the authenticator application shows now, or a recovery code." */
const CODE_HINT = 'The six-digit code that the authenticator application shows now, or a recovery code.';

export function PromptFields({
  idPrefix,
  email,
  secondFactor,
}: {
  idPrefix: string;
  email: string;
  secondFactor: boolean;
}) {
  return (
    <>
      {/* Read and not typed in, for a password manager (FR-AU-88). It is not sent. */}
      <TextField
        id={`${idPrefix}-email`}
        type="email"
        label="Email address"
        hint="The password is for the account with this address."
        autoComplete="username"
        value={email}
        readOnly
      />
      <PasswordField
        id={`${idPrefix}-password`}
        name="password"
        label="Current password"
        toggleLabel="Show current password"
        autoComplete="current-password"
        required
      />
      {secondFactor ? (
        // A text field, and not the field for a one-time code: a recovery code holds letters, which that field's
        // keypad cannot type.
        <TextField
          id={`${idPrefix}-code`}
          name="code"
          label="Code"
          hint={CODE_HINT}
          autoComplete="one-time-code"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      ) : null}
    </>
  );
}
