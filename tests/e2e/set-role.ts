// Changes the role of a collaborator on a document in the database of the run,
// with no route (FR-ED-40 (b)). It publishes nothing: the collaboration server
// learns of it by its re-check (FR-ED-41), which is what the tests that use it
// are about. A change made from the screen, and its notice, are the tests of
// slice 15 (tests/e2e/editor.spec.ts, "a change acts on an open page").
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
