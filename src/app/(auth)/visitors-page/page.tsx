// The page for a visitor who is not signed in (FR-AU-93; register D327 to
// D330). It is not reached at this address: the proxy marks `GET /` and
// `HEAD /` of a request without a session, which next.config.ts rewrites to
// it (src/lib/visitors.ts), and answers 404 to a request
// that names it (src/proxy.ts). It reads nothing of the request: not a cookie,
// not a header, not the query. It shows the fixed text of src/lib/visitors.ts,
// and the contact address only where `CONTACT_ADDRESS` says its mailbox exists
// (D329). It sets no cookie and holds no form (D328).
import type { Metadata } from 'next';
import Link from 'next/link';
import { PageHeading } from '@ekdotico/domico/components';
import {
  ADD_ADDRESS_LINK,
  ALREADY_INVITED,
  askLine,
  SIGN_IN_LINK,
  VISITORS_INTRO,
  VISITORS_TITLE,
  WAITING_LIST_URL,
} from '../../../lib/visitors.ts';
import { settings } from '../../../lib/settings.ts';
import styles from '../../pages.module.css';

export const metadata: Metadata = { title: VISITORS_TITLE };

// The address comes from the environment, which is read when the page is
// rendered and not when the application is built.
export const dynamic = 'force-dynamic';

export default function Visitors() {
  const { contactAddress } = settings();
  const ask = askLine(contactAddress);
  return (
    <>
      <PageHeading>{VISITORS_TITLE}</PageHeading>
      <p className={styles.text}>{VISITORS_INTRO}</p>
      <p className={styles.text}>
        {ask.before}
        {contactAddress ? <a href={`mailto:${contactAddress}`} target="_blank" rel="noopener noreferrer">{contactAddress}<span className="sr-only"> (opens in a new tab)</span></a> : null}
        {ask.after}
      </p>
      <p className={styles.text}>
        {/* The list is another site: no referrer, and no handle on this window. */}
        <a href={WAITING_LIST_URL} rel="noopener noreferrer">
          {ADD_ADDRESS_LINK}
        </a>
      </p>
      <p className={styles.text}>
        {ALREADY_INVITED}{' '}
        <Link href="/sign-in" prefetch={false}>
          {SIGN_IN_LINK}
        </Link>
      </p>
    </>
  );
}
