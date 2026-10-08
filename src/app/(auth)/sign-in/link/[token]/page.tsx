// The page the sign-in link of a lock email opens (FR-AU-81, FR-AU-88;
// NFR-SE-05 (a); register D115; A104, assumed). It "names the email address
// that will be signed in and carries one control; opening the page alone
// changes nothing", so a program that fetches the links of an email neither
// spends the link nor signs anyone in. The token is in the path: it is written
// to no log (NFR-SE-19), the page loads nothing from another origin, and it is
// served with `Referrer-Policy: no-referrer` (next.config.ts).
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { validateSession } from '../../../../../lib/auth/session.ts';
import { findOpenSignInLink } from '../../../../../lib/auth/sign-in-lock.ts';
import { reading } from '../../../../page-fault.ts';
import { LinkForm, NotValid } from './link-form.tsx';

// The header is the rule; the element says the same and changes nothing a person sees.
export const metadata: Metadata = { title: 'Sign in', referrer: 'no-referrer' };

// Never prerendered and never cached: the answer is the link's state now.
export const dynamic = 'force-dynamic';

export default async function SignInLinkPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  // One answer for a link that is spent, void, or not known. A fault of the
  // read is the page of a fault, and never that answer (page-fault.ts).
  const link = await reading(() => findOpenSignInLink(token));
  if (!link) return <NotValid />;

  // "Where the browser already holds a session of another account, the page
  // says so." A read, so the signed copy serves (NFR-SE-02); nothing is said
  // of whose the session is.
  const sent = await headers();
  const { session, stopped } = await reading(() => validateSession('GET', sent));
  const held = session ?? stopped;
  return <LinkForm token={token} email={link.email} otherAccount={!!held && held.userId !== link.userId} />;
}
