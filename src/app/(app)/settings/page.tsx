// The account settings (FR-AU-85, FR-AU-88): the change of the password, and
// the list of the account's sessions with the means to end them. The name, the
// address, two-factor authentication and the deletion join it with the slices
// that build them. The path is this application's choice: no page of the
// specification names one.
import { PageHeading, Stack } from '@ekdotico/domico/components';
import { listSessions } from '../../../lib/auth/session-list.ts';
import { db } from '../../../lib/db.ts';
import { settings } from '../../../lib/settings.ts';
import { reading } from '../../page-fault.ts';
import styles from '../../pages.module.css';
import { currentAccount, titled } from '../account.ts';
import { ChangePasswordForm } from './change-password-form.tsx';
import { SessionList } from './session-list.tsx';

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
      db().user.findUnique({ where: { id: userId }, select: { email: true } }),
      listSessions(userId, sessionId),
    ]),
  );
  const { passwordMinLength, passwordMaxLength } = settings();

  return (
    <Stack gap={8}>
      <PageHeading>Account settings</PageHeading>
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
    </Stack>
  );
}
