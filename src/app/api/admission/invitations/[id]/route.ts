// FR-AU-89 (c): revoke an admission invitation. No session (NFR-SE-05 (b)):
// the request is authenticated by its signature, which `admission` verifies
// before anything else is done. The statuses and the bodies are those of
// docs/contracts/admission-signature.md.
import { admission } from '../../../../../lib/admission/gate.ts';
import { revokeInvitation } from '../../../../../lib/admission/invitations.ts';
import { errorResponse } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// Text for the person who runs the command (the owner's answer to Q6 of the plan).
const MESSAGES = {
  notFound: 'No invitation has this identifier. List the invitations to find the identifier.',
  notPending:
    'This invitation was not revoked, because it is accepted or expired. Only a pending invitation can be revoked.',
};

export function DELETE(request: Request): Promise<Response> {
  return admission(request, async () => {
    // The identifier is the last segment of the path that was signed, which
    // the verification has held to 1 to 64 letters, digits, `-` and `_`.
    const id = new URL(request.url).pathname.split('/').at(-1) ?? '';
    const result = await revokeInvitation(id);
    if (result.outcome === 'not_found') return errorResponse(404, 'not_found', MESSAGES.notFound);
    if (result.outcome === 'not_pending') return errorResponse(409, 'not_pending', MESSAGES.notPending);
    return Response.json(result.invitation, { headers: { 'Cache-Control': 'no-store' } });
  });
}
