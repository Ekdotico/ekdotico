// FR-ED-42: the notification list of the session's own account, with the
// unread count (API design, "Notifications"). It takes no identifier from the
// request: a notification is visible only to its recipient.
import { fault, notAdmitted } from '../../../lib/auth/route-answers.ts';
import { validateSession } from '../../../lib/auth/session.ts';
import { listNotifications } from '../../../lib/documents/sharing.ts';

export const dynamic = 'force-dynamic';

/** It reads, so the signed copy of the session serves (NFR-SE-02). */
export async function GET(request: Request): Promise<Response> {
  try {
    const validation = await validateSession(request.method, request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    return Response.json(await listNotifications(session.userId), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return fault('notifications', error);
  }
}
