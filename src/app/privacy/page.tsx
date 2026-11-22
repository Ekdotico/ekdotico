// The privacy notice (FR-AU-72; owner's answers of 21 November 2026, fw-privacy-page): a page of the application at
// `/privacy`, readable without signing in. It is on the proxy's list of paths without a session (src/proxy.ts,
// group (a)), so the proxy takes no session for it, and it reads nothing of the request: not a cookie, not a header,
// not the query. It shows nothing of the visitor and answers the same signed in or out. It is not under the
// signed-in layout, so the Closed α notice of FR-AU-55 never stands in place of it: it can be read while that
// notice is due. The words are src/lib/privacy-notice.ts; the contact address is `CONTACT_ADDRESS`, and the last
// section is left out while that is unset.
import type { Metadata } from 'next';
import { PageHeading, Stack } from '@ekdotico/domico/components';
import { PRIVACY_CONTACT_HEADING, PRIVACY_SECTIONS, PRIVACY_TITLE } from '../../lib/privacy-notice.ts';
import { settings } from '../../lib/settings.ts';
import styles from '../pages.module.css';

export const metadata: Metadata = { title: PRIVACY_TITLE };

// The address comes from the environment, which is read when the page is rendered and not when the application is
// built.
export const dynamic = 'force-dynamic';

/** The serif has no Greek: the α is set in the sans, and the text is otherwise as written. */
function withGreek(text: string) {
  return text.split('α').flatMap((part, index) =>
    index === 0
      ? [part]
      : [
          <span key={index} className={styles.greek}>
            α
          </span>,
          part,
        ],
  );
}

/** The address as a mailto target: its local part encoded, so that a `?`, `&` or `#` in it cannot add a field (a cc, a body). */
function mailtoOf(address: string): string {
  const at = address.lastIndexOf('@');
  return `${encodeURIComponent(address.slice(0, at))}${address.slice(at)}`;
}

export default function Privacy() {
  const { contactAddress } = settings();
  return (
    <main className={styles.prose}>
      <Stack gap={5}>
        <PageHeading>{PRIVACY_TITLE}</PageHeading>
        {PRIVACY_SECTIONS.map(({ heading, text }) => (
          <section key={heading}>
            <Stack gap={2}>
              <h2 className={styles.heading}>{heading}</h2>
              <p className={styles.reading}>{withGreek(text)}</p>
            </Stack>
          </section>
        ))}
        {contactAddress ? (
          <section>
            <Stack gap={2}>
              <h2 className={styles.heading}>{PRIVACY_CONTACT_HEADING}</h2>
              <p className={styles.reading}>
                <a href={`mailto:${mailtoOf(contactAddress)}`}>{contactAddress}</a>
              </p>
            </Stack>
          </section>
        ) : null}
      </Stack>
    </main>
  );
}
