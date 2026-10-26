// Brings the open clearings of one account (FR-AU-91) back in time by a number of days, in the database of the run,
// and runs the timer of the clearings once (NFR-RE-15), as an hour of the real timer would on the day: the shared
// documents of those clearings are due. Only the account's own clearings are moved, so that a test that runs beside
// another one in the same database does not carry out the other's.
//
//   node tests/e2e/run-clearing.ts <address of the Owner> <days>
import { carryOutClearings } from '../../src/lib/clearing/deletion.ts';
import { db } from '../../src/lib/db.ts';

const [email, days] = process.argv.slice(2);
if (!email || !days || !/^\d+$/.test(days))
  throw new Error('usage: run-clearing.ts <address of the Owner> <days>');
const back = Number(days) * 24 * 60 * 60 * 1000;
const user = await db().user.findUniqueOrThrow({ where: { email }, select: { id: true } });
const earlier = (at: Date) => new Date(at.getTime() - back);
for (const clearing of await db().documentClearing.findMany({
  where: { userId: user.id, completedAt: null },
})) {
  const days = [clearing.requestedAt, clearing.deleteSharedAt].filter((day): day is Date => day !== null);
  for (const day of days) {
    await db().document.updateMany({
      where: { id: { in: clearing.documentIds }, clearingAt: day },
      data: { clearingAt: earlier(day) },
    });
  }
  await db().documentClearing.update({
    where: { id: clearing.id },
    data: {
      requestedAt: earlier(clearing.requestedAt),
      deleteSharedAt: clearing.deleteSharedAt ? earlier(clearing.deleteSharedAt) : null,
    },
  });
}
console.log(JSON.stringify(await carryOutClearings()));
await db().$disconnect();
// The collaboration servers are told over Valkey, whose connection would keep the process alive.
process.exit(0);
