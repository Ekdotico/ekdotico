// FR-ED-08, NFR-SE-18: upload one image to a document (API design, "Documents,
// Images"). Made by `documentRoute` for `document.content.edit`, so that the
// origin, the session's row, the document and the permission are decided before
// the body is read; the checks that follow are src/lib/images/upload.ts's. The
// body is the bytes of the image: a route whose body is not JSON by design is
// outside the rule of a JSON body (register D156).
import { documentRoute } from '../../../../../lib/documents/route.ts';
import { uploadImage } from '../../../../../lib/images/upload.ts';

export const dynamic = 'force-dynamic';

/** 201 with the image's identifier; 413, 415, 429, or the 403 and 404 of every document route. */
export const POST = documentRoute('document.content.edit', uploadImage);
