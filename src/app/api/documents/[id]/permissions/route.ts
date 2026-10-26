// FR-ED-45, FR-ED-46: the permission set of a document (API design,
// "Documents, Sharing"). Each handler is made by `documentRoute`: for a PUT the
// origin first (D164), then the session's row, then the document and the
// permission, all before the body is read; and `permission-settings.ts` reads
// the caller's role and the stored set again under the lock of the document,
// so that what the request was authorised for is what it acts on.
import { refusedRequest, setAnswer } from '../../../../../lib/documents/permission-answers.ts';
import { heldBy, readRequest, wholeSet } from '../../../../../lib/documents/permission-rules.ts';
import { changePermissionSet } from '../../../../../lib/documents/permission-settings.ts';
import { documentRoute } from '../../../../../lib/documents/route.ts';
import { notJson, readJson } from '../../../../../lib/http.ts';

export const dynamic = 'force-dynamic';

// Every cell of the table named, with its role and its value, and the JSON around them.
const MAX_BODY_BYTES = 4096;
const NO_STORE = { 'Cache-Control': 'no-store' };

/**
 * It reads, so the signed copy of the session serves (NFR-SE-02). To the Owner
 * the whole stored set; to any other role its own name and the permissions it
 * holds on this document, and nothing of the set (FR-ED-46).
 */
export const GET = documentRoute('document.view', ({ document, role }) =>
  Response.json(
    role === 'owner'
      ? { role, set: wholeSet(document.permissionSet) }
      : { role, permissions: heldBy(document.permissionSet, role) },
    { headers: NO_STORE },
  ),
);

/**
 * FR-ED-45: `{ "changes": { "<permission>": { "<role>": true | false } } }`, or
 * `{ "defaults": true }`, and nothing else. Authorisation before validation
 * (the owner's answer to Q8): a caller who is not the Owner is told nothing of
 * the body, and a fixed cell asked for by one is a 403, not a 422.
 */
export const PUT = documentRoute(
  'document.permissions.edit',
  async ({ request, document, session }) => {
    const unsupported = notJson(request);
    if (unsupported) return unsupported;
    const read = readRequest(await readJson(request, MAX_BODY_BYTES));
    if (!read.ok) return refusedRequest(read.why);
    return setAnswer(
      await changePermissionSet(document.id, session.userId, read.request),
      session.userId,
      document.id,
    );
  },
  // FR-AU-91, FR-ED-40 (i): the set may be changed during the period, and "takes effect for everything but
  // editing": the connection stays read-only.
  { duringClearing: 'allowed' },
);
