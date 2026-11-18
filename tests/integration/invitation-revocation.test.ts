// The loss of the right to invite revokes the sender's pending invitations (FR-ED-37; D300; register Q82
// point 5; docs@da33e58): every cause the requirement names, each in the transaction of the change that ends
// the right. Each test names the weakening that makes it fail: a cause that does not call
// `revokeInvitationsOfLostRight` leaves the invitation pending, and a revocation that ignores the permission
// set revokes the invitation of a sender who still holds the right (the last test).
import { HELD } from './guard.ts';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('invitation_revocation', { RATE_LIMIT_INVITATIONS_PER_USER: '1000/3600' });
const { auth, db, valkey } = await load();
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const { changePermissionSet } = await import('../../src/lib/documents/permission-settings.ts');
const { removeCollaborator, changeRole, leaveDocument } =
  await import('../../src/lib/documents/collaborators.ts');
const { answerOffer, makeOffer } = await import('../../src/lib/documents/ownership.ts');

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

let count = 0;
async function person() {
  const email = `revoke${++count}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)), origin: ORIGIN };
}
type Person = Awaited<ReturnType<typeof person>>;

/** An Owner and an Editor on one document, where Editors may invite (FR-ED-45), and the row of the Editor. */
async function setting() {
  const owner = await person();
  const editor = await person();
  const id = (await createDocument(owner.id)).id;
  const set = defaultPermissionSet();
  set['document.collaborators.invite'].editor = true;
  await db().document.update({ where: { id }, data: { permissionSet: set } });
  const row = await db().documentCollaborator.create({
    data: { documentId: id, userId: editor.id, role: 'EDITOR' },
  });
  return { owner, editor, id, row: row.id };
}

/** A pending invitation of this sender, with its notification. */
async function pendingFrom(documentId: string, sender: Person) {
  const invitation = await db().documentInvitation.create({
    data: {
      documentId,
      invitedById: sender.id,
      role: 'VIEWER',
      email: `to${randomUUID()}@example.com`,
      tokenHash: randomUUID(),
      expiresAt: new Date(Date.now() + 14 * 86_400_000),
      emailClaimedAt: new Date(),
    },
  });
  await db().notification.create({
    data: { recipientId: sender.id, kind: 'document_invitation', payload: { invitationId: invitation.id } },
  });
  return invitation.id;
}
const stateOf = async (id: string) =>
  (await db().documentInvitation.findUniqueOrThrow({ where: { id } })).state;
const notified = (id: string) =>
  db().notification.count({
    where: { kind: 'document_invitation', payload: { path: ['invitationId'], equals: id } },
  });

describe('the loss of the right to invite revokes the sender’s pending invitations (FR-ED-37, D300)', () => {
  it('revokes them when the sender’s role is lowered to one without the permission', async () => {
    const { owner, editor, id, row } = await setting();
    const theirs = await pendingFrom(id, editor);
    const ownersOwn = await pendingFrom(id, owner);
    expect((await changeRole(id, owner.id, row, 'viewer')).outcome).toBe('changed');
    expect(await stateOf(theirs)).toBe('REVOKED');
    expect(await notified(theirs)).toBe(0);
    expect(await stateOf(ownersOwn)).toBe('PENDING');
  });

  it('revokes them when the sender is removed', async () => {
    const { owner, editor, id, row } = await setting();
    const theirs = await pendingFrom(id, editor);
    expect((await removeCollaborator(id, owner.id, row)).outcome).toBe('removed');
    expect(await stateOf(theirs)).toBe('REVOKED');
  });

  it('revokes them when the sender leaves', async () => {
    const { editor, id } = await setting();
    const theirs = await pendingFrom(id, editor);
    expect((await leaveDocument(id, editor.id)).outcome).toBe('left');
    expect(await stateOf(theirs)).toBe('REVOKED');
  });

  it('revokes them when the Owner changes the permission set so that the sender’s role cannot invite', async () => {
    const { owner, editor, id } = await setting();
    const theirs = await pendingFrom(id, editor);
    const result = await changePermissionSet(id, owner.id, {
      kind: 'changes',
      cells: [{ permission: 'document.collaborators.invite', role: 'editor', allowed: false }],
    });
    expect(result.outcome).toBe('changed');
    expect(await stateOf(theirs)).toBe('REVOKED');
  });

  it('revokes the former Owner’s when the transfer makes it an Editor who may not invite', async () => {
    const { owner, editor, id, row } = await setting();
    await db().document.update({ where: { id }, data: { permissionSet: defaultPermissionSet() } });
    const theirs = await pendingFrom(id, owner);
    const offered = await makeOffer(id, owner.id, row, undefined, HELD);
    if (offered.outcome !== 'offered') throw new Error(`not offered: ${offered.outcome}`);
    expect((await answerOffer(editor.id, offered.offer.id, 'accept')).outcome).toBe('accepted');
    expect(await stateOf(theirs)).toBe('REVOKED');
  });

  it('leaves the invitations of a sender who still holds the right', async () => {
    const { owner, editor, id, row } = await setting();
    const other = await person();
    await db().documentCollaborator.create({ data: { documentId: id, userId: other.id, role: 'VIEWER' } });
    const theirs = await pendingFrom(id, editor);
    // A change that does not touch the Editor's right: the Editor stays pending.
    await changePermissionSet(id, owner.id, {
      kind: 'changes',
      cells: [{ permission: 'document.export.draft', role: 'viewer', allowed: true }],
    });
    expect(await stateOf(theirs)).toBe('PENDING');
    // The transfer keeps the former Owner's where Editors may invite.
    const ownersOwn = await pendingFrom(id, owner);
    const offered = await makeOffer(id, owner.id, row, undefined, HELD);
    if (offered.outcome !== 'offered') throw new Error(`not offered: ${offered.outcome}`);
    await answerOffer(editor.id, offered.offer.id, 'accept');
    expect(await stateOf(ownersOwn)).toBe('PENDING');
  });
});
