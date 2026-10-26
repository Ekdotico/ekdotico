// FR-EX-36: the Markdown draft export, the one export of the α line, returned as the response (API design, "Export").
// Made by `documentRoute` for `document.export.draft`: a POST, so that the origin is checked and the session's row is
// read (NFR-SE-02, NFR-SE-17 (c): the draft export never uses the cookie's copy of the session).
import { documentRoute } from '../../../../../../lib/documents/route.ts';
import { draftExport } from '../../../../../../lib/export/draft.ts';

export const dynamic = 'force-dynamic';

/**
 * 200 with a ZIP archive that holds the Markdown file and the document's images, written as it is sent; or a statement
 * in the one error shape and no file: 401, 403, 404, 429 (an export under way, or ten in the hour), 503, 500.
 */
export const POST = documentRoute('document.export.draft', draftExport);
