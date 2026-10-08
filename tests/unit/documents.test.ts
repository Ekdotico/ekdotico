// The permission set of a document as data (FR-ED-44, FR-ED-45), the one
// function that reads it, and the rule of a title (FR-ED-35). No database:
// the routes are tested against one in tests/integration/documents.test.ts.
import { describe, expect, it } from 'vitest';
import { DEFAULT_TITLE, readTitle } from '../../src/lib/documents/documents.ts';
import {
  defaultPermissionSet,
  holds,
  PERMISSIONS,
  ROLES,
  type Cell,
  type DocumentRole,
  type Permission,
  type PermissionSet,
} from '../../src/lib/documents/permissions.ts';

// The table of FR-ED-44, copied from srs/2-functional-requirements/2.2.06-fr-ed.md
// at Docs commit f4ec614, every character of it. When the requirement changes,
// this copy is replaced by the new table, and the data follows.
const TABLE = `
| Permission | Identifier | Kind | Owner | Editor | Reviewer | Viewer |
| --- | --- | --- | --- | --- | --- | --- |
| View the document's content, its comment threads included (FR-ED-29) | \`document.view\` | Fixed by role | ✓ | ✓ | ✓ | ✓ |
| Edit the document's content, which includes adding and changing images and footnotes (FR-ED-01) | \`document.content.edit\` | Fixed by role | ✓ | ✓ | never | never |
| Create comment threads, reply to them, and resolve one's own thread (FR-ED-25 to FR-ED-27) | \`document.comments.write\` | Fixed by role | ✓ | ✓ | ✓ | never |
| Resolve and reopen any comment thread (FR-ED-27) | \`document.comments.resolve\` | Adjustable | ✓ | on | off | never |
| See the list of collaborators and their roles | \`document.collaborators.view\` | Adjustable | ✓ | on | on | on |
| Rename the document (FR-ED-35) | \`document.rename\` | Adjustable | ✓ | off | never | never |
| Draft export (FR-EX-01) | \`document.export.draft\` | Adjustable | ✓ | on | off | off |
| Invite collaborators, send an invitation again, revoke a pending invitation, and see the pending invitations (FR-ED-21, FR-ED-37) | \`document.collaborators.invite\` | Adjustable | ✓ | off | never | never |
| Change a collaborator's role (FR-ED-38) | \`document.collaborators.roles\` | Adjustable | ✓ | off | never | never |
| Remove a collaborator (FR-ED-38) | \`document.collaborators.remove\` | Adjustable | ✓ | off | never | never |
| Leave the document (FR-ED-38) | \`document.leave\` | Fixed by role | — | ✓ | ✓ | ✓ |
| Change the document's permission set (FR-ED-45) | \`document.permissions.edit\` | Fixed to the Owner | ✓ | never | never | never |
| Transfer ownership of the document (FR-ED-47) | \`document.ownership.transfer\` | Fixed to the Owner | ✓ | never | never | never |
| Delete the document, and restore it within its retention (FR-ED-36) | \`document.delete\` | Fixed to the Owner | ✓ | never | never | never |
| Initiate a provenance-sealed export, and the Revise and Branch actions that follow one (FR-EX-01, FR-EX-34) | \`document.export.sealed\` | Fixed to the Owner | ✓ | never | never | never |
`;

const KINDS: Record<string, string> = {
  'Fixed by role': 'fixed_by_role',
  Adjustable: 'adjustable',
  'Fixed to the Owner': 'fixed_to_owner',
};
const CELLS: Record<string, Cell> = { '✓': 'yes', '—': 'no', never: 'never', on: 'on', off: 'off' };

/** The rows of the table, read as the requirement prints them. */
const printed = TABLE.trim()
  .split('\n')
  .slice(2)
  .map((line) => {
    const [, , identifier, kind, owner, editor, reviewer, viewer] = line
      .split('|')
      .map((cell) => cell.trim());
    const cell = (text: string | undefined) => {
      expect(Object.keys(CELLS)).toContain(text);
      return CELLS[text!]!;
    };
    expect(Object.keys(KINDS)).toContain(kind);
    return [
      identifier!.replaceAll('`', ''),
      {
        kind: KINDS[kind!],
        owner: cell(owner),
        editor: cell(editor),
        reviewer: cell(reviewer),
        viewer: cell(viewer),
      },
    ] as const;
  });

const permissions = Object.keys(PERMISSIONS) as Permission[];
const everyCell = permissions.flatMap((permission) => ROLES.map((role) => [permission, role] as const));
/** The cells the Owner of a document may change (FR-ED-45): adjustable, and not "never". */
const adjustable = (permission: Permission, role: DocumentRole) =>
  ['on', 'off'].includes(PERMISSIONS[permission][role]);

/** A stored set with every cell the same. */
const allSet = (value: unknown) =>
  Object.fromEntries(
    permissions.map((permission) => [permission, Object.fromEntries(ROLES.map((role) => [role, value]))]),
  );

describe('the table of permissions (FR-ED-44)', () => {
  it('is the table of the requirement: every row, in its order, every cell', () => {
    expect(printed).toHaveLength(15);
    expect(Object.keys(PERMISSIONS)).toEqual(printed.map(([identifier]) => identifier));
    expect(PERMISSIONS).toEqual(Object.fromEntries(printed));
  });

  it('has the four roles of FR-ED-19', () => {
    expect(ROLES).toEqual(['owner', 'editor', 'reviewer', 'viewer']);
  });

  it('gives the Owner every permission apart from leaving, on every row', () => {
    for (const permission of permissions) {
      expect(PERMISSIONS[permission].owner).toBe(permission === 'document.leave' ? 'no' : 'yes');
    }
  });

  it('lets only an adjustable row hold a cell that can be changed', () => {
    for (const [permission, role] of everyCell) {
      if (adjustable(permission, role)) {
        expect(PERMISSIONS[permission].kind).toBe('adjustable');
        expect(role).not.toBe('owner');
      }
    }
  });
});

describe('the set of a new document (FR-ED-45)', () => {
  const set = defaultPermissionSet();

  it('is whole: every permission for every role, the Reviewer column and the comment rows included', () => {
    expect(Object.keys(set)).toEqual(permissions);
    for (const permission of permissions) expect(Object.keys(set[permission])).toEqual([...ROLES]);
    expect(set['document.comments.write'].reviewer).toBe(true);
    expect(set['document.comments.resolve']).toEqual({
      owner: true,
      editor: true,
      reviewer: false,
      viewer: false,
    });
  });

  it('holds the defaults of the table: a tick and "on" are held, a dash, "off" and "never" are not', () => {
    for (const [permission, role] of everyCell) {
      expect(set[permission][role]).toBe(['yes', 'on'].includes(PERMISSIONS[permission][role]));
    }
    // The cells this slice rests on, written out.
    expect(set['document.rename']).toEqual({ owner: true, editor: false, reviewer: false, viewer: false });
    expect(set['document.view']).toEqual({ owner: true, editor: true, reviewer: true, viewer: true });
    expect(set['document.leave']).toEqual({ owner: false, editor: true, reviewer: true, viewer: true });
  });

  it('is a new object each time, so that one document’s set is never another’s', () => {
    const other = defaultPermissionSet();
    other['document.rename'].editor = true;
    expect(defaultPermissionSet()['document.rename'].editor).toBe(false);
  });

  it('survives being stored as JSON', () => {
    expect(JSON.parse(JSON.stringify(set))).toEqual(set);
  });
});

describe('whether a role holds a permission (FR-ED-44, FR-ED-39)', () => {
  it.each(everyCell)('%s for the %s follows the table under the defaults', (permission, role) => {
    expect(holds(defaultPermissionSet(), role, permission)).toBe(
      ['yes', 'on'].includes(PERMISSIONS[permission][role]),
    );
  });

  it('reads a cell the Owner may change from the stored set', () => {
    for (const [permission, role] of everyCell.filter(([permission, role]) => adjustable(permission, role))) {
      expect(holds(allSet(true), role, permission)).toBe(true);
      expect(holds(allSet(false), role, permission)).toBe(false);
    }
    // The same request succeeds once the Owner has given the role the permission (FR-ED-39).
    const set: PermissionSet = defaultPermissionSet();
    expect(holds(set, 'editor', 'document.rename')).toBe(false);
    set['document.rename'].editor = true;
    expect(holds(set, 'editor', 'document.rename')).toBe(true);
  });

  it('never reads a fixed cell, a "never" cell, or a cell of the Owner from the stored set', () => {
    const fixed = everyCell.filter(([permission, role]) => !adjustable(permission, role));
    expect(fixed.length).toBeGreaterThan(30);
    for (const [permission, role] of fixed) {
      const table = PERMISSIONS[permission][role] === 'yes';
      // A stored set that gives everything gives nothing the table fixes…
      expect(holds(allSet(true), role, permission)).toBe(table);
      // …and one that takes everything takes nothing the table fixes.
      expect(holds(allSet(false), role, permission)).toBe(table);
      expect(holds(null, role, permission)).toBe(table);
    }
    // Written out: the cells whose change would matter most.
    expect(holds(allSet(true), 'viewer', 'document.content.edit')).toBe(false);
    expect(holds(allSet(true), 'editor', 'document.permissions.edit')).toBe(false);
    expect(holds(allSet(true), 'editor', 'document.delete')).toBe(false);
    expect(holds(allSet(true), 'viewer', 'document.rename')).toBe(false);
    expect(holds(allSet(true), 'owner', 'document.leave')).toBe(false);
    expect(holds(allSet(false), 'owner', 'document.rename')).toBe(true);
    expect(holds(allSet(false), 'owner', 'document.view')).toBe(true);
  });

  it('refuses an adjustable cell where the stored set cannot be read, or holds anything but true', () => {
    const cells = everyCell.filter(([permission, role]) => adjustable(permission, role));
    for (const stored of [
      null,
      undefined,
      'a set',
      7,
      [],
      {},
      allSet('true'),
      allSet(1),
      allSet(null),
      Object.fromEntries(permissions.map((permission) => [permission, null])),
      Object.fromEntries(permissions.map((permission) => [permission, true])),
    ]) {
      for (const [permission, role] of cells) expect(holds(stored, role, permission)).toBe(false);
    }
  });

  it('holds nothing for a permission or a role that is not in the table', () => {
    const everything = allSet(true);
    for (const permission of ['document.everything', '', 'constructor', '__proto__', 'toString']) {
      for (const role of ROLES) expect(holds(everything, role, permission as Permission)).toBe(false);
    }
    for (const role of ['admin', '', 'OWNER', 'constructor', '__proto__']) {
      for (const permission of permissions)
        expect(holds(everything, role as DocumentRole, permission)).toBe(false);
    }
  });
});

describe('the rule of a title (FR-ED-35, NFR-SE-08, NFR-I18-03)', () => {
  it('stores a title as written: markup, quotation marks, direction marks, and emoji', () => {
    for (const title of [
      '<script>alert(1)</script>',
      `"double" 'single' \`back\` & <b>bold</b>`,
      '‮right to left‬ ‏ mark',
      'Ελληνικά, 中文, العربية, 😀 👩‍👩‍👧‍👦',
      '  spaces kept at both ends  ',
      'a\tb\nc',
    ]) {
      expect(readTitle(title)).toEqual({ ok: true, title });
    }
  });

  it('admits 200 characters and refuses 201, counting a character as one code point', () => {
    expect(readTitle('a'.repeat(200))).toEqual({ ok: true, title: 'a'.repeat(200) });
    expect(readTitle('a'.repeat(201))).toEqual({ ok: false, reason: 'too_long' });
    // An emoji outside the Basic Multilingual Plane is two UTF-16 units and one character.
    expect('😀'.length).toBe(2);
    expect(readTitle('😀'.repeat(200))).toEqual({ ok: true, title: '😀'.repeat(200) });
    expect(readTitle('😀'.repeat(201))).toEqual({ ok: false, reason: 'too_long' });
    expect(readTitle(' '.repeat(201))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('stores an empty title as the default, and a title of white space alone', () => {
    expect(DEFAULT_TITLE).toBe('Untitled document');
    for (const title of ['', ' ', '   ', '\t\n', ' ']) {
      expect(readTitle(title)).toEqual({ ok: true, title: 'Untitled document' });
    }
  });

  it('refuses what is not text', () => {
    for (const value of [undefined, null, 7, true, ['a'], { title: 'a' }]) {
      expect(readTitle(value)).toEqual({ ok: false, reason: 'not_text' });
    }
  });

  it('refuses what PostgreSQL cannot store, and removes nothing', () => {
    expect(readTitle('a\u0000b')).toEqual({ ok: false, reason: 'not_storable' });
    expect(readTitle('half \ud83d of a pair')).toEqual({ ok: false, reason: 'not_storable' });
  });
});
