// The sharing settings of a document (FR-ED-21, FR-ED-37, FR-ED-38; the
// address is the application's choice). Authorised as every request about a
// document is, by `authorise` (NFR-SE-04, FR-ED-39), for `document.view`,
// which every role holds; what it shows of the people and of the invitations
// is `sharingOf`'s, by the caller's role, and which controls it offers are the
// rules of FR-ED-44 (b), which the routes ask again.
import { notFound } from 'next/navigation';
import { authorise } from '../../../../../lib/documents/access.ts';
import { mayAct, refusalOn } from '../../../../../lib/documents/collaborator-rules.ts';
import { openOfferOf } from '../../../../../lib/documents/ownership.ts';
import { holds, ROLE_NAME } from '../../../../../lib/documents/permissions.ts';
import { settings } from '../../../../../lib/settings.ts';
import { sharingOf } from '../../../../../lib/documents/sharing.ts';
import { reading } from '../../../../page-fault.ts';
import styles from '../../../../pages.module.css';
import { currentAccount, titled } from '../../../account.ts';
import { Stack } from '@ekdotico/domico/components';
import { LeaveDocument } from './collaborator-actions.tsx';
import { PermissionSettings } from './permission-settings.tsx';
import { permissionRows, RoleSummary } from './permission-rows.tsx';
import { SharingSettings } from './sharing-settings.tsx';
import { TransferOwnership } from './transfer-ownership.tsx';

export const generateMetadata = () => titled('Sharing');

// Text for a person (plan Q6): a role whose permission set hides the people.
const NOT_SHOWN =
  'The role of this account on the document does not show its people. The Owner of the document can change that.';

export default async function Sharing({ params }: { params: Promise<{ id: string }> }) {
  if ((await currentAccount()).noticeDue) return null; // FR-AU-55: see account.ts
  const { userId } = await currentAccount();
  const { id } = await params;
  const access = await reading(() => authorise(userId, id, 'document.view'));
  // `document.view` is held by every role (FR-ED-44), so there is no 403 here.
  if (access.outcome !== 'allowed') notFound();
  const { document, role } = access;
  // FR-AU-91 (owner's answer to S23-1): a deleted document in its notice period is opened to be read, and nothing here
  // can be done to it: this page of settings is not one of its pages.
  if (document.deletedAt !== null) notFound();
  // FR-ED-38: the Owner cannot leave; every other role may, whatever the permission set shows of the people.
  const mayLeave = holds(document.permissionSet, role, 'document.leave');
  // FR-ED-46: the Owner sees the table of the set; any other role is told in words what it holds and
  // may do, with no control over the set. Whatever the set shows of the people.
  const permissions =
    role === 'owner' ? (
      <PermissionSettings documentId={document.id} rows={permissionRows(document.permissionSet)} />
    ) : (
      <RoleSummary stored={document.permissionSet} role={role} />
    );
  if (!holds(document.permissionSet, role, 'document.collaborators.view')) {
    return (
      <Stack gap={6}>
        <p className={styles.text}>{NOT_SHOWN}</p>
        {permissions}
        {mayLeave ? <LeaveDocument documentId={document.id} /> : null}
      </Stack>
    );
  }
  const sharing = await reading(() => sharingOf(document, role, userId));
  // FR-ED-47: the Owner alone is offered the transfer (`document.ownership.transfer` is fixed to the
  // Owner); the server asks again, under the lock. The Editors are those the people list holds.
  const open = role === 'owner' ? await reading(() => openOfferOf(document.id)) : null;
  const transfer =
    role === 'owner' ? (
      <TransferOwnership
        documentId={document.id}
        editors={sharing.collaborators.filter(({ role: held }) => held === 'editor')}
        offer={open ? { toName: open.toName, expiresAt: open.expiresAt.toISOString() } : null}
        days={settings().ownershipOfferDays}
      />
    ) : null;
  const roles = mayAct(document.permissionSet, role, 'roles');
  const remove = mayAct(document.permissionSet, role, 'remove');
  return (
    <SharingSettings
      // FR-ED-46: the screen of the permission set is part of the sharing settings.
      section={
        <>
          {permissions}
          {transfer}
        </>
      }
      view={{
        documentId: document.id,
        people: sharing.people,
        limit: sharing.limit,
        owner: sharing.owner.name,
        collaborators: sharing.collaborators.map(({ role: held, self, ...one }) => {
          // The Owner has no row, so a collaborator is never the Owner (FR-ED-19); where one were, nothing is offered on it.
          const refused = held === 'owner' || refusalOn(role, { role: held, self }) !== null;
          return {
            ...one,
            role: ROLE_NAME[held],
            roleValue: held,
            mayChangeRole: roles && !refused,
            mayRemove: remove && !refused,
          };
        }),
        mayLeave,
        invitations: sharing.invitations?.map((one) => ({
          ...one,
          role: ROLE_NAME[one.role],
          // NFR-I18-06: sent in UTC; the browser shows it in its own zone.
          expiresAt: one.expiresAt.toISOString(),
        })),
      }}
    />
  );
}
