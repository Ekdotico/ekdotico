// The link that confirms a changed address (FR-AU-03), as a row. A file of its
// own, so that password.ts, which makes such a link void, loads nothing of the
// endpoints that write and confirm one (name-and-address.ts).
import type { db } from '../db.ts';

// A pending change of address is a row of the identity library's table of
// single-use tokens (Data models, `Verification`: "single-use tokens for a
// password reset and for the confirmation of a changed address"). The
// identifier is this prefix and the hash of the token. The value is the user
// and the new address, with one space between: the table has no third column,
// an identifier of a user holds no space, and an address holds none either
// (../field-text.ts). The row is removed when it is used, when it is made
// void, and by the timer once its hour has passed (NFR-RE-15).
//
// For the slice that builds the deletion of an account (FR-AU-58 (d)): the
// row holds an address, and is not found by `value: userId`; `voidAddressLinks`
// deletes it.
export const ADDRESS_LINK = 'confirm-address:';

/** The value of the row of a pending change. */
export const pendingChange = (userId: string, newEmail: string) => `${userId} ${newEmail}`;

/** The user and the new address of a row's value. */
export function changeOf(value: string): { userId: string; newEmail: string } {
  const at = value.indexOf(' ');
  return { userId: value.slice(0, at), newEmail: value.slice(at + 1) };
}

/**
 * Makes void every pending change of address of the account: at every later
 * request that passed its prompt, whether or not it writes a new link (the
 * owner, 9 October 2026: "a later request voids the earlier link"), where a
 * change completes, and where the password of the account is reset or changed
 * (password.ts).
 *
 * FR-AU-03 states none of the three; its register row is pending. A link sent
 * to an address typed wrongly does not outlive the request that corrects it,
 * the fate of an earlier link shows nothing of the address named after it,
 * and a change asked for under a password that has since been set anew is not
 * confirmed after it.
 */
export async function voidAddressLinks(
  tx: Pick<ReturnType<typeof db>, 'verification'>,
  userId: string,
): Promise<void> {
  await tx.verification.deleteMany({
    where: { identifier: { startsWith: ADDRESS_LINK }, value: { startsWith: pendingChange(userId, '') } },
  });
}
