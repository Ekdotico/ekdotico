// FR-ED-21, FR-ED-37: invite one or more people to a document (API design,
// "Documents, Sharing"). Made by `documentRoute`: the origin, the session's
// row, the document and `document.collaborators.invite` are decided before
// the body is read (the owner's answer to Q8).
import { after } from 'next/server';
import { createdAnswer, INVITATION_MESSAGES } from '../../../../../lib/documents/invitation-answers.ts';
import { documentRoute } from '../../../../../lib/documents/route.ts';
import {
  createInvitations,
  OFFERED,
  PEOPLE_MOST,
  type OfferedRole,
} from '../../../../../lib/documents/sharing.ts';
import { acceptedAddress } from '../../../../../lib/field-text.ts';
import { errorResponse, notJson, readJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// Ten addresses of 254 characters, each character written as an escape of
// six bytes, and the JSON around them.
const MAX_BODY_BYTES = 16 * 1024;
// No request can add more people than the limit leaves room for, the Owner counted.
const ADDRESSES_MOST = PEOPLE_MOST;
// An entry that is not an address is quoted in the refusal; past this it is cut.
const ENTRY_SHOWN = 80;

/**
 * The body: `{ "emails": ["…", …], "role": "editor" | "viewer", "hideTitle"?: boolean }`,
 * and nothing else. An address given twice receives one invitation (FR-ED-37).
 * The Reviewer is not offered (D56) and is refused with a 422 (plan Q7).
 * `hideTitle` (D202, Q49) is off where it is absent, and anything but a
 * boolean is refused: a title is never shown by a value the server did not
 * understand to mean the opposite. It is for every caller this route admits:
 * the Owner, and an Editor who holds `document.collaborators.invite` (Q49 (5)).
 */
export const POST = documentRoute('document.collaborators.invite', async ({ request, document, session }) => {
  const unsupported = notJson(request);
  if (unsupported) return unsupported;
  const body = await readJson(request, MAX_BODY_BYTES);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return errorResponse(422, 'invalid_request', INVITATION_MESSAGES.invalid);
  }
  const { emails, role, hideTitle = false, ...rest } = body as Record<string, unknown>;
  if (role === 'reviewer') return errorResponse(422, 'role_not_offered', INVITATION_MESSAGES.reviewer);
  if (
    Object.keys(rest).length > 0 ||
    typeof hideTitle !== 'boolean' ||
    typeof role !== 'string' ||
    !Object.hasOwn(OFFERED, role) ||
    !Array.isArray(emails) ||
    emails.length === 0 ||
    emails.length > ADDRESSES_MOST
  ) {
    return errorResponse(422, 'invalid_request', INVITATION_MESSAGES.invalid);
  }
  const accepted: string[] = [];
  for (const entry of emails) {
    const email = acceptedAddress(entry);
    if (!email) {
      const shown = typeof entry === 'string' ? entry.slice(0, ENTRY_SHOWN) : String(entry);
      return errorResponse(422, 'invalid_address', INVITATION_MESSAGES.notAnAddress(shown));
    }
    if (!accepted.includes(email)) accepted.push(email);
  }
  const result = await createInvitations(
    document,
    session.userId,
    accepted,
    role as OfferedRole,
    new Date(),
    hideTitle,
  );
  return createdAnswer(result, document.id, session.userId, after);
});
