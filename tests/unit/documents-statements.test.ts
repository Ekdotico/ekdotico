import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEFT_MARKER, LEFT_STATEMENT, RENAMED_STATEMENT } from '../../src/app/(app)/documents.tsx';

const read = (path: string) => readFileSync(path, 'utf8');

describe('the statements of the list of documents', () => {
  const source = read('src/app/(app)/documents.tsx');

  it('say the approved words', () => {
    expect(RENAMED_STATEMENT).toBe('Document renamed.');
    expect(LEFT_STATEMENT).toBe('You left the document. It is no longer in your list of documents.');
  });

  it('keep one status region, present from the first paint, that takes focus', () => {
    expect(source).toContain('<div ref={statement} role="status" tabIndex={-1}>');
    expect(source).toMatch(/if \(said\.count > 0\) statement\.current\?\.focus\(\)/);
    expect(source).toContain('say(RENAMED_STATEMENT)');
  });

  it('read the leave marker once, ignore any other, and remove it', () => {
    expect(LEFT_MARKER).toEqual({ name: 'left', value: '1' });
    expect(source).toMatch(/get\(LEFT_MARKER\.name\) !== LEFT_MARKER\.value\) return;/);
    expect(source).toContain("window.history.replaceState(null, '', window.location.pathname)");
  });

  it('is sent by the Leave confirmation', () => {
    const leave = read('src/app/(app)/documents/[id]/sharing/collaborator-actions.tsx');
    expect(leave).toContain('router.push(`/?${LEFT_MARKER.name}=${LEFT_MARKER.value}`)');
  });
});

describe('the Revoke confirmation', () => {
  const source = read('src/app/(app)/documents/[id]/sharing/sharing-settings.tsx');

  it('uses the approved words', async () => {
    const { REVOKE_STATEMENT } =
      await import('../../src/app/(app)/documents/[id]/sharing/sharing-settings.tsx');
    expect(REVOKE_STATEMENT).toBe('The link in the email stops working. You can invite the person again.');
    expect(source).toContain('title="Revoke invitation"');
    expect(source).toMatch(
      /<Button variant="destructive" pending=\{pending\} onClick=\{confirm\}>\s*Revoke invitation\s*<\/Button>/,
    );
  });

  it('opens on Cancel and the row button only opens the dialog', () => {
    expect(source).toContain('initialFocusRef={revokeCancel}');
    expect(source).toContain('onClick={() => setRevoking({ id: invitation.id, email: invitation.email })}');
  });
});
