// Who may change a role or remove a collaborator (FR-ED-38, FR-ED-44 (b)), as
// the pure rules the routes and the sharing page both ask. Each test names the
// weakening that makes it fail.
import { describe, expect, it } from 'vitest';
import { mayAct, refusalOn, type CollaboratorRole } from '../../src/lib/documents/collaborator-rules.ts';
import { defaultPermissionSet, ROLES, type DocumentRole } from '../../src/lib/documents/permissions.ts';

/** The stored set with the two permissions given to the Editor, as an Owner may (FR-ED-45). */
function given(...cells: ('roles' | 'remove')[]) {
  const set = defaultPermissionSet();
  for (const cell of cells) set[`document.collaborators.${cell}`].editor = true;
  return set;
}

const COLLABORATORS: CollaboratorRole[] = ['editor', 'reviewer', 'viewer'];

describe('the permission to act (FR-ED-44)', () => {
  it('is the Owner’s always, and no one else’s by default', () => {
    const defaults = defaultPermissionSet();
    for (const action of ['roles', 'remove'] as const) {
      expect(mayAct(defaults, 'owner', action)).toBe(true);
      for (const role of ['editor', 'reviewer', 'viewer'] as const) {
        expect(mayAct(defaults, role, action), `${role} ${action}`).toBe(false);
      }
    }
  });

  it('is an Editor’s when the Owner gives it, for that action alone', () => {
    expect(mayAct(given('roles'), 'editor', 'roles')).toBe(true);
    expect(mayAct(given('roles'), 'editor', 'remove')).toBe(false);
    expect(mayAct(given('remove'), 'editor', 'remove')).toBe(true);
    expect(mayAct(given('remove'), 'editor', 'roles')).toBe(false);
  });

  // The cells are "never" for the Reviewer and the Viewer: a stored set that
  // was altered gives them nothing (weakening: read the stored cell for them).
  it('is never a Reviewer’s or a Viewer’s, whatever a stored set says', () => {
    const forged = defaultPermissionSet();
    for (const role of ['reviewer', 'viewer'] as const) {
      forged['document.collaborators.roles'][role] = true;
      forged['document.collaborators.remove'][role] = true;
      expect(mayAct(forged, role, 'roles')).toBe(false);
      expect(mayAct(forged, role, 'remove')).toBe(false);
    }
  });

  it('is nobody’s where the set cannot be read', () => {
    for (const stored of [null, undefined, 'x', [], {}]) {
      expect(mayAct(stored, 'editor', 'roles')).toBe(false);
    }
  });
});

describe('whom an actor may act on (FR-ED-44 (b))', () => {
  // Weakening: drop the `self` rule.
  it('never on oneself, whoever one is', () => {
    for (const actor of ROLES) {
      for (const role of COLLABORATORS) {
        expect(refusalOn(actor, { role, self: true }), `${actor} on oneself as ${role}`).toBe('self');
      }
    }
  });

  // Weakening: let an Editor act on an Editor.
  it('an Editor acts on a Reviewer or a Viewer and never on another Editor', () => {
    expect(refusalOn('editor', { role: 'viewer', self: false })).toBeNull();
    expect(refusalOn('editor', { role: 'reviewer', self: false })).toBeNull();
    expect(refusalOn('editor', { role: 'editor', self: false })).toBe('editor');
  });

  it('the Owner acts on every collaborator, an Editor included', () => {
    for (const role of COLLABORATORS) expect(refusalOn('owner', { role, self: false })).toBeNull();
  });

  // The rule is about the role at that moment, and not about who made the Editor.
  it('no role but the Owner’s acts on an Editor', () => {
    for (const actor of ['editor', 'reviewer', 'viewer'] as DocumentRole[]) {
      expect(refusalOn(actor, { role: 'editor', self: false }), actor).toBe('editor');
    }
  });
});
