// The page on which a person who cannot sign in asks for a password reset
// (FR-AU-86, FR-AU-88; NFR-SE-05 (a)). It needs no session and loads nothing
// from another origin.
import type { Metadata } from 'next';
import { PageHeading } from '@ekdotico/domico/components';
import { ResetRequestForm } from './reset-request-form.tsx';

export const metadata: Metadata = { title: 'Set new password' };

export default function ResetRequest() {
  return (
    <>
      <PageHeading>Set new password</PageHeading>
      <ResetRequestForm />
    </>
  );
}
