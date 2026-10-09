// What a signed-in account is shown at an address that is no page. The words
// are the application's own, since the framework's are not written under the
// Expression Guidelines.
import Link from 'next/link';
import { PageHeading, Stack } from '@ekdotico/domico/components';
import styles from '../pages.module.css';

export default function NotFound() {
  return (
    <Stack gap={4}>
      <PageHeading>Page not found</PageHeading>
      <p className={styles.text}>
        No page of Ekdotico has this address. Check the address, or open the{' '}
        <Link href="/">list of documents</Link>.
      </p>
    </Stack>
  );
}
