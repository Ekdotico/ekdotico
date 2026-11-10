// The one way from a route to a document (NFR-SE-04, FR-ED-39, NFR-SE-02):
// every handler of a route with a document's identifier is made here, so that
// none can answer before the session is validated and the request authorised,
// and none is handed a document that ./access.ts did not allow. A test
// requires it of every such route (tests/unit/routes.test.ts).
//
// Nothing here is of Next.js: a handler is called with a Request, and with the
// parameters of the path as Next.js 16 hands them, a promise.
import { fault, notAdmitted, refusedOrigin, tooManyRequests } from '../auth/route-answers.ts';
import { validateSession, validateSessionRow, type ValidSession } from '../auth/session.ts';
import { clearingRefusal, type Change } from '../clearing/period.ts';
import { onlyReads } from '../http.ts';
import { takeLimit } from '../rate-limit.ts';
import { authorise, authoriseDeleted, refusal, type DocumentRow } from './access.ts';
import type { DocumentRole, Permission } from './permissions.ts';

/** All that a handler is given: the document is the one the caller was authorised for, and there is no other. */
export interface DocumentCall {
  request: Request;
  session: ValidSession;
  document: DocumentRow;
  role: DocumentRole;
  /** The other segments of the path, as Next.js gives them (an invitation's identifier); never trusted, only looked up. */
  params: Readonly<Record<string, string>>;
}

export type DocumentRoute = (
  request: Request,
  context: { params: Promise<{ id: string } & Record<string, string>> },
) => Promise<Response>;

/** Which of the two decisions of ./access.ts a handler rests on: a document that is not deleted, or one that is. */
export type DocumentState = 'live' | 'deleted';

/**
 * What a handler that changes state does for a document in the notice period of a clearing (FR-AU-91): `refused`
 * is the 409 of "a request that would change the content, the title, or the images of the document", and of the
 * rest that the requirement closes (a new invitation, a deletion by hand, a restore); `allowed` is for the
 * handlers that the period leaves open, because they change who may do what and not the document, and do not
 * bring the day forward (removing a collaborator, a change of role or of the permission set, leaving, an offer
 * of ownership). The default is `refused`: a route added without a word about it is closed during a clearing.
 * A handler that only reads is never refused.
 */
export type DuringClearing = 'refused' | 'allowed';

// What the two functions below made, with the permission each asks for and the
// state of the document it is handed. Kept here and not on the function, so
// that nothing outside this module can mark one.
const made = new WeakMap<
  object,
  { permission: Permission; state: DocumentState; row: boolean; clearing: DuringClearing; apiLimit: boolean }
>();

/** Whether a handler takes the proxy's limit of API requests itself; undefined where this module did not make it. */
export function takesApiLimit(handler: unknown): boolean | undefined {
  return typeof handler === 'function' ? made.get(handler)?.apiLimit : undefined;
}

/** The permission a handler asks for, or undefined where this module did not make it. */
export function permissionOf(handler: unknown): Permission | undefined {
  return typeof handler === 'function' ? made.get(handler)?.permission : undefined;
}

/** What a handler does for a document in a clearing, or undefined where this module did not make it. */
export function duringClearingOf(handler: unknown): DuringClearing | undefined {
  return typeof handler === 'function' ? made.get(handler)?.clearing : undefined;
}

/** Which words the 409 of a document in a clearing says, for the handler's permission and state. */
function changeOf(permission: Permission, state: DocumentState): Change {
  if (state === 'deleted') return 'restore';
  if (permission === 'document.collaborators.invite') return 'invite';
  if (permission === 'document.delete') return 'delete';
  return 'change';
}

/**
 * Whether a handler reads the session's row although it is a GET, and never the signed copy in the cookie
 * (NFR-SE-17 (c)): the issue of a link to an image. Undefined where this module did not make it.
 */
export function readsSessionRow(handler: unknown): boolean | undefined {
  return typeof handler === 'function' ? made.get(handler)?.row : undefined;
}

/** Whether a handler is handed a document that is not deleted or one that is; undefined where this module did not make it. */
export function stateOf(handler: unknown): DocumentState | undefined {
  return typeof handler === 'function' ? made.get(handler)?.state : undefined;
}

type Handler = (call: DocumentCall) => Response | Promise<Response>;

/**
 * The order every request about one document is answered in: for a request
 * that changes state, its origin (a 403); then the session (a 401, or the 403
 * of the founding-team gate, FR-AU-83), then the document and the permission
 * (a 404 or a 403), and only then `handler`, which reads the body.
 *
 * NFR-SE-02, NFR-SE-17 (c): a request that only reads may be validated against
 * the signed copy of the session; every other reads the session's row.
 */
function make(
  state: DocumentState,
  permission: Permission,
  handler: Handler,
  row: boolean,
  clearing: DuringClearing,
  apiLimit = false,
): DocumentRoute {
  const route: DocumentRoute = async (request, { params }) => {
    try {
      // NFR-SE-17 (c): the origin first, and here as well as in the proxy,
      // which can be skipped (the owner's decision R50 of 12 October 2026). A
      // deletion and a restore read no body, so nothing else of the request
      // would tell another site's from the application's own.
      //
      // It is asked by the method of the request, so a handler exported as a
      // GET is asked for none: a test holds every such handler to a
      // permission that only reads (tests/unit/route-origin.test.ts,
      // `READS_A_DOCUMENT`).
      if (!onlyReads(request.method)) {
        const foreign = await refusedOrigin(request.headers);
        if (foreign) return foreign;
      }

      const validation = row
        ? await validateSessionRow(request.headers)
        : await validateSession(request.method, request.headers);
      // NFR-SE-07, NFR-SE-19: on a path the proxy does not see (src/proxy.ts, `config`), its limit of API requests,
      // where it takes it: for the account the session is of, the founding-team gate's too, and before every refusal
      // below, so that the entries of the log those write are bounded as the requests are.
      const known = validation.session ?? validation.stopped;
      if (apiLimit && known) {
        const limit = await takeLimit('API_PER_USER', known.userId);
        if (!limit.ok)
          return await tooManyRequests('API_PER_USER', known.userId, limit.retryAfterSeconds, known.userId);
      }

      const { session } = validation;
      if (!session) return await notAdmitted(validation);

      const segments = await params;
      const { id } = segments;
      const access =
        state === 'live'
          ? await authorise(session.userId, id, permission)
          : await authoriseDeleted(session.userId, id);
      if (access.outcome !== 'allowed') return await refusal(access, session.userId, id, permission);

      // FR-AU-91: after the authorisation, so that a caller who may not act is told so (a 403) and not
      // that the document is in a clearing. The handlers that write re-read the column under their own
      // row (a request can begin before the confirmation and end after it); this answer is the early one.
      const { clearingAt } = access.document;
      if (clearing === 'refused' && !onlyReads(request.method) && clearingAt !== null) {
        return clearingRefusal(clearingAt, changeOf(permission, state));
      }

      return await handler({
        request,
        session,
        document: access.document,
        role: access.role,
        params: segments,
      });
    } catch (error) {
      return fault('documents', error);
    }
  };
  made.set(route, { permission, state, row, clearing, apiLimit });
  return route;
}

/**
 * A handler for a route under `[id]`, about a document that is not deleted: `authorise` decides. With
 * `sessionRow` the session is validated against its row even for a GET, which is what the issue of a link
 * to an image does (NFR-SE-02, NFR-SE-17 (c)); a handler that changes state reads the row anyway. With
 * `duringClearing: 'allowed'` a handler that changes state is not refused for a document in a clearing
 * (see `DuringClearing`); without it, it is. With `apiLimit` it takes the proxy's limit of API requests itself,
 * which a route on a path the proxy does not see must (src/proxy.ts, `config`).
 */
export function documentRoute(
  permission: Permission,
  handler: Handler,
  options: { sessionRow?: boolean; duringClearing?: DuringClearing; apiLimit?: boolean } = {},
): DocumentRoute {
  // FR-AU-91, FR-ED-44 (d): the draft export is what the period grants every collaborator; it changes nothing of
  // the document (it is a POST because it makes a file), so it is open during a clearing without a word from the
  // route that asks for it. Every other permission is closed unless the route says otherwise.
  const during = options.duringClearing ?? (permission === 'document.export.draft' ? 'allowed' : 'refused');
  return make('live', permission, handler, options.sessionRow === true, during, options.apiLimit === true);
}

/**
 * A handler for a route under `[id]`, about a DELETED document within its
 * retention: `authoriseDeleted` decides, and the permission is the one it
 * asks for, `document.delete`, which is the Owner's alone (FR-ED-36,
 * FR-ED-44). To anyone else, and for any other document, the answer is the
 * 404 of `documentRoute`, byte for byte.
 */
export function deletedDocumentRoute(handler: Handler): DocumentRoute {
  // FR-ED-36: a document deleted before a clearing, and treated as shared, "cannot be restored under FR-ED-36
  // during the period": the restore is always refused for a document in a clearing.
  return make('deleted', 'document.delete', handler, false, 'refused');
}
