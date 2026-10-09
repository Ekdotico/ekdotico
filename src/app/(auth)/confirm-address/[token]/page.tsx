// The page the link of a changed address opens (FR-AU-03, FR-AU-88;
// NFR-SE-05 (a)). By the owner's answer to Q3 of the plan it is "as the lock
// link: a page with one control": opening it changes nothing, so a program
// that fetches the links of an email confirms nothing, and the change is made
// by the control. The token is in the path: it is written to no log
// (NFR-SE-19), the page loads nothing from another origin, and it is served
// with `Referrer-Policy: no-referrer` (next.config.ts).
//
// The owner's decision of 9 October 2026 (its register row is pending): the
// change is confirmed only under a session of the account that asked for it.
// The page opens without a session, since the email may be read on a device
// that is not signed in, and it then shows one statement and a way to the
// sign-in page: nothing of the link, of whether it is valid, or of the
// address. The token is put into no address the browser is sent to.
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { findOpenAddressChange } from '../../../../lib/auth/name-and-address.ts';
import { validateSession } from '../../../../lib/auth/session.ts';
import { reading } from '../../../page-fault.ts';
import { ConfirmForm, NotValid, SignInFirst } from './confirm-form.tsx';

// The header is the rule; the element says the same and changes nothing a person sees.
export const metadata: Metadata = { title: 'Confirm the new email address', referrer: 'no-referrer' };

// Never prerendered and never cached: the answer is the link's state now.
export const dynamic = 'force-dynamic';

export default async function ConfirmAddressPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // A read, so the signed copy serves (NFR-SE-02); the control's own request
  // reads the row. Without a session the link is not looked at.
  const sent = await headers();
  const { session, stopped } = await reading(() => validateSession('GET', sent));
  const held = session ?? stopped;
  if (!held) return <SignInFirst />;
  // One answer for a link that is spent, void, expired, or not known, for a
  // change that can no longer be made, and for the link of a change that
  // another account asked for. A fault of the read is the page of a fault,
  // and never that answer (page-fault.ts).
  const change = await reading(() => findOpenAddressChange(token));
  if (!change || change.userId !== held.userId) return <NotValid />;
  return <ConfirmForm token={token} newEmail={change.newEmail} />;
}
