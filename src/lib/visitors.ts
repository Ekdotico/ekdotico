// The text of the page for a visitor who is not signed in (FR-AU-93; register
// D327 to D330, docs commit 258a536). It is the owner's, approved on 17
// November 2026 (D330, answer "approve" to `visitor-text`); the line before
// the mailbox exists is the owner's answer "list-only" to
// `visitor-line-no-address`, of the same day. Change no word of it without the
// owner's approval: tests/unit/visitors.test.ts pins every text whole.

/** The internal path that answers `/` for a visitor. It answers 404 to a request that names it (src/proxy.ts). */
export const VISITORS_PATH = '/visitors-page';

/**
 * The mark the proxy puts on the request of a visitor for `/`, and on no other
 * request: it removes the header from every page request it passes on, so the
 * value a client sends never arrives (src/proxy.ts). `next.config.ts` rewrites
 * `/` to the page of visitors where the mark is present.
 *
 * Why a mark and a rewrite of the configuration, and not a rewrite by the
 * proxy: Next.js 16.4 compares the address a proxy rewrites to with its own,
 * which holds the host name the process was started with, after turning
 * `127.0.0.1` into `localhost` in the first alone. Started with
 * `--hostname 127.0.0.1` behind a reverse proxy, as a deployment is, it took
 * the rewrite for one to another origin and answered `/` with a 500. A rewrite
 * of the configuration names a path and no origin.
 */
export const VISITOR_HEADER = 'x-ekdotico-visitor';
export const VISITOR_MARK = '1';

/** The rewrite of `next.config.ts`, before the files of the build: `/` is a page of its own, for a person signed in. */
export const VISITORS_REWRITE = {
  source: '/',
  has: [{ type: 'header' as const, key: VISITOR_HEADER, value: VISITOR_MARK }],
  destination: VISITORS_PATH,
};

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
