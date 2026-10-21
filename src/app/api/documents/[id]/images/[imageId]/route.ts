// FR-ED-08, NFR-SE-18: a link to an image, valid for 5 minutes, which is the
// only way an image is served (API design, "Documents, Images"). Made by
// `documentRoute` for `document.view`, with the session's row read though this
// is a GET (NFR-SE-17 (c)): the issue of a link is one of the requests that
// never use the signed copy.
import { documentRoute } from '../../../../../../lib/documents/route.ts';
import { issueLink } from '../../../../../../lib/images/link.ts';

export const dynamic = 'force-dynamic';

/** 200 with `{ "url", "expiresAt" }`; or the 404 of an image that is not this document's. */
export const GET = documentRoute('document.view', issueLink, { sessionRow: true });
