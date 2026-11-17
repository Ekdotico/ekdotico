// NFR-SE-04, the release criterion: "For every permission of a document's
// permission set and every role, a request outside the caller's permissions
// shall receive a 403 response, and the same request shall succeed once the
// Owner grants the permission, without the caller signing in again; an
// automated test of this runs in continuous integration." And FR-ED-44, one
// test for every one of its 15 permissions and each of its four roles, FR-ED-45.
//
// Twice. Through `authorise`, the one function every request asks, for all 60
// cells. And through the real routes as Next.js calls them, for every
// permission that has one: the status for each role by default; and for each
// cell the Owner may change, the Owner's own request through the route, and
// the same request of the same session now succeeding, and refused again when
// it is taken back.
//
// The permissions with no route to call yet are named below, with what holds
// them: edit content (the collaboration server decides it:
// collab-permissions.test.ts), the two comment permissions (comments are not in
// α 0.1.0), the draft export (slice 21),
// and the sealed export (not in α). They are tested through `authorise` alone. The transfer of
// ownership (slice 17) has its route and is tested through it.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ALL_PERMISSIONS, changeable, heldByDefault, ROLE_AT, symbolOf } from '../permission-table.ts';
import { cookiesOf, createAccount, load, ORIGIN, PASSWORD, prepare, signIn } from './identity.ts';

// `after` of Next.js exists only inside a request of the framework. The invitation routes leave
// their email to it; nothing it is given runs here, and so no email is written.
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: () => {},
}));

const database = prepare('permissionsmatrix', { RATE_LIMIT_INVITATIONS_PER_USER: '100000/3600' });
const { auth, db, valkey } = await load();
const { authorise } = await import('../../src/lib/documents/access.ts');
const { createDocument } = await import('../../src/lib/documents/documents.ts');
const { defaultPermissionSet } = await import('../../src/lib/documents/permissions.ts');
const document = await import('../../src/app/api/documents/[id]/route.ts');
const people = await import('../../src/app/api/documents/[id]/collaborators/route.ts');
const one = await import('../../src/app/api/documents/[id]/collaborators/[collaboratorId]/route.ts');
const invitations = await import('../../src/app/api/documents/[id]/invitations/route.ts');
const leaving = await import('../../src/app/api/documents/[id]/leave/route.ts');
const permissions = await import('../../src/app/api/documents/[id]/permissions/route.ts');
const ownership = await import('../../src/app/api/documents/[id]/ownership-offer/route.ts');
type Permission = (typeof ALL_PERMISSIONS)[number];
type Role = (typeof ROLE_AT)[number];

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

// ── Accounts, documents ─────────────────────────────────────────────────────

let count = 0;
async function person() {
  const email = `matrix${++count}@example.com`;
  const id = await createAccount(auth, email);
  return { id, email, cookie: cookiesOf(await signIn(auth, email)) };
}
type Person = Awaited<ReturnType<typeof person>>;
const people4 = {} as Record<Role, Person> & { target: Person };
beforeAll(async () => {
  for (const role of ROLE_AT) people4[role] = await person();
  people4.target = await person();
});

/** A fresh document with the Owner, an Editor, a Reviewer, a Viewer, and one more Viewer for the others to act on. */
async function fresh() {
  const id = (await createDocument(people4.owner.id)).id;
  await db().documentCollaborator.createMany({
    data: [
      { documentId: id, userId: people4.editor.id, role: 'EDITOR' },
      { documentId: id, userId: people4.reviewer.id, role: 'REVIEWER' },
      { documentId: id, userId: people4.viewer.id, role: 'VIEWER' },
    ],
  });
  const target = await db().documentCollaborator.create({
    data: { documentId: id, userId: people4.target.id, role: 'VIEWER' },
  });
  return { id, target: target.id };
}

const request = (method: string, path: string, cookie: string, body?: unknown) =>
  new Request(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...(method === 'GET' ? {} : { origin: ORIGIN }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      cookie,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const at = <T extends Record<string, string>>(params: T) => ({ params: Promise.resolve(params) });

/** The Owner's request through the route to give or take a role a permission. */
const setCell = (id: string, permission: Permission, role: Role, allowed: boolean) =>
  permissions.PUT(
    request('PUT', `/api/documents/${id}/permissions`, people4.owner.cookie, {
      changes: { [permission]: { [role]: allowed } },
    }),
    at({ id }),
  );

// ── Through `authorise`, all 60 cells ───────────────────────────────────────

const cells = ALL_PERMISSIONS.flatMap((permission) => ROLE_AT.map((role) => [permission, role] as const));

describe('every permission and every role, through authorise (FR-ED-44, NFR-SE-04)', () => {
  let shared: Awaited<ReturnType<typeof fresh>>;
  beforeAll(async () => {
    shared = await fresh();
  });

  const asks = async (role: Role, permission: Permission) =>
    (await authorise(people4[role].id, shared.id, permission)).outcome;

  // Weakening: any cell of the table read otherwise; the stored set read for a cell the table fixes.
  it.each(cells)('%s for the %s: the default of the table', async (permission, role) => {
    await db().document.update({ where: { id: shared.id }, data: { permissionSet: defaultPermissionSet() } });
    expect(await asks(role, permission), `${permission} ${role}`).toBe(
      heldByDefault(permission, role) ? 'allowed' : 'forbidden',
    );
  });

  // Weakening: the permission set not read from current state, or the role's column read for another role.
  it.each(cells.filter(([permission, role]) => changeable(permission, role)))(
    '%s for the %s, a cell the Owner may change: forbidden or allowed as the stored set says, with no new sign-in',
    async (permission, role) => {
      for (const allowed of [true, false, true]) {
        const set = JSON.parse(JSON.stringify(defaultPermissionSet()));
        set[permission][role] = allowed;
        await db().document.update({ where: { id: shared.id }, data: { permissionSet: set } });
        expect(await asks(role, permission), `${permission} ${role} ${allowed}`).toBe(
          allowed ? 'allowed' : 'forbidden',
        );
        // No other role's answer moved with it.
        for (const other of ROLE_AT) {
          if (other === role) continue;
          expect(await asks(other, permission), `${permission} ${other}`).toBe(
            heldByDefault(permission, other) ? 'allowed' : 'forbidden',
          );
        }
      }
    },
  );

  // Weakening: the stored set trusted for a cell that is fixed, reads "never", or is the Owner's.
  it.each(cells.filter(([permission, role]) => !changeable(permission, role)))(
    '%s for the %s, a cell no setting changes: the table’s answer, whatever the stored set says',
    async (permission, role) => {
      for (const forged of [true, false]) {
        const set = JSON.parse(JSON.stringify(defaultPermissionSet()));
        set[permission][role] = forged;
        await db().document.update({ where: { id: shared.id }, data: { permissionSet: set } });
        expect(await asks(role, permission), `${permission} ${role} ${forged}`).toBe(
          heldByDefault(permission, role) ? 'allowed' : 'forbidden',
        );
      }
    },
  );

  it('answers every cell of the table that the printed symbol gives as a tick or "on" with a yes, and no other', () => {
    // The check of the table itself: 15 permissions, 4 roles, the Owner's dash for leaving the one no.
    expect(cells).toHaveLength(60);
    expect(symbolOf('document.leave', 'owner')).toBe('—');
    expect(heldByDefault('document.leave', 'owner')).toBe(false);
  });
});

// ── Through the real routes ─────────────────────────────────────────────────

/**
 * A request for each permission that has a route, with the status that succeeds. The request is
 * made by the caller's cookie, on a fresh document, and the cases are those of the table.
 */
const ROUTES: {
  permission: Permission;
  ask: (cookie: string, id: string, target: string) => Promise<Response>;
  succeeds: number;
}[] = [
  {
    permission: 'document.view',
    ask: (cookie, id) => document.GET(request('GET', `/api/documents/${id}`, cookie), at({ id })),
    succeeds: 200,
  },
  {
    permission: 'document.collaborators.view',
    ask: (cookie, id) => people.GET(request('GET', `/api/documents/${id}/collaborators`, cookie), at({ id })),
    succeeds: 200,
  },
  {
    permission: 'document.rename',
    ask: (cookie, id) =>
      document.PATCH(request('PATCH', `/api/documents/${id}`, cookie, { title: 'A new title' }), at({ id })),
    succeeds: 200,
  },
  {
    permission: 'document.collaborators.invite',
    ask: (cookie, id) =>
      invitations.POST(
        request('POST', `/api/documents/${id}/invitations`, cookie, {
          emails: [`someone${randomUUID()}@example.com`],
          role: 'viewer',
        }),
        at({ id }),
      ),
    succeeds: 201,
  },
  {
    // A Viewer to raise: an Editor who holds the permission may (FR-ED-44 (b)).
    permission: 'document.collaborators.roles',
    ask: (cookie, id, target) =>
      one.PATCH(
        request('PATCH', `/api/documents/${id}/collaborators/${target}`, cookie, { role: 'editor' }),
        at({ id, collaboratorId: target }),
      ),
    succeeds: 200,
  },
  {
    permission: 'document.collaborators.remove',
    ask: (cookie, id, target) =>
      one.DELETE(
        request('DELETE', `/api/documents/${id}/collaborators/${target}`, cookie),
        at({ id, collaboratorId: target }),
      ),
    succeeds: 200,
  },
  {
    permission: 'document.leave',
    ask: (cookie, id) => leaving.POST(request('POST', `/api/documents/${id}/leave`, cookie), at({ id })),
    succeeds: 204,
  },
  {
    // The Owner's own request: the set as it is, returned to its defaults, is a request that changes nothing and succeeds.
    permission: 'document.permissions.edit',
    ask: (cookie, id) =>
      permissions.PUT(
        request('PUT', `/api/documents/${id}/permissions`, cookie, { defaults: true }),
        at({ id }),
      ),
    succeeds: 200,
  },
  {
    permission: 'document.delete',
    ask: (cookie, id) => document.DELETE(request('DELETE', `/api/documents/${id}`, cookie), at({ id })),
    succeeds: 204,
  },
  {
    // FR-ED-47: ownership offered to the Editor of the document. Fixed to the Owner, so only the Owner succeeds.
    permission: 'document.ownership.transfer',
    ask: async (cookie, id) => {
      const editor = await db().documentCollaborator.findFirstOrThrow({
        where: { documentId: id, userId: people4.editor.id },
      });
      return ownership.POST(
        request('POST', `/api/documents/${id}/ownership-offer`, cookie, {
          collaboratorId: editor.id,
          password: PASSWORD,
        }),
        at({ id }),
      );
    },
    succeeds: 201,
  },
];

const NO_ROUTE_YET: Permission[] = [
  'document.content.edit',
  'document.comments.write',
  'document.comments.resolve',
  'document.export.draft',
  'document.export.sealed',
];

describe('every permission and every role, through the real routes (NFR-SE-04)', () => {
  it('has a route for each permission but the five that have none yet, named', () => {
    expect([...ROUTES.map(({ permission }) => permission), ...NO_ROUTE_YET].sort()).toEqual(
      [...ALL_PERMISSIONS].sort(),
    );
  });

  // Weakening: a route that asks the wrong permission, or asks none.
  it.each(
    ROUTES.flatMap(({ permission, ask, succeeds }) =>
      ROLE_AT.map((role) => [permission, role, ask, succeeds] as const),
    ),
  )(
    '%s for the %s: the default of the table, a 403 where it is not held',
    async (permission, role, ask, succeeds) => {
      const { id, target } = await fresh();
      const response = await ask(people4[role].cookie, id, target);
      expect(response.status, `${permission} ${role}`).toBe(heldByDefault(permission, role) ? succeeds : 403);
      if (!heldByDefault(permission, role)) expect((await response.json()).error.code).toBe('forbidden');
    },
  );

  // Weakening: the permission read from a copy, from the session, or from the role alone.
  it.each(
    ROUTES.flatMap(({ permission, ask, succeeds }) =>
      (['editor', 'viewer'] as const)
        .filter((role) => changeable(permission, role))
        .map((role) => [permission, role, ask, succeeds] as const),
    ),
  )(
    '%s for the %s: a 403, then the Owner grants it by the route and the same session succeeds, then it is taken back',
    async (permission, role, ask, succeeds) => {
      const { id, target } = await fresh();
      const held = heldByDefault(permission, role);
      const cookie = people4[role].cookie;
      // On a cell that is "on" the request succeeds first; on one that is "off" it is refused. Either way the
      // Owner then moves the cell to the other value and the same cookie sees it.
      if (!held) expect((await ask(cookie, id, target)).status).toBe(403);
      expect((await setCell(id, permission, role, true)).status).toBe(200);
      // The same session, with no new sign-in.
      const granted = await ask(cookie, id, target);
      expect(granted.status, `${permission} ${role} granted`).toBe(succeeds);
      // A request whose success changed what it asks for is made again on a fresh document where it needs one.
      const again = await fresh();
      expect((await setCell(again.id, permission, role, true)).status).toBe(200);
      expect((await setCell(again.id, permission, role, false)).status).toBe(200);
      const taken = await ask(cookie, again.id, again.target);
      expect(taken.status, `${permission} ${role} taken back`).toBe(403);
      expect((await taken.json()).error.code).toBe('forbidden');
    },
  );

  // Weakening: the Owner's request for a cell no setting changes accepted.
  it.each(
    ROUTES.flatMap(({ permission, ask, succeeds }) =>
      ROLE_AT.filter((role) => !changeable(permission, role) && role !== 'reviewer').map(
        (role) => [permission, role, ask, succeeds] as const,
      ),
    ),
  )(
    '%s for the %s, a cell no setting changes: the Owner’s request for it is refused with a 422, and nothing it asks for changes',
    async (permission, role, ask, succeeds) => {
      const { id, target } = await fresh();
      const before = heldByDefault(permission, role);
      for (const allowed of [true, false]) {
        const asked = await setCell(id, permission, role, allowed);
        expect(asked.status, `${permission} ${role} ${allowed}`).toBe(422);
      }
      // The route answers as it did: held or refused by the table, the stored set never read for it.
      const response = await ask(people4[role].cookie, id, target);
      expect(response.status, `${permission} ${role}`).toBe(before ? succeeds : 403);
    },
  );
});
