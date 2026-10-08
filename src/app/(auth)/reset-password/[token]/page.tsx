// The page the link of a password reset opens (FR-AU-86, FR-AU-88; NFR-SE-05
// (a)). The token is in the path: it is written to no log (NFR-SE-19), and the
// page loads nothing from another origin. Opening it changes nothing, so a
// program that fetches the links of an email does not spend the link.
import type { Metadata } from 'next';
import { findOpenReset } from '../../../../lib/auth/password.ts';
import { settings } from '../../../../lib/settings.ts';
import { NotValid, ResetForm } from './reset-form.tsx';

// FR-AU-81 asks `Referrer-Policy: no-referrer` of the page of a lock's link;
// FR-AU-86 is silent for this one, whose path holds a token as well. As on the
// sign-up page, the element changes nothing a person sees and keeps the token
// out of any `Referer` header.
export const metadata: Metadata = { title: 'Set a new password', referrer: 'no-referrer' };

// Never prerendered and never cached: the answer is the link's state now.
export const dynamic = 'force-dynamic';

export default async function ResetPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // One answer for a link that is spent, expired, or not known.
  const reset = await findOpenReset(token);
  if (!reset) return <NotValid />;

  const { passwordMinLength, passwordMaxLength } = settings();
  return (
    <ResetForm
      token={token}
      email={reset.email}
      passwordMinLength={passwordMinLength}
      passwordMaxLength={passwordMaxLength}
    />
  );
}
