// Moves the expiry of the pending document invitations to an address into the
// past, in the database of the run, as 14 days would (FR-ED-37).
//
//   node tests/e2e/expire-invitation.ts <address>
import { db } from '../../src/lib/db.ts';

const [email] = process.argv.slice(2);
if (!email) throw new Error('usage: expire-invitation.ts <address>');
await db().documentInvitation.updateMany({
  where: { email, state: 'PENDING' },
  data: { expiresAt: new Date(Date.now() - 1000) },
});
await db().$disconnect();
