// The signed-in pages. The screen that turns two-factor authentication on,
// alone (FR-AU-83); or the Closed α notice, alone (FR-AU-55); or a header and
// the page. The header is the product's name and the way to sign out:
// navigation joins it with the pages it leads to.
import { SkipLink } from '@ekdotico/domico/components';
import { db } from '../../lib/db.ts';
import {
  CLOSED_ALPHA_NOTICE_BODY,
  CLOSED_ALPHA_NOTICE_TITLE,
  CLOSED_ALPHA_NOTICE_VERSION,
} from '../../lib/closed-alpha-notice.ts';
import { reading } from '../page-fault.ts';
import styles from '../pages.module.css';
import { currentAccount, ENROLMENT_TITLE } from './account.ts';
import { ClosedAlphaNotice } from './closed-alpha-notice.tsx';
import { EnrolmentGate } from './enrolment-gate.tsx';
import { ShellHeader } from './shell-header.tsx';

// Every page here is rendered for one account, at the time it is asked for.
export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId, enrolmentDue, noticeDue } = await currentAccount();
  if (enrolmentDue) {
    // FR-AU-83: "every page it opens shows the screen that turns two-factor
    // authentication on, in place of its content, with only the means to sign
    // out beside it". Before the notice (FR-AU-90). The address is shown in
    // the form, for a password manager (FR-AU-88).
    const user = await reading(() =>
      db().user.findUnique({ where: { id: userId }, select: { email: true } }),
    );
    return <EnrolmentGate title={ENROLMENT_TITLE} email={user?.email ?? ''} />;
  }
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
