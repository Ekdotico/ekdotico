// The page the link of an admission invitation opens (FR-AU-90, FR-AU-88;
// NFR-SE-05 (a)). The token is in the path: it is written to no log
// (NFR-SE-19), and the page loads nothing from another origin.
import type { Metadata } from 'next';
import { findOpenInvitation } from '../../../../lib/admission/invitations.ts';
import { settings } from '../../../../lib/settings.ts';
import { reading } from '../../../page-fault.ts';
import { NotOpen, SignUp } from './sign-up-form.tsx';

// FR-AU-81 asks `Referrer-Policy: no-referrer` of the page of a lock's link;
// FR-AU-90 is silent for this one, whose path holds a token as well. The
// element changes nothing a person sees and keeps the token out of any
// `Referer` header.
export const metadata: Metadata = { title: 'Create account', referrer: 'no-referrer' };

// Never prerendered and never cached: the answer is the invitation's state now.
export const dynamic = 'force-dynamic';

export default async function SignUpPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // One answer for an invitation that is accepted, revoked, expired, or not
  // known, so that the page does not show which (FR-AU-90). A fault of the
  // read is the page of a fault, and never that answer (page-fault.ts).
  const invitation = await reading(() => findOpenInvitation(token));
  if (!invitation) return <NotOpen />;

  const { passwordMinLength, passwordMaxLength } = settings();
  return (
    <SignUp
      token={token}
      email={invitation.email}
      passwordMinLength={passwordMinLength}
      passwordMaxLength={passwordMaxLength}
    />
  );
}
