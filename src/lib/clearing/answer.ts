// The answer to a write that found its condition false because the document entered a clearing since the request
// was authorised (FR-AU-91): the row is read again, and the answer is the true one, a 409 and not the 404 of a
// document that is not there. Used by every write that carries `clearingAt: null` in its condition.
import { db } from '../db.ts';
import { clearingRefusal, type Change } from './period.ts';

/** The 409 for this document if it is in a clearing now, else null (the caller then answers as it did before). */
export async function refusedByClearing(documentId: string, change: Change): Promise<Response | null> {
  const row = await db().document.findUnique({ where: { id: documentId }, select: { clearingAt: true } });
  return row?.clearingAt ? clearingRefusal(row.clearingAt, change) : null;
}
