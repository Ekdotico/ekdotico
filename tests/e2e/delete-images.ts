// Deletes the rows of the images of a document in the database of the run, as the
// timer does 30 days after they left it (src/lib/images/deletion.ts), so that a
// block of the document shows that its image is no longer available (the owner's
// answer to Q14). The objects stay where they are: only the rows decide whether a
// link is issued.
//
//   node tests/e2e/delete-images.ts <document>
import { db } from '../../src/lib/db.ts';

const [documentId] = process.argv.slice(2);
if (!documentId) throw new Error('usage: delete-images.ts <document>');
const { count } = await db().documentImage.deleteMany({ where: { documentId } });
console.log(count);
await db().$disconnect();
