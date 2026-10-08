// Every address that is no page of the application. It stands under the
// signed-in layout so that such an address shows the Closed α notice like any
// other until the notice is acknowledged (FR-AU-55: "every page of the
// application the account opens"), and the statement of not-found.tsx after.
import { notFound } from 'next/navigation';
import { currentAccount, titled } from '../account.ts';

export const generateMetadata = () => titled('Page not found');

export default async function NoSuchPage() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  notFound();
}
