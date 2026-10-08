// One run of the permanent deletion, as a process of its own, for the test
// that runs two of them at once against one database (NFR-RE-15;
// tests/integration/document-deletion.test.ts). It prints what the run did.
import { db } from '../../src/lib/db.ts';
import { deleteExpiredDocuments } from '../../src/lib/documents/deletion.ts';

console.log(JSON.stringify(await deleteExpiredDocuments()));
await db().$disconnect();
