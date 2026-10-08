// NFR-SE-02: "Routes that do not validate the session shall not exist in the
// application's repository, other than the request paths NFR-SE-05 lists."
//
// proxy.ts validates before any route, but Next.js skips the proxy for a
// request that carries the build's own revalidation identifier
// (docs/operations/deployment.md), so a route does not rest on the proxy: each
// validates the session itself. A route added without it fails here.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Permission } from '../../src/lib/documents/permissions.ts';
import { documentRoute, permissionOf } from '../../src/lib/documents/route.ts';
import { routes, SESSIONLESS, withSession } from '../routes.ts';

// NFR-SE-04, FR-ED-39: every access control decision for a document is made
// against the caller's role and the document's permission set, "at the API
// layer on every request". One function makes it, `authorise` of
// src/lib/documents/access.ts, and one function calls it for a route,
// `documentRoute` of src/lib/documents/route.ts: it validates the session,
// authorises the request for one permission, and only then calls the handler,
// with the document it allowed and no other. So the rule is not looked for in
// the text of a route: every handler of a route with a document must BE what
// `documentRoute` returned, for the permission the table below gives it.
//
// The one route with no document to ask about, with what authorises each of
// its methods instead. A route with an identifier in its path cannot be here.
const WITHOUT_A_DOCUMENT: Record<string, string> = {
  'src/app/api/documents/route.ts GET':
    'lists the documents of the session’s own account and takes no identifier from the request',
  'src/app/api/documents/route.ts POST':
    'creates in the personal workspace of the session’s own account and refuses any other (FR-AU-12)',
};

// The permission each handler asks for, as the Auth column of the API design
// page gives it ("Documents"). While the Owner is the only role, no request
// can show a handler that asks for the wrong one, so it is held here; and a
// handler that is not in this table fails, so that each is given one on purpose.
const PERMISSION: Record<string, Permission> = {
  'src/app/api/documents/[id]/route.ts GET': 'document.view',
  'src/app/api/documents/[id]/route.ts PATCH': 'document.rename', // FR-ED-35, FR-ED-44
};

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const routeOf = (row: string) => row.split(' ')[0]!;

const documentRoutes = routes.filter((route) => route.startsWith('src/app/api/documents/'));
const withoutADocument = [...new Set(Object.keys(WITHOUT_A_DOCUMENT).map(routeOf))];
const withADocument = documentRoutes.filter((route) => !withoutADocument.includes(route));

/** What a route file exports under the name of an HTTP method: its handlers, as Next.js finds them. */
async function handlersOf(route: string): Promise<[method: string, handler: unknown][]> {
  const exported: Record<string, unknown> = await import(
    /* @vite-ignore */ pathToFileURL(resolve(route)).href
  );
  return Object.entries(exported).filter(([name]) => METHODS.includes(name));
}

/** The source of each handler written as a function in a route file, from its method to the next. */
function sources(route: string): string[] {
  return readFileSync(route, 'utf8')
    .split(/^export (?:async )?function (?=(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\()/m)
    .slice(1);
}

describe('the route handlers', () => {
  it('are found', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  // A route with a document validates through `documentRoute`, which the
  // tests below require of every one of its handlers.
  it.each(withSession.filter((route) => !withADocument.includes(route)))(
    '%s validates the session',
    (route) => {
      expect(readFileSync(route, 'utf8')).toMatch(/\bvalidateSession(Row)?\(/);
    },
  );

  it('excepts no route that does not exist', () => {
    for (const route of Object.keys(SESSIONLESS)) expect(routes).toContain(route);
  });
});

describe('the route handlers of a document', () => {
  it('are found', () => {
    expect(withADocument.length).toBeGreaterThan(0);
    for (const route of withoutADocument) expect(documentRoutes).toContain(route);
  });

  it('excepts no route with an identifier in its path', () => {
    for (const route of withoutADocument) expect(route).not.toContain('[');
  });

  it.each(withADocument)(
    '%s: every handler is made by documentRoute, for the permission of the table',
    async (route) => {
      const handlers = await handlersOf(route);
      expect(handlers.length).toBeGreaterThan(0);
      for (const [method, handler] of handlers) {
        const permission = PERMISSION[`${route} ${method}`];
        expect(permission, `${route} ${method} has no row in PERMISSION`).toBeDefined();
        expect(permissionOf(handler), `${route} ${method} was not made by documentRoute`).toBeDefined();
        expect(permissionOf(handler)).toBe(permission);
      }
    },
  );

  it('names no handler that does not exist', async () => {
    for (const row of [...Object.keys(PERMISSION), ...Object.keys(WITHOUT_A_DOCUMENT)]) {
      expect(documentRoutes).toContain(routeOf(row));
      const methods = (await handlersOf(routeOf(row))).map(([method]) => method);
      expect(methods, row).toContain(row.split(' ')[1]);
    }
  });

  it('knows a handler that documentRoute did not make', () => {
    const made = documentRoute('document.view', () => new Response());
    expect(permissionOf(made)).toBe('document.view');
    // Nothing a route file can write makes a handler pass for one: not a plain
    // function, not one that calls a made one, not a copy of its properties.
    expect(permissionOf(async () => new Response())).toBeUndefined();
    expect(permissionOf((...call: Parameters<typeof made>) => made(...call))).toBeUndefined();
    expect(permissionOf(Object.assign(() => new Response(), made))).toBeUndefined();
    expect(permissionOf(made.bind(null))).toBeUndefined();
    expect(permissionOf(undefined)).toBeUndefined();
  });

  // What construction cannot show: the route without a document is read as
  // text, each handler for the validation of the session it must make itself.
  it.each(withoutADocument)(
    '%s: every handler is excepted on purpose and validates the session',
    async (route) => {
      const handlers = await handlersOf(route);
      for (const [method, handler] of handlers) {
        expect(WITHOUT_A_DOCUMENT[`${route} ${method}`], `${route} ${method} has no row`).toBeDefined();
        expect(handler).toBeTypeOf('function');
      }
      // Every exported handler is written as a function, so that each is read here.
      const found = sources(route);
      expect(found.map((source) => /^[A-Z]+/.exec(source)![0]).sort()).toEqual(
        handlers.map(([method]) => method).sort(),
      );
      for (const source of found) {
        // NFR-SE-17 (c): a request that changes state reads the row of the session.
        expect(source).toMatch(
          /^(GET|HEAD)\(/.test(source) ? /\bvalidateSession(Row)?\(/ : /\bvalidateSessionRow\(/,
        );
      }
    },
  );
});
