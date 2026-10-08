// The sign-in page (FR-AU-81, FR-AU-88). It offers sign-up to no one
// (FR-AU-57). The link to a password reset joins it with the reset page
// (FR-AU-86), which is a later slice.
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { PageHeading } from '@ekdotico/domico/components';
import { validateSession } from '../../../lib/auth/session.ts';
import { returnPath } from '../../../lib/http.ts';
import { RETURN_PARAMETER } from '../../../proxy.ts';
import { reading } from '../../page-fault.ts';
import { SignInForm } from './sign-in-form.tsx';

export const metadata: Metadata = { title: 'Sign in' };

export default async function SignIn({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // FR-AU-07: after signing in, a person is returned to the page they asked
  // for, and only ever to a path of this origin.
  const asked = (await searchParams)[RETURN_PARAMETER];
  const returnTo = returnPath(typeof asked === 'string' ? asked : null);

  // A browser that already holds a session has nothing to do here: it is sent
  // on to where it was going. A read, so the signed copy serves (NFR-SE-02).
  // A fault of it is the page of a fault (page-fault.ts).
  const sent = await headers();
  const { session } = await reading(() => validateSession('GET', sent));
  if (session) redirect(returnTo);

  return (
    <>
      <PageHeading>Sign in</PageHeading>
      <SignInForm returnTo={returnTo} />
    </>
  );
}
