// The role select of a collaborator waits for the page like its button does: a choice made before the page is ready
// reaches no handler and is lost when the page takes over (NFR-IC-19). The server's markup is what a person has
// before then, so the select must be `disabled` in it.
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RoleControl } from '../../src/app/(app)/documents/[id]/sharing/collaborator-actions.tsx';

describe('RoleControl before the page is ready', () => {
  it('sends its select and its button disabled', () => {
    const html = renderToString(
      createElement(RoleControl, {
        collaboratorId: 'c1',
        documentId: 'd1',
        name: 'Ada',
        role: 'viewer',
        busy: false,
        onAnswer: () => {},
      }),
    );
    expect(html).toMatch(/<select[^>]*\sdisabled/);
    expect(html).toMatch(/<button[^>]*\sdisabled/);
  });
});
