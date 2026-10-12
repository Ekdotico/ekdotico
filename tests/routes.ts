// The route handlers of the repository, and those of them that carry no
// session, for the two tests of NFR-SE-02: tests/unit/routes.test.ts reads
// each file, and tests/integration/routes.test.ts calls each handler.
import { globSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// The routes of NFR-SE-05, each with what authenticates it instead.
export const SESSIONLESS: Record<string, string> = {
  'src/app/api/health/route.ts': 'NFR-SE-05 (c): reports that the service is up and nothing else',
  'src/app/api/auth/[...all]/route.ts':
    'NFR-SE-05 (a): the identity library checks the session of its own endpoints',
  'src/app/api/sign-up/route.ts':
    'NFR-SE-05 (a), FR-AU-90: authorised by the token of a pending admission invitation',
  'src/app/api/admission/invitations/route.ts':
    'NFR-SE-05 (b), FR-AU-89 (a), (b): the signature of each request is verified before any processing',
  'src/app/api/admission/invitations/[id]/route.ts':
    'NFR-SE-05 (b), FR-AU-89 (c): the signature of each request is verified before any processing',
};

/** Every file Next.js would take for a route handler. */
export const routes = globSync('src/app/**/route.{ts,tsx,js}');

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

/** What a route file exports under the name of an HTTP method: its handlers, as Next.js finds them. */
export async function handlersOf(route: string): Promise<[method: string, handler: unknown][]> {
  const exported: Record<string, unknown> = await import(
    /* @vite-ignore */ pathToFileURL(resolve(route)).href
  );
  return Object.entries(exported).filter(([name]) => METHODS.includes(name));
}

/** Whether a method only reads (src/lib/http.ts, `onlyReads`). Every other is taken to change state, an OPTIONS too. */
export const reads = (method: string) => method === 'GET' || method === 'HEAD';

// NFR-SE-17 (c): the handlers that change state and make no origin check, each
// with why, for tests/unit/route-origin.test.ts and its integration test. They
// carry no cookie, so there is nothing of a person's for another site to ride
// on: each is authorised by the signature of the request, made with a secret
// that no browser holds, and is called by a command and never from a page,
// which sends no `Origin` at all (NFR-SE-05 (b); API design, "Admission": "None
// carries a session, and none is ever called from a browser"). The proxy
// excepts them for the same reason (src/proxy.ts, group (b)).
export const SIGNED: Record<string, string> = {
  'src/app/api/admission/invitations/route.ts POST': 'FR-AU-89 (a): the signature is verified first',
  'src/app/api/admission/invitations/[id]/route.ts DELETE': 'FR-AU-89 (c): the signature is verified first',
};

/** Every handler that changes state and must check the origin itself, as `route METHOD`, with the handler. */
export async function mustCheckOrigin(): Promise<[row: string, handler: unknown][]> {
  const found: [string, unknown][] = [];
  for (const route of routes) {
    for (const [method, handler] of await handlersOf(route)) {
      if (!reads(method) && !(`${route} ${method}` in SIGNED)) found.push([`${route} ${method}`, handler]);
    }
  }
  return found;
}

/** The routes that must validate a session themselves. */
export const withSession = routes.filter((route) => !(route in SESSIONLESS));

// FR-AU-83: the routes with a session that an account stopped by the
// founding-team gate still reaches, each with why: "every API route refuses
// the account's requests other than those of the enrolment itself". None: the
// requests of the enrolment are endpoints of the identity library's handler,
// which is on the list above (tests/integration/founding-gate.test.ts).
export const PAST_THE_GATE: Record<string, string> = {};

/** The routes that must answer such an account 403. */
export const behindTheGate = withSession.filter((route) => !(route in PAST_THE_GATE));
