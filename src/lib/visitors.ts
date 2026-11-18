// The text of the page for a visitor who is not signed in (FR-AU-93; register
// D327 to D330, docs commit 258a536). It is the owner's, approved on 17
// November 2026 (D330, answer "approve" to `visitor-text`); the line before
// the mailbox exists is the owner's answer "list-only" to
// `visitor-line-no-address`, of the same day. Change no word of it without the
// owner's approval: tests/unit/visitors.test.ts pins every text whole.

/** The internal path the proxy rewrites `/` to for a visitor. It answers 404 to a request that names it (src/proxy.ts). */
export const VISITORS_PATH = '/visitors-page';

/** Where a visitor adds their address. The application keeps none (D328). */
export const WAITING_LIST_URL = 'https://alpha.ekdoti.co';

export const VISITORS_TITLE = 'Ekdotico is in Closed α';
export const VISITORS_INTRO =
  'Ekdotico is being tested by a small group, and accounts are by invitation. Each invitation is sent by a person on the team.';
export const ADD_ADDRESS_LINK = 'Add your email address';
export const ALREADY_INVITED = 'Already invited?';
export const SIGN_IN_LINK = 'Sign in';

/**
 * The line that begins "To ask for one". With the contact address (register
 * D329: shown only once its mailbox exists, which the `CONTACT_ADDRESS`
 * setting says) it is the approved sentence; without it, the sentence with
 * the half about the address left off (answer "list-only").
 */
export function askLine(contactAddress: string | undefined): {
  before: string;
  after: string;
} {
  return contactAddress
    ? { before: 'To ask for one, add your email address to the list, or write to ', after: '.' }
    : { before: 'To ask for one, add your email address to the list.', after: '' };
}
