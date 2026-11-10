// A document for an account that cannot make one through the application: an
// account of the founding team that has not turned two-factor authentication
// on reaches no route (FR-AU-83), so the test of what its pages hold writes the
// document here, by the application's own functions, into the database of the
// run. Prints the identifier.
//
//   node tests/e2e/own-document.ts <email> <title>
import { db } from '../../src/lib/db.ts';
import { createDocument, renameDocument } from '../../src/lib/documents/documents.ts';

const [email, title] = process.argv.slice(2);
const user = await db().user.findUnique({ where: { email }, select: { id: true } });
if (!user || !title) throw new Error('usage: own-document.ts <email of an account> <title>');
const { id } = await createDocument(user.id);
await renameDocument(id, title, user.id);
console.log(id);
await db().$disconnect();
