// The first screen after sign-in. The list of documents takes its place in the
// slice that builds documents; until then the page says where things stand and
// promises nothing.
import { Stack } from '@ekdotico/domico/components';
import styles from '../pages.module.css';
import { currentAccount, titled } from './account.ts';

export const generateMetadata = () => titled('Signed in');

export default async function Home() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  return (
    <Stack gap={4}>
      <h1 className={styles.title}>Signed in</h1>
      <p className={styles.text}>
        This account is signed in, and documents are planned for a later version of this release.
      </p>
    </Stack>
  );
}
