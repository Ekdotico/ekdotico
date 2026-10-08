'use client';

// The page of a fault (NFR-SE-06 A10): what a person is shown where a page
// could not be rendered because the database, Valkey, or the identity library
// did not answer. It stands in place of the layouts under the root one, the
// signed-in header included, so it is a whole page: the product's name, a
// heading, and the one fixed statement of a fault, which is the proxy's for a
// 500. Nothing of the error is shown or logged here: its message is not the
// application's to show (src/app/page-fault.ts).
import { FormFault, Logo, Stack } from '@ekdotico/domico/components';
import { INTERNAL_FAULT } from '../lib/http.ts';
import styles from './pages.module.css';

export default function PageFault() {
  return (
    <main className={styles.column}>
      <Stack gap={6}>
        <Logo />
        <h1 className={styles.title}>Page not shown</h1>
        {/* The package's statement of a fault: announced by a screen reader, and given focus (WCAG 2.2, 4.1.3). */}
        <FormFault title={INTERNAL_FAULT} />
      </Stack>
    </main>
  );
}
