// What the Owner may change in a document's permission set and what the screen
// shows of it (FR-ED-44, FR-ED-45, FR-ED-46; docs/plan/slice-16.md): the pure
// rules of src/lib/documents/permission-rules.ts. The routes that apply them
// are tested against a database (tests/integration/permission-settings.test.ts).
import { describe, expect, it } from 'vitest';
import {
  applyRequest,
  cellState,
  heldBy,
  readRequest,
  sameSet,
  SCREEN_PERMISSIONS,
  SCREEN_ROLES,
  wholeSet,
  type CellState,
} from '../../src/lib/documents/permission-rules.ts';
import {
  defaultPermissionSet,
  PERMISSIONS,
  ROLES,
  type DocumentRole,
  type Permission,
} from '../../src/lib/documents/permissions.ts';
import { ALL_PERMISSIONS, symbolOf } from '../permission-table.ts';

// The table of FR-ED-44 as the requirement prints it is tests/permission-table.ts.
const ALL = ALL_PERMISSIONS;
const HIDDEN_ROWS: Permission[] = [
  'document.comments.write',
  'document.comments.resolve',
  'document.export.sealed',
];

/** What the cell of the table is, as FR-ED-44 and FR-ED-46 say it, for a cell of the α screen. */
function expected(permission: Permission, role: DocumentRole): CellState {
  if (HIDDEN_ROWS.includes(permission) || role === 'reviewer') return 'not_offered';
  const symbol = symbolOf(permission, role);
  if (symbol === 'on' || symbol === 'off') return 'adjustable';
  return symbol === '✓' ? 'always' : 'never';
}

const cells = ALL.flatMap((permission) => ROLES.map((role) => [permission, role] as const));

describe('the part of the set that α 0.1.0 shows (build-phases; FR-ED-44)', () => {
  it('is every permission but the two comment permissions and the sealed export, in the order of the table', () => {
    expect([...SCREEN_PERMISSIONS]).toEqual(ALL.filter((permission) => !HIDDEN_ROWS.includes(permission)));
    expect(SCREEN_PERMISSIONS).toHaveLength(12);
  });

  it('is the columns of the Owner, the Editor and the Viewer, and not the Reviewer', () => {
    expect([...SCREEN_ROLES]).toEqual(['owner', 'editor', 'viewer']);
  });
});

describe('what a cell is', () => {
  it.each(cells)('%s for the %s', (permission, role) => {
    expect(cellState(permission, role)).toBe(expected(permission, role));
  });

  it('is adjustable for exactly the cells of the Editor and the Viewer that read on or off, in a row that is shown', () => {
    const adjustable = cells.filter(([permission, role]) => cellState(permission, role) === 'adjustable');
    expect(adjustable.map((cell) => cell.join(' '))).toEqual([
      'document.collaborators.view editor',
      'document.collaborators.view viewer',
      'document.rename editor',
      'document.export.draft editor',
      'document.export.draft viewer',
      'document.collaborators.invite editor',
      'document.collaborators.roles editor',
      'document.collaborators.remove editor',
    ]);
  });

  it('never makes an Owner cell adjustable (FR-ED-44: no setting takes a permission from the Owner)', () => {
    for (const permission of ALL) expect(cellState(permission, 'owner')).not.toBe('adjustable');
  });

  it('never makes a fixed permission adjustable for any role (FR-ED-44)', () => {
    for (const permission of ALL) {
      if (PERMISSIONS[permission].kind === 'adjustable') continue;
      for (const role of ROLES) expect(cellState(permission, role)).not.toBe('adjustable');
    }
  });
});

describe('the request a body makes (FR-ED-45)', () => {
  const change = (permission: string, role: string, value: unknown = true) => ({
    changes: { [permission]: { [role]: value } },
  });

  it('is one cell, several cells, or the defaults', () => {
    expect(readRequest(change('document.rename', 'editor'))).toEqual({
      ok: true,
      request: {
        kind: 'changes',
        cells: [{ permission: 'document.rename', role: 'editor', allowed: true }],
      },
    });
    expect(
      readRequest({
        changes: {
          'document.rename': { editor: true },
          'document.export.draft': { editor: false, viewer: true },
        },
      }),
    ).toEqual({
      ok: true,
      request: {
        kind: 'changes',
        cells: [
          { permission: 'document.rename', role: 'editor', allowed: true },
          { permission: 'document.export.draft', role: 'editor', allowed: false },
          { permission: 'document.export.draft', role: 'viewer', allowed: true },
        ],
      },
    });
    expect(readRequest({ defaults: true })).toEqual({ ok: true, request: { kind: 'defaults' } });
  });

  it.each(
    cells.flatMap(([permission, role]) => [
      [permission, role, true] as const,
      [permission, role, false] as const,
    ]),
  )(
    'asked of %s for the %s with %s: accepted for an adjustable cell and refused for any other',
    (permission, role, value) => {
      const read = readRequest({ changes: { [permission]: { [role]: value } } });
      const state = expected(permission, role);
      if (state === 'adjustable') expect(read.ok).toBe(true);
      else expect(read).toEqual({ ok: false, why: state === 'not_offered' ? 'not_offered' : 'cell_fixed' });
    },
  );

  it('refuses a fixed cell with its own value, not only a change of it', () => {
    expect(readRequest(change('document.view', 'viewer', true))).toEqual({ ok: false, why: 'cell_fixed' });
    expect(readRequest(change('document.content.edit', 'viewer', false))).toEqual({
      ok: false,
      why: 'cell_fixed',
    });
    expect(readRequest(change('document.delete', 'owner', true))).toEqual({ ok: false, why: 'cell_fixed' });
  });

  it('refuses the whole request where one cell is refused, and names the refusal', () => {
    expect(
      readRequest({
        changes: { 'document.rename': { editor: true }, 'document.view': { viewer: false } },
      }),
    ).toEqual({ ok: false, why: 'cell_fixed' });
    expect(
      readRequest({
        changes: { 'document.rename': { editor: true }, 'document.comments.resolve': { editor: true } },
      }),
    ).toEqual({ ok: false, why: 'not_offered' });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'defaults'],
    ['an empty object', {}],
    ['defaults that is not true', { defaults: false }],
    ['defaults that is the text "true"', { defaults: 'true' }],
    ['defaults with a key more', { defaults: true, changes: {} }],
    ['changes with a key more', { ...change('document.rename', 'editor'), defaults: true }],
    ['a key that is neither', { replace: {} }],
    ['changes that is an array', { changes: [] }],
    ['no cell in changes', { changes: {} }],
    ['a permission with no role', { changes: { 'document.rename': {} } }],
    ['a permission that is not an object', { changes: { 'document.rename': true } }],
    ['a permission that is an array', { changes: { 'document.rename': [true] } }],
    ['an unknown permission', change('document.nothing', 'editor')],
    ['a permission that is an inherited name', { changes: { toString: { editor: true } } }],
    ['the name of a prototype', JSON.parse('{"changes":{"__proto__":{"editor":true}}}')],
    ['an unknown role', change('document.rename', 'king')],
    ['a role that is an inherited name', change('document.rename', 'constructor')],
    ['a value that is the text "true"', change('document.rename', 'editor', 'true')],
    ['a value that is 1', change('document.rename', 'editor', 1)],
    ['a value that is null', change('document.rename', 'editor', null)],
    ['a value that is an object', change('document.rename', 'editor', { allowed: true })],
  ])('is invalid with %s', (_, body) => {
    expect(readRequest(body)).toEqual({ ok: false, why: 'invalid_request' });
  });

  it('puts an invalid cell before a refused one', () => {
    expect(
      readRequest({ changes: { 'document.view': { viewer: false }, 'document.rename': { editor: 'x' } } }),
    ).toEqual({ ok: false, why: 'invalid_request' });
  });
});

describe('the set a request makes (FR-ED-45)', () => {
  it('changes the cell asked for and no other', () => {
    const read = readRequest({ changes: { 'document.rename': { editor: true } } });
    if (!read.ok) throw new Error('not read');
    const stored = defaultPermissionSet();
    const next = applyRequest(stored, read.request);
    expect(next['document.rename'].editor).toBe(true);
    for (const permission of ALL) {
      for (const role of ROLES) {
        if (permission === 'document.rename' && role === 'editor') continue;
        expect(next[permission][role]).toBe(stored[permission][role]);
      }
    }
    expect(stored['document.rename'].editor).toBe(false);
  });

  it('is the defaults, whole, for the defaults', () => {
    const changed = defaultPermissionSet();
    changed['document.rename'].editor = true;
    changed['document.collaborators.view'].viewer = false;
    changed['document.comments.resolve'].reviewer = true;
    expect(applyRequest(changed, { kind: 'defaults' })).toEqual(defaultPermissionSet());
  });

  it('is whole: every permission and every role, the fixed cells with the table’s value', () => {
    const whole = wholeSet({});
    expect(Object.keys(whole).sort()).toEqual([...ALL].sort());
    for (const permission of ALL) expect(Object.keys(whole[permission]).sort()).toEqual([...ROLES].sort());
    // Nothing is held where the stored set holds nothing, but what the table fixes.
    expect(whole['document.view']).toEqual({ owner: true, editor: true, reviewer: true, viewer: true });
    expect(whole['document.rename']).toEqual({ owner: true, editor: false, reviewer: false, viewer: false });
    expect(whole['document.leave'].owner).toBe(false);
  });

  it('writes no fixed cell from a stored set that was altered by hand', () => {
    const altered = defaultPermissionSet();
    altered['document.content.edit'].viewer = true;
    altered['document.delete'].editor = true;
    altered['document.view'].owner = false;
    const read = readRequest({ changes: { 'document.rename': { editor: true } } });
    if (!read.ok) throw new Error('not read');
    const next = applyRequest(altered, read.request);
    expect(next['document.content.edit'].viewer).toBe(false);
    expect(next['document.delete'].editor).toBe(false);
    expect(next['document.view'].owner).toBe(true);
  });

  it('reads a cell that is not exactly true as refusing, and writes it back whole', () => {
    const odd = JSON.parse(
      JSON.stringify({ ...defaultPermissionSet(), 'document.rename': { editor: 'true', viewer: 1 } }),
    );
    const next = wholeSet(odd);
    expect(next['document.rename'].editor).toBe(false);
    expect(next['document.rename'].viewer).toBe(false);
  });

  it('compares two sets cell for cell', () => {
    const a = defaultPermissionSet();
    const b = defaultPermissionSet();
    expect(sameSet(a, b)).toBe(true);
    b['document.comments.resolve'].reviewer = !b['document.comments.resolve'].reviewer;
    expect(sameSet(a, b)).toBe(false);
  });
});

describe('what a role holds, for the statement of FR-ED-46', () => {
  it('is the rows of the screen that the stored set gives the role', () => {
    const stored = defaultPermissionSet();
    expect(heldBy(stored, 'viewer')).toEqual([
      'document.view',
      'document.collaborators.view',
      'document.leave',
    ]);
    expect(heldBy(stored, 'editor')).toEqual([
      'document.view',
      'document.content.edit',
      'document.collaborators.view',
      'document.export.draft',
      'document.leave',
    ]);
    expect(heldBy(stored, 'owner')).not.toContain('document.leave');
    expect(heldBy(stored, 'owner')).toContain('document.permissions.edit');
  });

  it('follows the stored set for an adjustable cell and never for a fixed one', () => {
    const stored = defaultPermissionSet();
    stored['document.rename'].editor = true;
    stored['document.content.edit'].viewer = true;
    expect(heldBy(stored, 'editor')).toContain('document.rename');
    expect(heldBy(stored, 'viewer')).not.toContain('document.content.edit');
  });
});
