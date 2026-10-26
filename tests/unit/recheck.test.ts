// The decision of the re-check of FR-ED-41: what is done with an open connection
// when its session and its access are read again (src/lib/collab/recheck.ts).
import { describe, expect, it } from 'vitest';
import type { Access, DocumentRow } from '../../src/lib/documents/access.ts';
import { isReadOnly, recordConnection, type CollabConnection } from '../../src/lib/collab/connection.ts';
import { REFUSAL } from '../../src/lib/collab/protocol.ts';
import { decide, RECHECK_MS, sessionStands, type SessionRow } from '../../src/lib/collab/recheck.ts';
import { defaultPermissionSet, type DocumentRole } from '../../src/lib/documents/permissions.ts';

const DAY = 24 * 60 * 60 * 1000;
const MAX = 30 * DAY;
const NOW = Date.UTC(2026, 9, 18, 12);
const DOCUMENT = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';

const document = {
  id: DOCUMENT,
  permissionSet: defaultPermissionSet(),
  clearingAt: null,
} as unknown as DocumentRow;
const allowed = (role: DocumentRole, over: Partial<DocumentRow> = {}): Access => ({
  outcome: 'allowed',
  role,
  document: { ...document, ...over },
});
const open = (role: DocumentRole): CollabConnection =>
  recordConnection({ userId: 'u1', sessionId: 's1' }, document, role);
const standing = (over: Partial<SessionRow> = {}): SessionRow => ({
  userId: 'u1',
  createdAt: new Date(NOW - 2 * DAY),
  expiresAt: new Date(NOW + 5 * DAY),
  accountStands: true,
  ...over,
});

describe('the period of the re-check', () => {
  it('is the 60 seconds of FR-ED-41', () => {
    expect(RECHECK_MS).toBe(60_000);
  });
});

describe('a session that stands (FR-ED-41; FR-AU-84)', () => {
  it('has a row, of the connection’s user, inside both periods, and an account that is not deleted', () => {
    expect(sessionStands(standing(), 'u1', NOW, MAX)).toBe(true);
  });

  it.each([
    ['no row', null],
    ['no row either', undefined],
    ['the row of another user', standing({ userId: 'u2' })],
    ['an account that is deleted', standing({ accountStands: false })],
    ['the idle period over', standing({ expiresAt: new Date(NOW) })],
    ['the idle period over, a day ago', standing({ expiresAt: new Date(NOW - DAY) })],
    ['30 days since it began', standing({ createdAt: new Date(NOW - MAX) })],
    [
      'more than 30 days, though it was renewed',
      standing({ createdAt: new Date(NOW - 31 * DAY), expiresAt: new Date(NOW + 7 * DAY) }),
    ],
    ['a time that cannot be read (idle)', standing({ expiresAt: new Date(NaN) })],
    ['a time that cannot be read (beginning)', standing({ createdAt: new Date(NaN) })],
  ])('does not stand with %s', (_, row) => {
    expect(sessionStands(row, 'u1', NOW, MAX)).toBe(false);
  });

  it('stands to the last moment of both periods', () => {
    expect(sessionStands(standing({ expiresAt: new Date(NOW + 1) }), 'u1', NOW, MAX)).toBe(true);
    expect(sessionStands(standing({ createdAt: new Date(NOW - MAX + 1) }), 'u1', NOW, MAX)).toBe(true);
  });
});

describe('what is done with an open connection', () => {
  it('keeps one where nothing differs', () => {
    expect(decide(open('editor'), standing(), allowed('editor'), NOW, MAX)).toEqual({ action: 'keep' });
    expect(decide(open('owner'), standing(), allowed('owner'), NOW, MAX)).toEqual({ action: 'keep' });
    expect(decide(open('viewer'), standing(), allowed('viewer'), NOW, MAX)).toEqual({ action: 'keep' });
  });

  it('closes one whose session no longer stands, as session-ended, whatever else is true of it', () => {
    for (const row of [
      null,
      standing({ expiresAt: new Date(NOW - 1) }),
      standing({ accountStands: false }),
    ]) {
      for (const access of [allowed('editor'), { outcome: 'not_found' } as const, allowed('viewer')]) {
        expect(decide(open('editor'), row, access, NOW, MAX)).toEqual({
          action: 'close',
          reason: REFUSAL.SESSION_ENDED,
        });
      }
    }
  });

  it('closes one whose role is gone, or whose document is deleted, as access-ended', () => {
    // `not_found` is both: no role, and a document that is deleted or is not there (src/lib/documents/access.ts).
    expect(decide(open('editor'), standing(), { outcome: 'not_found' }, NOW, MAX)).toEqual({
      action: 'close',
      reason: REFUSAL.ACCESS_ENDED,
    });
  });

  it('closes one for which the role no longer holds the permission to view, as access-ended', () => {
    expect(decide(open('editor'), standing(), { outcome: 'forbidden' }, NOW, MAX)).toEqual({
      action: 'close',
      reason: REFUSAL.ACCESS_ENDED,
    });
  });

  it('closes one for a document that is another from the one it was opened on', () => {
    const other = allowed('editor', { id: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f' });
    expect(decide(open('editor'), standing(), other, NOW, MAX)).toEqual({
      action: 'close',
      reason: REFUSAL.ACCESS_ENDED,
    });
  });

  it('switches one whose role changed, with the record the new role makes', () => {
    const down = decide(open('editor'), standing(), allowed('viewer'), NOW, MAX);
    expect(down).toEqual({
      action: 'switch',
      record: recordConnection({ userId: 'u1', sessionId: 's1' }, document, 'viewer'),
    });
    expect(down.action === 'switch' && down.record.permissions).not.toContain('document.content.edit');
    const up = decide(open('viewer'), standing(), allowed('editor'), NOW, MAX);
    expect(up.action === 'switch' && up.record.permissions).toContain('document.content.edit');
    // Editor to Reviewer, both read the document and only one writes it: a switch, and not a keep.
    expect(decide(open('editor'), standing(), allowed('reviewer'), NOW, MAX).action).toBe('switch');
  });

  it('switches one whose role holds other permissions now, though the role is the same (FR-ED-40 (g))', () => {
    const changed = structuredClone(defaultPermissionSet());
    changed['document.export.draft'].viewer = true;
    const decision = decide(
      open('viewer'),
      standing(),
      allowed('viewer', { permissionSet: changed as never }),
      NOW,
      MAX,
    );
    expect(decision.action).toBe('switch');
    expect(decision.action === 'switch' && decision.record.permissions).toContain('document.export.draft');
  });

  // FR-ED-40 (g): the set, and not the role alone, is what `decide` reads.
  it('switches one whose role lost a permission to a change of the set, the role the same', () => {
    const given = structuredClone(defaultPermissionSet());
    given['document.rename'].editor = true;
    const connection = recordConnection(
      { userId: 'u1', sessionId: 's1' },
      { id: DOCUMENT, permissionSet: given, clearingAt: null },
      'editor',
    );
    expect(connection.permissions).toContain('document.rename');
    const decision = decide(connection, standing(), allowed('editor'), NOW, MAX);
    expect(decision.action).toBe('switch');
    expect(decision.action === 'switch' && decision.record.role).toBe('editor');
    expect(decision.action === 'switch' && decision.record.permissions).not.toContain('document.rename');
  });

  it('keeps one whose role holds what it held, though another role’s cell changed', () => {
    const changed = structuredClone(defaultPermissionSet());
    changed['document.rename'].editor = true;
    expect(
      decide(open('viewer'), standing(), allowed('viewer', { permissionSet: changed as never }), NOW, MAX),
    ).toEqual({ action: 'keep' });
    expect(
      decide(open('owner'), standing(), allowed('owner', { permissionSet: changed as never }), NOW, MAX),
    ).toEqual({ action: 'keep' });
  });

  it('makes no connection editable or read-only by a change of the set: that is fixed by role (FR-ED-44)', () => {
    const everything = structuredClone(defaultPermissionSet());
    for (const permission of Object.keys(everything) as (keyof typeof everything)[]) {
      everything[permission].editor = true;
      everything[permission].viewer = true;
      everything[permission].reviewer = true;
    }
    for (const role of ['editor', 'viewer', 'reviewer'] as const) {
      const decision = decide(
        open(role),
        standing(),
        allowed(role, { permissionSet: everything as never }),
        NOW,
        MAX,
      );
      if (decision.action === 'switch') {
        expect(isReadOnly(decision.record)).toBe(isReadOnly(open(role)));
      }
      expect(isReadOnly(open(role))).toBe(role !== 'editor');
    }
  });

  it('carries the session and the user of the connection into the new record, and no other', () => {
    const decision = decide(open('editor'), standing(), allowed('viewer'), NOW, MAX);
    expect(decision.action === 'switch' && decision.record).toMatchObject({
      userId: 'u1',
      sessionId: 's1',
      documentId: DOCUMENT,
      role: 'viewer',
    });
  });
});

// FR-ED-40 (i), FR-AU-91, register A103: a document in a clearing is read-only for everyone, and the re-check is
// the backstop of the event that says so.
describe('a document in the notice period of a clearing', () => {
  const DAY_OF_DELETION = new Date(NOW + 7 * DAY);
  const inClearing = (role: DocumentRole, over: Partial<DocumentRow> = {}) =>
    allowed(role, { clearingAt: DAY_OF_DELETION, ...over });
  const record = (role: DocumentRole, clearingAt: Date | null = DAY_OF_DELETION) =>
    recordConnection({ userId: 'u1', sessionId: 's1' }, { ...document, clearingAt }, role);

  // Mutation R01: `recordConnection` leaves the right to edit where the document is in a clearing.
  it.each(['owner', 'editor'] as const)(
    'leaves a %s no right to edit, and a connection that held it is switched to read-only',
    (role) => {
      expect(isReadOnly(record(role))).toBe(true);
      expect(record(role).permissions).not.toContain('document.content.edit');
      // What else the role holds is untouched: it reads, and exports.
      expect(record(role).permissions).toContain('document.view');
      const decision = decide(open(role), standing(), inClearing(role), NOW, MAX);
      expect(decision.action).toBe('switch');
      expect(decision.action === 'switch' && isReadOnly(decision.record)).toBe(true);
      expect(decision.action === 'switch' && decision.record.deletedOn).toBe(DAY_OF_DELETION.toISOString());
    },
  );

  // Mutation R02: `decide` compares the permissions and not the day.
  it('switches a connection that was read-only already, so that it is told the day', () => {
    const decision = decide(open('viewer'), standing(), inClearing('viewer'), NOW, MAX);
    expect(decision.action).toBe('switch');
    expect(decision.action === 'switch' && decision.record.deletedOn).toBe(DAY_OF_DELETION.toISOString());
  });

  it('keeps one that is as the rows say, and switches one back when the day goes', () => {
    const held = record('editor');
    expect(decide(held, standing(), inClearing('editor'), NOW, MAX)).toEqual({ action: 'keep' });
    const back = decide(held, standing(), allowed('editor'), NOW, MAX);
    expect(back.action).toBe('switch');
    expect(back.action === 'switch' && isReadOnly(back.record)).toBe(false);
    expect(back.action === 'switch' && back.record.deletedOn).toBeNull();
  });

  // Mutation R03: a role raised to Editor, or a set that gives every role everything, makes a connection editable.
  it('is not made editable by a role raised to Editor, nor by a permission set that gives every role every permission', () => {
    const everything = structuredClone(defaultPermissionSet());
    for (const permission of Object.keys(everything) as (keyof typeof everything)[]) {
      for (const role of ['owner', 'editor', 'reviewer', 'viewer'] as const)
        everything[permission][role] = true;
    }
    for (const role of ['owner', 'editor', 'reviewer', 'viewer'] as const) {
      expect(isReadOnly(record(role))).toBe(true);
      const decision = decide(
        record(role),
        standing(),
        inClearing(role, { permissionSet: everything as never }),
        NOW,
        MAX,
      );
      const resulting = decision.action === 'switch' ? decision.record : record(role);
      expect(isReadOnly(resulting)).toBe(true);
    }
    const raised = decide(record('viewer'), standing(), inClearing('editor'), NOW, MAX);
    expect(raised.action === 'switch' && raised.record.role).toBe('editor');
    expect(raised.action === 'switch' && isReadOnly(raised.record)).toBe(true);
  });

  it('records the day as the time `toISOString` writes, and null for a document in none', () => {
    expect(record('owner').deletedOn).toBe(DAY_OF_DELETION.toISOString());
    expect(record('owner', null).deletedOn).toBeNull();
  });
});
