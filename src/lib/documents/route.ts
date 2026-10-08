// The one way from a route to a document (NFR-SE-04, FR-ED-39, NFR-SE-02):
// every handler of a route with a document's identifier is made here, so that
// none can answer before the session is validated and the request authorised,
// and none is handed a document that ./access.ts did not allow. A test
// requires it of every such route (tests/unit/routes.test.ts).
//
// Nothing here is of Next.js: a handler is called with a Request, and with the
// parameters of the path as Next.js 16 hands them, a promise.
import type { Document } from '../../generated/prisma/client.ts';
import { fault, unauthenticated } from '../auth/route-answers.ts';
import { validateSession, type ValidSession } from '../auth/session.ts';
import { authorise, refusal } from './access.ts';
import type { DocumentRole, Permission } from './permissions.ts';

/** All that a handler is given: the document is the one the caller was authorised for, and there is no other. */
export interface DocumentCall {
  request: Request;
  session: ValidSession;
  document: Document;
  role: DocumentRole;
}

export type DocumentRoute = (
  request: Request,
  context: { params: Promise<{ id: string }> },
) => Promise<Response>;

// What `documentRoute` made, with the permission it asks for. Kept here and
// not on the function, so that nothing outside this module can mark one.
const made = new WeakMap<object, Permission>();

/** The permission a handler asks for, or undefined where `documentRoute` did not make it. */
export function permissionOf(handler: unknown): Permission | undefined {
  return typeof handler === 'function' ? made.get(handler) : undefined;
}

/**
 * A handler for a route under `[id]`, in the order every such request is
 * answered in: the session (a 401), then the document and the permission (a
 * 404 or a 403), and only then `handler`, which reads the body.
 *
 * NFR-SE-02, NFR-SE-17 (c): a request that only reads may be validated against
 * the signed copy of the session; every other reads the session's row.
 */
export function documentRoute(
  permission: Permission,
  handler: (call: DocumentCall) => Response | Promise<Response>,
): DocumentRoute {
  const route: DocumentRoute = async (request, { params }) => {
    try {
      const { session } = await validateSession(request.method, request.headers);
      if (!session) return unauthenticated();

      const { id } = await params;
      const access = await authorise(session.userId, id, permission);
      if (access.outcome !== 'allowed') return await refusal(access, session.userId, id);

      return await handler({ request, session, document: access.document, role: access.role });
    } catch (error) {
      return fault('documents', error);
    }
  };
  made.set(route, permission);
  return route;
}
