// The one way from a route to a document (NFR-SE-04, FR-ED-39, NFR-SE-02):
// every handler of a route with a document's identifier is made here, so that
// none can answer before the session is validated and the request authorised,
// and none is handed a document that ./access.ts did not allow. A test
// requires it of every such route (tests/unit/routes.test.ts).
//
// Nothing here is of Next.js: a handler is called with a Request, and with the
// parameters of the path as Next.js 16 hands them, a promise.
import { fault, unauthenticated } from '../auth/route-answers.ts';
import { validateSession, type ValidSession } from '../auth/session.ts';
import { authorise, authoriseDeleted, refusal, type DocumentRow } from './access.ts';
import type { DocumentRole, Permission } from './permissions.ts';

/** All that a handler is given: the document is the one the caller was authorised for, and there is no other. */
export interface DocumentCall {
  request: Request;
  session: ValidSession;
  document: DocumentRow;
  role: DocumentRole;
}

export type DocumentRoute = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

/** Which of the two decisions of ./access.ts a handler rests on: a document that is not deleted, or one that is. */
export type DocumentState = 'live' | 'deleted';

// What the two functions below made, with the permission each asks for and the
// state of the document it is handed. Kept here and not on the function, so
// that nothing outside this module can mark one.
const made = new WeakMap<object, { permission: Permission; state: DocumentState }>();

/** The permission a handler asks for, or undefined where this module did not make it. */
export function permissionOf(handler: unknown): Permission | undefined {
  return typeof handler === 'function' ? made.get(handler)?.permission : undefined;
}

/** Whether a handler is handed a document that is not deleted or one that is; undefined where this module did not make it. */
export function stateOf(handler: unknown): DocumentState | undefined {
  return typeof handler === 'function' ? made.get(handler)?.state : undefined;
}

type Handler = (call: DocumentCall) => Response | Promise<Response>;

/**
 * The order every request about one document is answered in: the session (a
 * 401), then the document and the permission (a 404 or a 403), and only then
 * `handler`, which reads the body.
 *
 * NFR-SE-02, NFR-SE-17 (c): a request that only reads may be validated against
 * the signed copy of the session; every other reads the session's row.
 */
function make(state: DocumentState, permission: Permission, handler: Handler): DocumentRoute {
  const route: DocumentRoute = async (request, { params }) => {
    try {
      const { session } = await validateSession(request.method, request.headers);
      if (!session) return unauthenticated();

      const { id } = await params;
      const access =
        state === 'live'
          ? await authorise(session.userId, id, permission)
          : await authoriseDeleted(session.userId, id);
      if (access.outcome !== 'allowed') return await refusal(access, session.userId, id);

      return await handler({ request, session, document: access.document, role: access.role });
    } catch (error) {
      return fault('documents', error);
    }
  };
  made.set(route, { permission, state });
  return route;
}

/** A handler for a route under `[id]`, about a document that is not deleted: `authorise` decides. */
export function documentRoute(permission: Permission, handler: Handler): DocumentRoute {
  return make('live', permission, handler);
}

/**
 * A handler for a route under `[id]`, about a DELETED document within its
 * retention: `authoriseDeleted` decides, and the permission is the one it
 * asks for, `document.delete`, which is the Owner's alone (FR-ED-36,
 * FR-ED-44). To anyone else, and for any other document, the answer is the
 * 404 of `documentRoute`, byte for byte.
 */
export function deletedDocumentRoute(handler: Handler): DocumentRoute {
  return make('deleted', 'document.delete', handler);
}
