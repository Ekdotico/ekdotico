// The pages a person without a session opens (FR-AU-88; NFR-SE-05 (a)): one
// column, the product's name, and the page. No navigation, no link to sign up
// (FR-AU-57), and nothing from another origin.
import { Logo, Stack } from '@ekdotico/domico/components';
import styles from '../pages.module.css';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className={styles.column}>
      <Stack gap={6}>
        <Logo />
        {children}
      </Stack>
    </main>
  );
}
