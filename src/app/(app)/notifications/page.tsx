// FR-ED-42: the notification list of the account, reachable from the header of
// every signed-in page. The address is the application's choice.
import { ROLE_NAME } from '../../../lib/documents/permissions.ts';
import { listNotifications } from '../../../lib/documents/sharing.ts';
import { reading } from '../../page-fault.ts';
import { currentAccount, titled } from '../account.ts';
import { NotificationList, type NotificationItem } from './notification-list.tsx';

export const generateMetadata = () => titled('Notifications');

export default async function Notifications() {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  // The list is the session's own account's: nothing of the request chooses whose.
  const { userId } = await currentAccount();
  const { notifications } = await reading(() => listNotifications(userId));
  return (
    <NotificationList
      notifications={notifications.map((notification): NotificationItem => {
        const createdAt = notification.createdAt.toISOString();
        // A removal, an offer and the end of an offer name no role; the others name the one in words.
        if (
          notification.kind === 'removed' ||
          notification.kind === 'ownership_offer' ||
          notification.kind === 'ownership_offer_ended'
        ) {
          return { ...notification, createdAt };
        }
        if (notification.kind === 'clearing_notice') {
          return { ...notification, createdAt, deleteOn: notification.deleteOn.toISOString() };
        }
        if (notification.kind === 'clearing_cancelled' || notification.kind === 'clearing_deleted') {
          return { ...notification, createdAt };
        }
        if (notification.kind === 'document_invitation_reminder') {
          return {
            ...notification,
            role: ROLE_NAME[notification.role],
            createdAt,
            expiresAt: notification.expiresAt?.toISOString() ?? null,
          };
        }
        return { ...notification, role: ROLE_NAME[notification.role], createdAt };
      })}
    />
  );
}
