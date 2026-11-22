// Marks the account of an address as already given its Onboarding paper, in the database of the run,
// so that a test about something else meets the list it made and not the paper
// (src/lib/documents/onboarding-paper.ts). A test about the paper does not call it.
//
//   node tests/e2e/mark-paper-given.ts <address>
import { db } from '../../src/lib/db.ts';

const [email] = process.argv.slice(2);
if (!email) throw new Error('usage: mark-paper-given.ts <address>');
await db().user.updateMany({
  where: { email, onboardingPaperSeededAt: null },
  data: { onboardingPaperSeededAt: new Date() },
});
await db().$disconnect();
