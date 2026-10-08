// The parts of the collaboration connection that need no server: the contract
// a client imports, what is recorded for a connection, and the two timers of
// the storing.
import { describe, expect, it } from 'vitest';
import { storeTimers } from '../../src/collab/server.ts';
import { isReadOnly, recordConnection } from '../../src/lib/collab/connection.ts';
import { COLLAB_PATH, documentName, FRAGMENT_NAME, REFUSAL } from '../../src/lib/collab/protocol.ts';
import {
  defaultPermissionSet,
  PERMISSIONS,
  ROLES,
  type Permission,
} from '../../src/lib/documents/permissions.ts';

const session = { userId: 'user-1', sessionId: 'session-1' };
const ID = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';

describe('the contract of the connection (src/lib/collab/protocol.ts)', () => {
  it('names the path, the document, and the fragment', () => {
    expect(COLLAB_PATH).toBe('/collab');
    expect(documentName(ID)).toBe(ID);
    expect(FRAGMENT_NAME).toBe('default');
  });

  it('gives each refusal a reason of its own', () => {
    expect(REFUSAL).toEqual({
      NO_ACCESS: 'no-access',
      UNAVAILABLE: 'unavailable',
      CAPACITY: 'capacity',
      ACCESS_ENDED: 'access-ended',
      SESSION_ENDED: 'session-ended',
    });
    expect(new Set(Object.values(REFUSAL)).size).toBe(5);
  });
});

describe('what is recorded for a connection (NFR-SE-03 (a))', () => {
  it('holds the user, the document, the role, its permissions, and the session, and nothing else', () => {
    const recorded = recordConnection(session, { id: ID, permissionSet: defaultPermissionSet() }, 'owner');
    expect(Object.keys(recorded).sort()).toEqual([
      'documentId',
      'permissions',
      'role',
      'sessionId',
      'userId',
    ]);
    expect(recorded).toMatchObject({
      userId: 'user-1',
      documentId: ID,
      role: 'owner',
      sessionId: 'session-1',
    });
  });

  it.each(ROLES)('records for the role %s the permissions the table gives it by default', (role) => {
    const { permissions } = recordConnection(
      session,
      { id: ID, permissionSet: defaultPermissionSet() },
      role,
    );
    const expected = (Object.keys(PERMISSIONS) as Permission[]).filter((permission) =>
      ['yes', 'on'].includes(PERMISSIONS[permission][role]),
    );
    expect(permissions).toEqual(expected);
  });

  it('follows the document’s own set for a cell the Owner may change, and the table for every other', () => {
    const permissionSet = defaultPermissionSet();
    permissionSet['document.rename'].editor = true;
    // A stored set that was altered gives a Viewer nothing the table fixes.
    permissionSet['document.content.edit'].viewer = true;
    const document = { id: ID, permissionSet };
    expect(recordConnection(session, document, 'editor').permissions).toContain('document.rename');
    expect(recordConnection(session, document, 'viewer').permissions).not.toContain('document.content.edit');
  });
});

describe('read-only at the protocol level (NFR-SE-03 (a); FR-ED-44, document.content.edit)', () => {
  // The row of the table: the Owner and an Editor edit; a Reviewer and a Viewer never do.
  it.each([
    ['owner', false],
    ['editor', false],
    ['reviewer', true],
    ['viewer', true],
  ] as const)('a connection held as %s: read-only %s', (role, readOnly) => {
    for (const permissionSet of [defaultPermissionSet(), {}, null, 'altered']) {
      expect(isReadOnly(recordConnection(session, { id: ID, permissionSet }, role))).toBe(readOnly);
    }
  });

  it('is read-only for a role that is not one, and for a record without the permission', () => {
    expect(isReadOnly(recordConnection(session, { id: ID, permissionSet: {} }, 'admin' as never))).toBe(true);
    expect(isReadOnly({ permissions: [] })).toBe(true);
    expect(isReadOnly({ permissions: ['document.view'] })).toBe(true);
  });
});

describe('the two timers of the storing (NFR-RE-07; register P14)', () => {
  it('leaves room for the write inside both periods, at the initial values', () => {
    const { debounce, maxDebounce } = storeTimers({ collabStoreDelayMs: 2000, collabStoreMaxMs: 10000 });
    expect(debounce).toBe(1500);
    expect(maxDebounce).toBe(6000);
  });

  it.each([
    [2000, 10000],
    [1000, 3000],
    [5000, 30000],
  ])('keeps a change no longer than the periods %i and %i allow', (delay, max) => {
    const { debounce, maxDebounce } = storeTimers({ collabStoreDelayMs: delay, collabStoreMaxMs: max });
    expect(debounce).toBeGreaterThan(0);
    expect(maxDebounce).toBeGreaterThan(0);
    // After the last change: the write starts `debounce` later.
    expect(debounce).toBeLessThan(delay);
    // While changes continue: a write starts no later than `maxDebounce` and
    // one `debounce` after the first change not yet stored, which came no
    // later than one `debounce` after the write before.
    expect(debounce + maxDebounce + debounce).toBeLessThan(max);
  });
});
