// The sign-in page (FR-AU-81, FR-AU-88). It offers sign-up to no one
// (FR-AU-57), and leads to the page that asks for a password reset (FR-AU-86).
import type { Metadata } from 'next';
import { headers } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { validateSession } from '../../../lib/auth/session.ts';
import { returnPath } from '../../../lib/http.ts';
import { RETURN_PARAMETER } from '../../../proxy.ts';
import styles from '../../pages.module.css';
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
  const { session } = await validateSession('GET', await headers());
  if (session) redirect(returnTo);

  return (
    <>
      <h1 className={styles.title}>Sign in</h1>
      <SignInForm returnTo={returnTo} />
      {/* FR-AU-86. The words are those the email of the account uses for it:
          "set a new password from the sign-in page" (FR-AU-87 (d)). Not
          fetched ahead: each request to these pages is counted (NFR-SE-07). */}
      <p className={styles.text}>
        <Link href="/reset-password" prefetch={false}>
          Set a new password
        </Link>
      </p>
    </>
  );
}
