// The page the link of a changed address opens (FR-AU-03, FR-AU-88;
// NFR-SE-05 (a)). By the owner's answer to Q3 of the plan it is "as the lock
// link: a page with one control": opening it changes nothing, so a program
// that fetches the links of an email confirms nothing, and the change is made
// by the control. The token is in the path: it is written to no log
// (NFR-SE-19), the page loads nothing from another origin, and it is served
// with `Referrer-Policy: no-referrer` (next.config.ts).
import type { Metadata } from 'next';
import { findOpenAddressChange } from '../../../../lib/auth/name-and-address.ts';
import { reading } from '../../../page-fault.ts';
import { ConfirmForm, NotValid } from './confirm-form.tsx';

// The header is the rule; the element says the same and changes nothing a person sees.
export const metadata: Metadata = { title: 'Confirm the new email address', referrer: 'no-referrer' };

// Never prerendered and never cached: the answer is the link's state now.
export const dynamic = 'force-dynamic';

export default async function ConfirmAddressPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // One answer for a link that is spent, void, expired, or not known, and for
  // a change that can no longer be made. A fault of the read is the page of a
  // fault, and never that answer (page-fault.ts).
  const change = await reading(() => findOpenAddressChange(token));
  if (!change) return <NotValid />;
  // The new address and nothing else of the account: whoever holds the link
  // holds the mailbox it was sent to, and may be no one the account knows.
  return <ConfirmForm token={token} newEmail={change.newEmail} />;
}
