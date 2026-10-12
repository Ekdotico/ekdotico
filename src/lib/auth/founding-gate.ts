// The founding-team gate of FR-AU-83 (register D114; A102, assumed): an account
// whose verified address is on the list of the founding team reaches "no page,
// no API route, and no collaboration handshake" until two-factor
// authentication is on.
//
// One function, so that the web application and the collaboration server
// cannot differ. The list is the setting `FOUNDING_TEAM_EMAILS`, read when the
// process starts and lowered then; it is never taken from a request or from
// the database. Nothing here is of Next.js.
import { addressSpelling } from '../field-text.ts';
import { settings } from '../settings.ts';

/** The columns of an account's row that the gate reads. */
export interface GatedAccount {
  email: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean | null;
}

/**
 * Whether the gate stops this account, now. The caller reads the row at each
 * request and at each handshake, and passes the row and nothing of the request.
 *
 * FR-AU-83: "An account of the founding team is one whose verified email
 * address is on the list", compared "without regard to case". Anything but
 * `true` for two-factor authentication is taken as off.
 */
export function stoppedByFoundingGate(account: GatedAccount): boolean {
  if (account.twoFactorEnabled === true) return false;
  if (account.emailVerified !== true || typeof account.email !== 'string') return false;
  return settings().foundingTeamEmails.includes(addressSpelling(account.email));
}
