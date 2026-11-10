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
import {
  deletedDocumentRoute,
  duringClearingOf,
  documentRoute,
  permissionOf,
  readsSessionRow,
  stateOf,
  takesApiLimit,
} from '../../src/lib/documents/route.ts';
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
  'src/app/api/documents/deleted/route.ts GET':
    'lists the deleted documents the session’s own account is the Owner of and takes no identifier from the request (FR-ED-36)',
};

// The permission each handler asks for, as the Auth column of the API design
// page gives it ("Documents"). While the Owner is the only role, no request
// can show a handler that asks for the wrong one, so it is held here; and a
// handler that is not in this table fails, so that each is given one on purpose.
const PERMISSION: Record<string, Permission> = {
  'src/app/api/documents/[id]/route.ts GET': 'document.view',
  'src/app/api/documents/[id]/route.ts PATCH': 'document.rename', // FR-ED-35, FR-ED-44
  'src/app/api/documents/[id]/route.ts DELETE': 'document.delete', // FR-ED-36: the Owner
  'src/app/api/documents/[id]/restore/route.ts POST': 'document.delete', // FR-ED-36: "deleting and restoring"
  // FR-ED-37, FR-ED-44: inviting, sending again, revoking, and seeing the pending invitations.
  'src/app/api/documents/[id]/invitations/route.ts POST': 'document.collaborators.invite',
  'src/app/api/documents/[id]/invitations/[invitationId]/route.ts DELETE': 'document.collaborators.invite',
  'src/app/api/documents/[id]/invitations/[invitationId]/resend/route.ts POST':
    'document.collaborators.invite',
  // API design: "List the document's collaborators and their roles".
  'src/app/api/documents/[id]/collaborators/route.ts GET': 'document.collaborators.view',
  // FR-ED-38, FR-ED-44 (b): changing a role, removing a collaborator, and leaving (register row S15-1).
  'src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts PATCH': 'document.collaborators.roles',
  'src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts DELETE':
    'document.collaborators.remove',
  'src/app/api/documents/[id]/leave/route.ts POST': 'document.leave',
  // FR-ED-45, FR-ED-46: the permission set. Any role may read what it holds; only the Owner changes the set.
  'src/app/api/documents/[id]/permissions/route.ts GET': 'document.view',
  'src/app/api/documents/[id]/permissions/route.ts PUT': 'document.permissions.edit',
  // FR-ED-47: offering ownership and withdrawing the offer. The permission is fixed to the Owner.
  'src/app/api/documents/[id]/ownership-offer/route.ts POST': 'document.ownership.transfer',
  'src/app/api/documents/[id]/ownership-offer/route.ts DELETE': 'document.ownership.transfer',
  // FR-ED-08, NFR-SE-18 (API design, "Images"): the upload asks to edit the document, the link to see it.
  'src/app/api/documents/[id]/images/route.ts POST': 'document.content.edit',
  'src/app/api/documents/[id]/images/[imageId]/route.ts GET': 'document.view',
  // FR-EX-01 (a), FR-EX-36, FR-ED-44 (API design, "Export"): the Markdown draft export.
  'src/app/api/documents/[id]/export/draft/route.ts POST': 'document.export.draft',
};

// NFR-SE-02, NFR-SE-17 (c): the handlers that are a GET and read the session's row all the same, since
// "the issue of a link to an image" is one of the requests that never use the signed copy. Every other
// GET may; a handler of this table that does not read the row fails, and so does a GET that is in no
// table and reads it by chance of a rule that was not meant to bind it.
const READS_THE_SESSION_ROW = ['src/app/api/documents/[id]/images/[imageId]/route.ts GET'];

// The handlers that act on a DELETED document: each is made by
// `deletedDocumentRoute`, which asks `authoriseDeleted`. Every other is made by
// `documentRoute`, which asks `authorise` and is never handed a deleted
// document. A handler made by the wrong one of the two fails below: one that
// would restore a document that is not deleted, or rename one that is.
const ON_A_DELETED_DOCUMENT = ['src/app/api/documents/[id]/restore/route.ts POST'];

// FR-AU-91: what a handler that changes state does for a document in the notice period of a clearing. A handler
// not in this list is REFUSED with a 409 (the default of `documentRoute`): the period "refuses a request that would
// change the content, the title, or the images of the document", and the rest it closes (a new invitation, a deletion
// by hand, a restore). These alone are left open, because they change who may do what and not the document, and
// do not bring the day forward: removing a collaborator, a change of role, leaving, the permission set, an offer of
// ownership, and revoking an invitation. A handler that only reads is never refused.
// The handlers on a path the proxy does not see (src/proxy.ts, `config`), which take its limit of API requests.
const UNSEEN_BY_THE_PROXY = ['src/app/api/documents/[id]/images/route.ts POST'];

const OPEN_DURING_A_CLEARING = [
  'src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts PATCH',
  'src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts DELETE',
  'src/app/api/documents/[id]/leave/route.ts POST',
  // FR-AU-91, FR-ED-44 (d): the draft export is what the period grants every collaborator (slice 21's route).
  'src/app/api/documents/[id]/export/draft/route.ts POST',
  'src/app/api/documents/[id]/permissions/route.ts PUT',
  'src/app/api/documents/[id]/ownership-offer/route.ts POST',
  'src/app/api/documents/[id]/ownership-offer/route.ts DELETE',
  'src/app/api/documents/[id]/invitations/[invitationId]/route.ts DELETE',
];

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
        expect(stateOf(handler), `${route} ${method}`).toBe(
          ON_A_DELETED_DOCUMENT.includes(`${route} ${method}`) ? 'deleted' : 'live',
        );
        // A handler that changes state reads the row whatever it says; of a GET it is a decision.
        expect(readsSessionRow(handler), `${route} ${method}`).toBe(
          READS_THE_SESSION_ROW.includes(`${route} ${method}`),
        );
        // FR-AU-91: closed during a clearing unless it is on the list of the handlers that are left open.
        expect(duringClearingOf(handler), `${route} ${method}`).toBe(
          OPEN_DURING_A_CLEARING.includes(`${route} ${method}`) ? 'allowed' : 'refused',
        );
        // NFR-SE-07: the proxy's limit of API requests, taken by the handler where the proxy does not see the path.
        expect(takesApiLimit(handler), `${route} ${method}`).toBe(
          UNSEEN_BY_THE_PROXY.includes(`${route} ${method}`),
        );
      }
    },
  );

  // S-01 of the audit of November 2026: the proxy does not see the upload's path, for any method (src/proxy.ts,
  // `config`). A handler added beside the upload would have no proxy in front of it, so the module holds the upload
  // and nothing else.
  it('holds on the path the proxy does not see the upload alone, which takes the limit of API requests itself', async () => {
    const upload = (await import('../../src/app/api/documents/[id]/images/route.ts')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(upload).sort()).toEqual(['POST', 'dynamic']);
    expect(upload.dynamic).toBe('force-dynamic');
    expect(permissionOf(upload.POST)).toBe('document.content.edit');
    expect(takesApiLimit(upload.POST)).toBe(true);
    expect(takesApiLimit(documentRoute('document.view', () => new Response()))).toBe(false);
    expect(takesApiLimit(async () => new Response())).toBeUndefined();
  });

  it('names no handler that does not exist', async () => {
    for (const row of [
      ...Object.keys(PERMISSION),
      ...Object.keys(WITHOUT_A_DOCUMENT),
      ...ON_A_DELETED_DOCUMENT,
      ...OPEN_DURING_A_CLEARING,
    ]) {
      expect(documentRoutes).toContain(routeOf(row));
      const methods = (await handlersOf(routeOf(row))).map(([method]) => method);
      expect(methods, row).toContain(row.split(' ')[1]);
    }
  });

  // FR-AU-91: refused is what a handler is unless it says otherwise, and the restore of a deleted document always is.
  it('closes a handler during a clearing unless it is declared open, and knows no handler it did not make', () => {
    const closed = documentRoute('document.rename', () => new Response());
    const open = documentRoute('document.leave', () => new Response(), { duringClearing: 'allowed' });
    expect(duringClearingOf(closed)).toBe('refused');
    // The draft export is what a clearing grants every collaborator (FR-ED-44 (d)): its route is open without a word.
    expect(duringClearingOf(documentRoute('document.export.draft', () => new Response()))).toBe('allowed');
    expect(duringClearingOf(documentRoute('document.export.sealed', () => new Response()))).toBe('refused');
    expect(duringClearingOf(open)).toBe('allowed');
    expect(duringClearingOf(deletedDocumentRoute(() => new Response()))).toBe('refused');
    expect(duringClearingOf(async () => new Response())).toBeUndefined();
    expect(duringClearingOf(open.bind(null))).toBeUndefined();
    expect(duringClearingOf(undefined)).toBeUndefined();
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

  it('knows which of the two decisions a handler rests on, and the permission of a restore', () => {
    expect(stateOf(documentRoute('document.delete', () => new Response()))).toBe('live');
    const restore = deletedDocumentRoute(() => new Response());
    expect(stateOf(restore)).toBe('deleted');
    // FR-ED-36, FR-ED-44: not a parameter, so no route can ask for a lesser one.
    expect(permissionOf(restore)).toBe('document.delete');
    expect(stateOf(async () => new Response())).toBeUndefined();
    expect(stateOf(restore.bind(null))).toBeUndefined();
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
