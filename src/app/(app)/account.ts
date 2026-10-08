// What the server knows of the signed-in account, once for each request: the
// layout of the signed-in pages and every page under it ask here.
//
// A page asks as well as the layout, because Next.js renders a page beside its
// layout and not inside it: a layout that leaves `children` out still sends the
// page's content to the browser, in the data of the response. So while the
// Closed α notice is due, a page renders nothing (FR-AU-55: "in place of its
// content").
import type { Metadata } from 'next';
import { cache } from 'react';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { validateSession, type ValidSession } from '../../lib/auth/session.ts';
import { CLOSED_ALPHA_NOTICE_TITLE, onboardingDue } from '../../lib/onboarding.ts';
import { ensurePersonalWorkspace } from '../../lib/workspace.ts';
import { SIGN_IN_PATH } from '../../proxy.ts';
import { reading } from '../page-fault.ts';

export const currentAccount = cache(async (): Promise<ValidSession & { noticeDue: boolean }> => {
  // The proxy has validated the session already, but Next.js skips the proxy
  // for a request that carries the build's identifier
  // (docs/operations/deployment.md), so the pages do not rest on it. A page is
  // read, so the signed copy serves (NFR-SE-02).
  // A fault of any of the three reads below is the page of a fault, and one
  // line that holds nothing of a row (page-fault.ts).
  const sent = await headers();
  const { session } = await reading(() => validateSession('GET', sent));
  // FR-AU-07. The proxy's redirect carries the place to return to; this one
  // cannot, since a layout is not told the address it is rendered for.
  if (!session) redirect(SIGN_IN_PATH);

  // FR-AU-09: the backstop, at the account's first authenticated request.
  await reading(() => ensurePersonalWorkspace(session.userId));

  // The founding-team gate of FR-AU-83 sits here, before the notice, in the
  // slice that builds two-factor authentication (FR-AU-90: "the screen that
  // turns two-factor authentication on, with the notice after it").

  // FR-AU-55, FR-AU-56: decided on the server, from the recorded acknowledgement.
  return { ...session, noticeDue: await reading(() => onboardingDue(session.userId)) };
});

/** The title of a signed-in page, or the notice's while the notice is shown in its place. */
export async function titled(title: string): Promise<Metadata> {
  return { title: (await currentAccount()).noticeDue ? CLOSED_ALPHA_NOTICE_TITLE : title };
}
