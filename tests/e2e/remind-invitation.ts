// Brings the expiry of the pending document invitations to an address to 2
// days ahead, in the database of the run, and runs the timer of the reminder
// once (FR-ED-48), as an hour of the real timer would 12 days into the 14.
//
//   node tests/e2e/remind-invitation.ts <address>
import { db } from '../../src/lib/db.ts';
import { remindInvitations } from '../../src/lib/documents/invitation-timers.ts';

const [email] = process.argv.slice(2);
if (!email) throw new Error('usage: remind-invitation.ts <address>');
const DAY = 24 * 60 * 60 * 1000;
await db().documentInvitation.updateMany({
  where: { email, state: 'PENDING' },
  // Created 12 days ago, as it would be 2 days before its expiry (a reminder is for one created before its moment).
  data: { createdAt: new Date(Date.now() - 12 * DAY), expiresAt: new Date(Date.now() + 2 * DAY) },
});
await remindInvitations();
await db().$disconnect();
