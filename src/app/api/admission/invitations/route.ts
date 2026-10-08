// FR-AU-89 (a), (b): create and list admission invitations. No session
// (NFR-SE-05 (b)): each request is authenticated by its signature, which
// `admission` verifies before anything else is done. The statuses and the
// bodies are those of docs/contracts/admission-signature.md.
import { after } from 'next/server';
import { admission } from '../../../../lib/admission/gate.ts';
import { createInvitation, listInvitations } from '../../../../lib/admission/invitations.ts';
import { handOver } from '../../../../lib/email/hand-over.ts';
import { errorResponse } from '../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

// Text for the person who runs the command (the owner's answer to Q6 of the plan).
const MESSAGES = {
  invalid:
    'No invitation was created. The request needs an email address and a request identifier of 1 to 64 letters, digits, hyphens or underscores, and a request identifier that was used before can be sent again only with the same address.',
  accountExists: 'No invitation was created, because this address already belongs to an account.',
};

export function POST(request: Request): Promise<Response> {
  return admission(request, async (body) => {
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      return errorResponse(422, 'invalid', MESSAGES.invalid);
    }
    const result = await createInvitation(json);
    if (result.outcome === 'invalid') return errorResponse(422, 'invalid', MESSAGES.invalid);
    if (result.outcome === 'account_exists') {
      return errorResponse(409, 'account_exists', MESSAGES.accountExists);
    }
    if (result.outcome === 'created') {
      // FR-AU-87, NFR-RE-15: handed to the email service after the response
      // has been returned, and tried again for up to 10 minutes.
      const { message } = result;
      after(() => handOver(message));
    }
    return Response.json(result.invitation, { status: 201, headers: NO_STORE });
  });
}

export function GET(request: Request): Promise<Response> {
  return admission(request, async () =>
    Response.json({ invitations: await listInvitations() }, { headers: NO_STORE }),
  );
}
