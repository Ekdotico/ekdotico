// Changes the role of a collaborator on a document in the database of the run,
// as the route that changes a role will (FR-ED-40 (b); slice 15). It publishes
// nothing: the collaboration server learns of it by its re-check (FR-ED-41).
//
//   node tests/e2e/set-role.ts <document> <address> <editor|reviewer|viewer>
import { db } from '../../src/lib/db.ts';

const [documentId, email, role] = process.argv.slice(2);
if (!documentId || !email || !['editor', 'reviewer', 'viewer'].includes(role ?? '')) {
  throw new Error('usage: set-role.ts <document> <address> <editor|reviewer|viewer>');
}
const user = await db().user.findUniqueOrThrow({ where: { email }, select: { id: true } });
await db().documentCollaborator.update({
  where: { documentId_userId: { documentId, userId: user.id } },
  data: { role: role!.toUpperCase() as 'EDITOR' | 'REVIEWER' | 'VIEWER', roleSince: new Date() },
});
await db().$disconnect();
