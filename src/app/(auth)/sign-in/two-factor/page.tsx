// The page of the second step of a sign-in (FR-AU-81, FR-AU-83, FR-AU-88):
// "the password is followed by the second step …, and the session begins only
// after it". A person without a session opens it, sent on by the sign-in page;
// what authorises the step is the cookie the password left, which the endpoint
// reads, so the page itself reads nothing and changes nothing. The path is
// this application's choice: no page of the specification names one.
import type { Metadata } from 'next';
import { PageHeading } from '@ekdotico/domico/components';
import { returnPath } from '../../../../lib/http.ts';
import { RETURN_PARAMETER } from '../../../../proxy.ts';
import { SecondStepForm } from './second-step-form.tsx';

export const metadata: Metadata = { title: 'Enter the code' };

export default async function SecondStep({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // FR-AU-07: returned to the page that was asked for, and only ever to a path of this origin.
  const asked = (await searchParams)[RETURN_PARAMETER];
  const returnTo = returnPath(typeof asked === 'string' ? asked : null);
  return (
    <>
      <PageHeading>Enter the code</PageHeading>
      <SecondStepForm returnTo={returnTo} />
    </>
  );
}
