// FR-ED-42: mark a notification read (API design, "Notifications"). It stays
// in the list, shown as read. Only its recipient may: to any other account the
// identifier is a 404, as one that does not exist. No body.
import { fault, notAdmitted, refusedOrigin } from '../../../../lib/auth/route-answers.ts';
import { validateSessionRow } from '../../../../lib/auth/session.ts';
import { markNotificationRead } from '../../../../lib/documents/sharing.ts';
import { errorResponse } from '../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NOT_FOUND =
  'This notification is no longer in the list. Reload the list to see the current notifications.';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    // NFR-SE-17 (c), D164: the origin first.
    const foreign = await refusedOrigin(request.headers);
    if (foreign) return foreign;
    const validation = await validateSessionRow(request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const { id } = await context.params;
    if (!(await markNotificationRead(session.userId, id))) return errorResponse(404, 'not_found', NOT_FOUND);
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fault('notifications', error);
  }
}
