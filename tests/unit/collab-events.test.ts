// What the collaboration server reads of a message on the channel (FR-ED-40,
// NFR-SE-03 (d), NFR-SE-19): a message names a kind and identifiers and nothing
// else, and anything else is not an event. The publishing and the acting are
// tested against Valkey and the real server (tests/integration/collab-events.test.ts).
import { describe, expect, it } from 'vitest';
import { readEvent } from '../../src/lib/collab/events.ts';

const DOCUMENT = 'abcdef12-1111-4111-8111-11111111111a';
const USER = 'k2jH8sd9aLq0Zx3MnB7vC1pQwE4rTyUi';

describe('the events a message holds', () => {
  it('reads each kind of FR-ED-40 that is built, by name', () => {
    expect(readEvent(`{"kind":"document-deleted","documentId":"${DOCUMENT}"}`)).toEqual({
      kind: 'document-deleted',
      documentId: DOCUMENT,
    });
    expect(
      readEvent(`{"kind":"collaborator-changed","documentId":"${DOCUMENT}","userId":"${USER}"}`),
    ).toEqual({
      kind: 'collaborator-changed',
      documentId: DOCUMENT,
      userId: USER,
    });
    expect(readEvent(`{"kind":"session-ended","userId":"${USER}"}`)).toEqual({
      kind: 'session-ended',
      userId: USER,
    });
  });

  it('carries nothing a message holds beyond the fields of its kind', () => {
    const extra = readEvent(
      `{"kind":"collaborator-changed","documentId":"${DOCUMENT}","userId":"${USER}","title":"A title","email":"a@example.com"}`,
    );
    expect(extra).toEqual({ kind: 'collaborator-changed', documentId: DOCUMENT, userId: USER });
    expect(
      Object.keys(readEvent(`{"kind":"session-ended","userId":"${USER}","documentId":"${DOCUMENT}"}`)!),
    ).toEqual(['kind', 'userId']);
  });

  it.each([
    ['not JSON', 'collaborator-changed'],
    ['a number', '7'],
    ['null', 'null'],
    ['an array', '[]'],
    ['a kind of another version', `{"kind":"role-changed","documentId":"${DOCUMENT}","userId":"${USER}"}`],
    ['no kind', `{"documentId":"${DOCUMENT}","userId":"${USER}"}`],
    [
      'a change of a collaborator without its user',
      `{"kind":"collaborator-changed","documentId":"${DOCUMENT}"}`,
    ],
    ['a change of a collaborator without its document', `{"kind":"collaborator-changed","userId":"${USER}"}`],
    ['a session that ended without its user', '{"kind":"session-ended"}'],
    [
      'a document that is not an identifier',
      `{"kind":"collaborator-changed","documentId":"x","userId":"${USER}"}`,
    ],
    [
      'a document written in capitals',
      `{"kind":"collaborator-changed","documentId":"${DOCUMENT.toUpperCase()}","userId":"${USER}"}`,
    ],
    ['a user that is a number', `{"kind":"session-ended","userId":7}`],
    ['a user with a space in it', `{"kind":"session-ended","userId":"a b"}`],
    ['a user with a separator of a key in it', `{"kind":"session-ended","userId":"${DOCUMENT} ${USER}"}`],
    ['a user of 65 characters', `{"kind":"session-ended","userId":"${'a'.repeat(65)}"}`],
    ['an empty user', '{"kind":"session-ended","userId":""}'],
  ])('is no event: %s', (_, message) => {
    expect(readEvent(message)).toBeNull();
  });
});
