// Deletes the objects of the images of a document from the object store of the run, and leaves their rows, so that
// the document still names images that the store cannot give: the case the Markdown draft export aborts a download
// for (FR-EX-36, "where an image cannot be read once the response has begun"). It uses the application's own
// store, from the IMAGE_STORAGE_* settings of the run.
//
//   node tests/e2e/delete-objects.ts <document>
import { db } from '../../src/lib/db.ts';
import { imageStorage } from '../../src/lib/images/store.ts';

const [documentId] = process.argv.slice(2);
if (!documentId) throw new Error('usage: delete-objects.ts <document>');
const storage = imageStorage();
if (!storage) throw new Error('no object store is given to this run');
const rows = await db().documentImage.findMany({ where: { documentId }, select: { objectKey: true } });
for (const { objectKey } of rows) await storage.remove(objectKey);
console.log(rows.length);
await db().$disconnect();
