// What the server knows of the signed-in account, once for each request: the
// layout of the signed-in pages and every page under it ask here.
//
// A page asks as well as the layout, because Next.js renders a page beside its
// layout and not inside it: a layout that leaves `children` out still sends the
// page's content to the browser, in the data of the response. So while the
// enrolment in two-factor authentication or the Closed α notice is due, a page
// renders nothing (FR-AU-83, FR-AU-55: "in place of its content").
import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { validateSession, type ValidSession } from '../../lib/auth/session.ts';
import { CLOSED_ALPHA_NOTICE_TITLE, closedAlphaNoticeDue } from '../../lib/closed-alpha-notice.ts';
import { ensurePersonalWorkspace } from '../../lib/workspace.ts';
import { SIGN_IN_PATH } from '../../proxy.ts';
import { reading } from '../page-fault.ts';

/** The title of the screen that turns two-factor authentication on. Text for a person (the owner's answer to Q6). */
export const ENROLMENT_TITLE = 'Two-factor authentication';

export interface CurrentAccount extends ValidSession {
  /**
   * FR-AU-83: the account is of the founding team and has not turned
   * two-factor authentication on, so the layout shows the screen that turns
   * it on in place of every page.
   */
  enrolmentDue: boolean;
  /**
   * Something stands in place of the page, and the page renders nothing: the
   * Closed α notice (FR-AU-55), or the enrolment before it. True while the
   * enrolment is due, whatever the notice, so that every page that holds its
   * content back for the one holds it back for the other
   * (tests/unit/pages.test.ts).
   */
  noticeDue: boolean;
}

export const currentAccount = cache(async (): Promise<CurrentAccount> => {
  // The proxy has validated the session already, but Next.js skips the proxy
  // for a request that carries the build's identifier
  // (docs/operations/deployment.md), so the pages do not rest on it. A page is
  // read, so the signed copy serves (NFR-SE-02).
  // A fault of any of the three reads below is the page of a fault, and one
  // line that holds nothing of a row (page-fault.ts).
  const sent = await headers();
  const { session: admitted, stopped } = await reading(() => validateSession('GET', sent));
  const session = admitted ?? stopped;
  // FR-AU-07. The proxy's redirect carries the place to return to; this one
  // cannot, since a layout is not told the address it is rendered for.
  if (!session) redirect(SIGN_IN_PATH);

  // FR-AU-83: the founding-team gate, decided on the server and before the
  // notice (FR-AU-90: "the screen that turns two-factor authentication on,
  // with the notice after it"). Whether the notice is due is not read, and
  // nothing is written for the account: it "cannot use the application".
  if (stopped) return { ...session, enrolmentDue: true, noticeDue: true };

  // FR-AU-09: the backstop, at the account's first authenticated request.
  await reading(() => ensurePersonalWorkspace(session.userId));

  // FR-AU-55, FR-AU-56: decided on the server, from the recorded acknowledgement.
  return {
    ...session,
    enrolmentDue: false,
    noticeDue: await reading(() => closedAlphaNoticeDue(session.userId)),
  };
});

/** The title of a signed-in page, or that of what is shown in its place. */
export async function titled(title: string): Promise<Metadata> {
  const { enrolmentDue, noticeDue } = await currentAccount();
  return { title: enrolmentDue ? ENROLMENT_TITLE : noticeDue ? CLOSED_ALPHA_NOTICE_TITLE : title };
}
