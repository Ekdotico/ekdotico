// The parts of the collaboration connection that need no server: the contract
// a client imports, what is recorded for a connection, and the two timers of
// the storing and of its retry, and what a client may send as an update.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { storeRetryDelay, storeTimers } from '../../src/collab/server.ts';
import { isReadOnly, recordConnection } from '../../src/lib/collab/connection.ts';
import { COLLAB_PATH, documentName, FRAGMENT_NAME, REFUSAL } from '../../src/lib/collab/protocol.ts';
import { assertUpdate } from '../../src/lib/collab/state.ts';
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
      LIMITED: 'limited',
      CAPACITY: 'capacity',
      ACCESS_ENDED: 'access-ended',
      SESSION_ENDED: 'session-ended',
      // The owner's decision of 12 October 2026: one for each limit of a document.
      TOO_LARGE: 'too-large',
      TOO_DEEP: 'too-deep',
    });
    expect(new Set(Object.values(REFUSAL)).size).toBe(8);
  });
});

describe('a store that failed is tried again less and less often (NFR-RE-07)', () => {
  it('after 1 second, then twice as long each time, and never more than a minute', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 30].map(storeRetryDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000,
    ]);
  });
});

describe('what a client may send as an update (src/lib/collab/state.ts)', () => {
  // The update format of Yjs, version 1, written by hand: for one client, a
  // run of structs that hold nothing but a length, and no deletions.
  const varint = (value: number): number[] => {
    const bytes = [];
    for (; value > 127; value = Math.floor(value / 128)) bytes.push(128 | (value % 128));
    return [...bytes, value];
  };
  const lengths = (clock: number, ...each: number[]) =>
    Uint8Array.from([
      1,
      each.length,
      7,
      ...varint(clock),
      ...each.flatMap((length) => [0, ...varint(length)]),
      0,
    ]);
  const deletions = (clock: number, length: number) =>
    Uint8Array.from([0, 1, 7, 1, ...varint(clock), ...varint(length)]);
  const written = () => {
    const document = new Y.Doc();
    document.getArray('changes').push(['one', { two: [2] }]);
    document.getText('text').insert(0, 'three');
    document.getArray('changes').delete(0, 1);
    return document;
  };

  it('passes what Yjs writes: a whole state, and a single change', () => {
    const document = written();
    expect(() => assertUpdate(Y.encodeStateAsUpdate(document))).not.toThrow();
    const changes: Uint8Array[] = [];
    document.on('update', (update: Uint8Array) => changes.push(update));
    document.getArray('changes').push(['four']);
    expect(changes).toHaveLength(1);
    expect(() => assertUpdate(changes[0]!)).not.toThrow();
    // An update that has nothing in it, and lengths as large as a document will ever see.
    expect(() => assertUpdate(Uint8Array.from([0, 0]))).not.toThrow();
    expect(() => assertUpdate(lengths(0, 2 ** 40, 2 ** 40))).not.toThrow();
  });

  it.each([
    ['no bytes', new Uint8Array(0)],
    ['bytes that are no update', new Uint8Array(48).fill(0xff)],
    ['an update cut short', Y.encodeStateAsUpdate(written()).subarray(0, 20)],
    ['content of a kind there is none of', Uint8Array.from([1, 1, 7, 0, 15, 1, 1, 97, 0])],
    ['lengths that add up past 2^53', lengths(0, 2 ** 52, 2 ** 52, 2 ** 52)],
    ['lengths that add up past 2^56', lengths(0, 2 ** 55, 2 ** 55, 2 ** 55)],
    ['a clock past 2^53', lengths(2 ** 54, 1)],
    ['a deletion that reaches past 2^53', deletions(5, 2 ** 57)],
  ])('refuses %s', (_label, update) => {
    expect(() => assertUpdate(update)).toThrow();
  });

  // Why the check is there. If an upgrade of Yjs makes this test fail, the
  // library has closed the fault itself, and the check is then only a second lock.
  it('guards a real fault: Yjs applies such an update, and cannot read the state it then writes', () => {
    const document = written();
    Y.applyUpdate(document, lengths(0, 2 ** 55, 2 ** 55, 2 ** 55));
    const state = Y.encodeStateAsUpdate(document);
    expect(() => Y.applyUpdate(new Y.Doc(), state)).toThrow('Integer out of Range');
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
