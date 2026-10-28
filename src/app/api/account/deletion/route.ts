// FR-AU-58, FR-AU-92: what the deletion screen shows (API design, "Account", `GET /api/account/deletion`): how many
// documents the account owns, how many of them are deleted and within their retention, and for each document the
// state of its offer of ownership. It reads, so the signed copy of the session serves (NFR-SE-02); it lists the
// documents of the session's own account and takes no identifier from the request. It sends the titles of the
// account's own documents and the display name of the Editor an offer was made to, and no address and no identifier
// of another account (docs/plan/slice-24.md, section 5).
import { ownedDocuments } from '../../../../lib/account/deletion.ts';
import { transferScreen } from '../../../../lib/account/transfer.ts';
import { fault, notAdmitted } from '../../../../lib/auth/route-answers.ts';
import { validateSession } from '../../../../lib/auth/session.ts';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  try {
    const validation = await validateSession(request.method, request.headers);
    const { session } = validation;
    if (!session) return await notAdmitted(validation);
    const [owned, screen] = await Promise.all([
      ownedDocuments(session.userId),
      transferScreen(session.userId),
    ]);
    return Response.json(
      {
        owned: owned.owned,
        deleted: owned.deleted,
        documents: screen.documents.map(({ id, title, state }) => ({
          id,
          title,
          state: state.kind,
          ...('toName' in state ? { to: state.toName } : {}),
          ...('expiresAt' in state ? { expiresAt: state.expiresAt.toISOString() } : {}),
        })),
        accepted: screen.accepted.map(({ id, title, toName }) => ({ id, title, to: toName })),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return fault('account deletion', error);
  }
}
