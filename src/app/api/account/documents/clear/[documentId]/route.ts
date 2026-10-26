// FR-AU-91: "The Owner may cancel the clearing during the period, for one shared document or for all of them"
// (API design, "Account"; the path is that page's). This is for one: `DELETE /api/account/documents/clear` is for
// all of them. It changes state, so it reads the session's row and checks the origin itself, as the others do; it
// asks for no password (docs/plan/slice-23.md, S23-5).
//
// The identifier is whatever the address holds: one that is not a document's names nothing, and a document of
// another account is answered as one that is not waiting, so that the answer does not show that it exists.
import { fault, notAdmitted, refusedOrigin } from '../../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../../lib/auth/session.ts';
import { cancelClearing, DOCUMENT_ID } from '../../../../../../lib/clearing/clearing.ts';
import { CLEARING_MESSAGES } from '../../../../../../lib/clearing/texts.ts';
import { errorResponse } from '../../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

async function refusal(request: Request): Promise<Response | null> {
  try {
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
  } catch (error) {
    return fault('clearing', error);
  }
  return null;
}

async function cancel(context: { params: Promise<{ documentId: string }> }, request: Request): Promise<Response> {
  try {
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const { documentId } = await context.params;
    if (!DOCUMENT_ID.test(documentId)) return errorResponse(404, 'not_found', CLEARING_MESSAGES.notWaiting);
    const result = await cancelClearing(session.userId, documentId);
    switch (result.outcome) {
      case 'none':
        return errorResponse(404, 'not_found', CLEARING_MESSAGES.notWaiting);
      case 'too_late':
        return errorResponse(409, 'too_late', CLEARING_MESSAGES.tooLate);
      case 'cancelled':
        return Response.json({ cancelled: result.documentIds.length }, { headers: NO_STORE });
    }
  } catch (error) {
    return fault('clearing', error);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ documentId: string }> },
): Promise<Response> {
  const refused = await refusal(request);
  if (refused) return refused;
  return cancel(context, request);
}
