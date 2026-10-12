'use client';

// The page of a fault (NFR-SE-06 A10): what a person is shown where a page
// could not be rendered because the database, Valkey, or the identity library
// did not answer. It stands in place of the layouts under the root one, the
// signed-in header included, so it is a whole page: the product's name, a
// heading, and the one fixed statement of a fault, which is the proxy's for a
// 500. Nothing of the error is logged here, and nothing of it is shown but
// its reference: its message is not the application's to show
// (src/app/page-fault.ts).
import { FormFault, Logo, PageHeading, Stack } from '@ekdotico/domico/components';
import { INTERNAL_FAULT } from '../lib/http.ts';
import styles from './pages.module.css';

// The requirements give no words for the reference. Written under the
// Expression Guidelines; the owner approves them with the pull request.
const QUOTE = 'Quote this reference when you report the fault.';
const REFERENCE = 'Reference:';

/**
 * The reference of a fault of the server (the owner's decision of 12 October
 * 2026): the digest Next.js gives the error of a server component in a
 * production build, which it prints with that error in the server's log. It
 * is a number made from the message and the stack of the error, so it names
 * the place of a fault and holds nothing of it. A fault of the browser has
 * none. Only a digest of that form is shown: the field is whatever was
 * thrown, and anything else could be a message.
 */
export const faultReference = (error: unknown): string | null => {
  const digest = (error as { digest?: unknown } | null | undefined)?.digest;
  return typeof digest === 'string' && /^[0-9]{1,10}$/.test(digest) ? digest : null;
};

export default function PageFault({ error }: { error?: unknown }) {
  const reference = faultReference(error);
  return (
    <main className={styles.column}>
      <Stack gap={6}>
        <Logo />
        <PageHeading>Page not shown</PageHeading>
        {/* The package's statement of a fault: announced by a screen reader, and
            given focus (WCAG 2.2, 4.1.3). It answers a page the person asked
            for, and nothing they used is left on it for focus to stay on. The
            reference is text in it: read with it, and there to select. */}
        <FormFault title={INTERNAL_FAULT}>
          {reference ? (
            <>
              <p>{QUOTE}</p>
              <p>
                {REFERENCE} {reference}
              </p>
            </>
          ) : null}
        </FormFault>
      </Stack>
    </main>
  );
}
