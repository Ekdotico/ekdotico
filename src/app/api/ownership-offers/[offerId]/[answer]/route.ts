// FR-ED-47: accept or decline an offer of ownership (API design:
// `POST /api/ownership-offers/[offerId]/accept` and `…/decline`). Only the
// account the offer names may answer it, and it is the session's account, never
// one the request names (src/lib/documents/ownership.ts, `answerOffer`).
import { fault, notAdmitted, refusedOrigin } from '../../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../../lib/auth/session.ts';
import { answered } from '../../../../../lib/documents/ownership-answers.ts';
import { OFFER_STATEMENTS } from '../../../../../lib/documents/ownership-texts.ts';
import { answerOffer } from '../../../../../lib/documents/ownership.ts';
import { errorResponse } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const ANSWERS = ['accept', 'decline'] as const;

export async function POST(
  request: Request,
  context: { params: Promise<{ offerId: string; answer: string }> },
): Promise<Response> {
  try {
    // NFR-SE-17 (c), D164: the origin first.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    // NFR-SE-17 (c): a request that changes state reads the session's row.
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);

    const { offerId, answer } = await context.params;
    const chosen = ANSWERS.find((one) => one === answer);
    if (!chosen) return errorResponse(404, 'not_found', OFFER_STATEMENTS.noSuchAction);
    return answered(await answerOffer(session.userId, String(offerId), chosen));
  } catch (error) {
    return fault('ownership offers', error);
  }
}
