// The sign-up address without a token (FR-AU-90; NFR-SE-05 (a)): "without a
// token ... it creates nothing and shows the fixed statement". By the owner's
// decision of 8 October 2026 the path is on the proxy's list of paths without
// a session, so that the statement is what a person sees and not the sign-in
// page. It reads nothing, and so shows the same to everyone.
import type { Metadata } from 'next';
import { NotOpen } from './[token]/sign-up-form.tsx';

export const metadata: Metadata = { title: 'Create account' };

export default function SignUpWithoutToken() {
  return <NotOpen />;
}
