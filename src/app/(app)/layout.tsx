// The signed-in pages. Either the Closed α notice, alone, or a header and the
// page (FR-AU-55). The header is the product's name and the way to sign out:
// navigation joins it with the pages it leads to.
import { SkipLink } from '@ekdotico/domico/components';
import {
  CLOSED_ALPHA_NOTICE_BODY,
  CLOSED_ALPHA_NOTICE_TITLE,
  CLOSED_ALPHA_NOTICE_VERSION,
} from '../../lib/onboarding.ts';
import styles from '../pages.module.css';
import { currentAccount } from './account.ts';
import { ClosedAlphaNotice } from './closed-alpha-notice.tsx';
import { ShellHeader } from './shell-header.tsx';

// Every page here is rendered for one account, at the time it is asked for.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { noticeDue } = await currentAccount();
  if (noticeDue) {
    // In place of the page and of the header: nothing else is on the screen,
    // so focus has nowhere else to go (FR-AU-56).
    return (
      <ClosedAlphaNotice
        title={CLOSED_ALPHA_NOTICE_TITLE}
        body={CLOSED_ALPHA_NOTICE_BODY}
        version={CLOSED_ALPHA_NOTICE_VERSION}
      />
    );
  }
  return (
    <>
      <SkipLink />
      <ShellHeader />
      <main id="main-content" className={styles.page}>
        {children}
      </main>
    </>
  );
}
