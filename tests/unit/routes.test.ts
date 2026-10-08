// NFR-SE-02: "Routes that do not validate the session shall not exist in the
// application's repository, other than the request paths NFR-SE-05 lists."
//
// proxy.ts validates before any route, but Next.js skips the proxy for a
// request that carries the build's own revalidation identifier
// (docs/operations/deployment.md), so a route does not rest on the proxy: each
// validates the session itself. A route added without it fails here.
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The routes of NFR-SE-05, each with what authenticates it instead.
const SESSIONLESS: Record<string, string> = {
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

const routes = globSync('src/app/**/route.ts');

describe('the route handlers', () => {
  it('are found', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes.filter((route) => !(route in SESSIONLESS)))('%s validates the session', (route) => {
    expect(readFileSync(route, 'utf8')).toMatch(/\bvalidateSession(Row)?\(/);
  });

  it('excepts no route that does not exist', () => {
    for (const route of Object.keys(SESSIONLESS)) expect(routes).toContain(route);
  });
});

// NFR-SE-04, FR-ED-39: every access control decision for a document is made
// against the caller's role and the document's permission set, "at the API
// layer on every request". One function makes it, `authorise` of
// src/lib/documents/access.ts, and every handler under /api/documents calls
// it, with the user of the session it validated. A handler added without the
// call fails here.
//
// The one route with no document to ask about, with what authorises it instead.
const WITHOUT_A_DOCUMENT: Record<string, string> = {
  'src/app/api/documents/route.ts':
    'GET lists the documents of the session’s own account and takes no identifier from the request; POST creates in that account’s personal workspace and refuses any other (FR-AU-12)',
};

// The permission each handler asks for, as the Auth column of the API design
// page gives it ("Documents"). While the Owner is the only role, no request
// can show a handler that asks for the wrong one, so it is held here; and a
// handler that is not in this table fails, so that each is given one on purpose.
const PERMISSION: Record<string, string> = {
  'src/app/api/documents/[id]/route.ts GET': 'document.view',
  'src/app/api/documents/[id]/route.ts PATCH': 'document.rename', // FR-ED-35, FR-ED-44
};

const documentRoutes = routes.filter((route) => route.startsWith('src/app/api/documents/'));

/** The source of each exported handler of a route file, from its method to the next. */
function handlers(route: string): string[] {
  return readFileSync(route, 'utf8')
    .split(/^export (?:async )?function (?=(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\()/m)
    .slice(1);
}

describe('the route handlers of a document', () => {
  it('are found', () => {
    expect(documentRoutes.length).toBeGreaterThan(1);
    for (const route of Object.keys(WITHOUT_A_DOCUMENT)) expect(documentRoutes).toContain(route);
  });

  it.each(documentRoutes.filter((route) => !(route in WITHOUT_A_DOCUMENT)))(
    '%s authorises every request',
    (route) => {
      const found = handlers(route);
      expect(found.length).toBeGreaterThan(0);
      for (const handler of found) {
        expect(handler).toMatch(/\bvalidateSession(Row)?\(/);
        expect(handler).toMatch(/\bawait authorise\(session\.userId, /);
        const method = /^[A-Z]+/.exec(handler)![0];
        const permission = PERMISSION[`${route} ${method}`];
        expect(permission, `${route} ${method} has no row in PERMISSION`).toBeDefined();
        // One call, and for the permission of the table.
        expect(handler.match(/\bauthorise\(/g)).toHaveLength(1);
        expect(handler).toContain(`await authorise(session.userId, id, '${permission}')`);
        // What the function did not allow is answered and never passed over.
        expect(handler).toMatch(/if \(access\.outcome !== 'allowed'\) return refusal\(/);
      }
    },
  );

  it.each(documentRoutes)('%s reads the row of the session for a request that changes state', (route) => {
    for (const handler of handlers(route)) {
      if (/^(GET|HEAD)\(/.test(handler)) continue;
      expect(handler).toMatch(/\bvalidateSessionRow\(/); // NFR-SE-17 (c)
    }
  });
});
