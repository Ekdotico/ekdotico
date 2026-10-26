// The account settings (FR-AU-03, FR-AU-83, FR-AU-85, FR-AU-88, FR-AU-90): the
// name, the address, the change of the password, two-factor authentication,
// and the list of the account's sessions with the means to end them, and the way to the
// deletion of the account (FR-AU-58). The path is this application's choice: no page of the
// specification names one.
import Link from 'next/link';
import { PageHeading, Stack } from '@ekdotico/domico/components';
import { listSessions } from '../../../lib/auth/session-list.ts';
import { ofFoundingTeam } from '../../../lib/auth/two-factor.ts';
import { db } from '../../../lib/db.ts';
import { settings } from '../../../lib/settings.ts';
import { reading } from '../../page-fault.ts';
import styles from '../../pages.module.css';
import { currentAccount, titled } from '../account.ts';
import { ChangeAddressForm } from './change-address-form.tsx';
import { ChangePasswordForm } from './change-password-form.tsx';
import { NameForm } from './name-form.tsx';
import { SessionList } from './session-list.tsx';
import { TwoFactorSettings } from './two-factor-settings.tsx';

export const generateMetadata = () => titled('Account settings');

export default async function AccountSettings() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { userId, sessionId } = await currentAccount();
  // A page is read, so the session may have been validated against its signed
  // copy (NFR-SE-02); everything this page changes goes through an endpoint
  // that reads the row.
  // A fault of either read is the page of a fault, and one line (page-fault.ts).
  const [user, sessions] = await reading(() =>
    Promise.all([
      db().user.findUnique({
        where: { id: userId },
        select: { name: true, email: true, emailVerified: true, twoFactorEnabled: true },
      }),
      listSessions(userId, sessionId),
    ]),
  );
  const { passwordMinLength, passwordMaxLength } = settings();
  // FR-AU-83: an account of the founding team "cannot turn two-factor
  // authentication off", so the control is not offered to it. Decided here,
  // from the row and the list of the process. Nor can its address be changed
  // (FR-AU-03), so that form is not offered to it either.
  const foundingTeam = user ? ofFoundingTeam(user) : false;

  return (
    <Stack gap={8}>
      <PageHeading>Account settings</PageHeading>
      <section aria-labelledby="name-heading" className={styles.narrow}>
        <Stack gap={5}>
          <h2 id="name-heading" className={styles.heading}>
            Name
          </h2>
          <NameForm name={user?.name ?? ''} />
        </Stack>
      </section>
      <section aria-labelledby="address-heading" className={styles.narrow}>
        <Stack gap={5}>
          <h2 id="address-heading" className={styles.heading}>
            Email address
          </h2>
          <ChangeAddressForm email={user?.email ?? ''} foundingTeam={foundingTeam} />
        </Stack>
      </section>
      <section aria-labelledby="password-heading" className={styles.narrow}>
        <Stack gap={5}>
          <h2 id="password-heading" className={styles.heading}>
            Password
          </h2>
          <ChangePasswordForm
            email={user?.email ?? ''}
            passwordMinLength={passwordMinLength}
            passwordMaxLength={passwordMaxLength}
          />
        </Stack>
      </section>
      <section aria-labelledby="two-factor-heading" className={styles.narrow}>
        <Stack gap={5}>
          <h2 id="two-factor-heading" className={styles.heading}>
            Two-factor authentication
          </h2>
          <TwoFactorSettings
            email={user?.email ?? ''}
            on={user?.twoFactorEnabled === true}
            foundingTeam={foundingTeam}
          />
        </Stack>
      </section>
      <section aria-labelledby="sessions-heading">
        <Stack gap={5}>
          <h2 id="sessions-heading" className={styles.heading}>
            Sessions
          </h2>
          <p className={styles.text}>
            A session is one browser in which this account is signed in. Ending a session signs that browser
            out.
          </p>
          <SessionList sessions={sessions} />
        </Stack>
      </section>
      {/* FR-AU-58: the deletion is made "from the account settings of the application"; its screen is a
          page of its own, which states what is replaced and what is kept before it asks for anything. */}
      <section aria-labelledby="delete-heading" className={styles.narrow}>
        <Stack gap={5}>
          <h2 id="delete-heading" className={styles.heading}>
            Delete account
          </h2>
          <p className={styles.text}>
            Deleting the account cannot be undone. The page for deleting it says what is replaced and what is
            kept.
          </p>
          <p className={styles.text}>
            <Link href="/settings/delete-account">Open the page for deleting the account</Link>
          </p>
        </Stack>
      </section>
    </Stack>
  );
}
