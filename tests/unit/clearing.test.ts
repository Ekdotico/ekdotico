// What a clearing says and holds that needs no database (FR-AU-91, FR-ED-40 (i), FR-ED-42; docs/plan/slice-23.md):
// the fixed texts, verbatim; the email; the notice of the role with its day; the event on the channel; and what the
// editor's connection makes of a notice. The rest is in tests/integration/clearing*.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DocumentConnection } from '../../src/lib/collab/client.ts';
import { readEvent } from '../../src/lib/collab/events.ts';
import { readRoleNotice, roleNotice } from '../../src/lib/collab/protocol.ts';
import {
  CLEAR_ALL,
  CLEARING_ENDED,
  CLEARING_NOW,
  clearingStatement,
  cleared,
  confirmation,
  confirmControl,
} from '../../src/lib/clearing/texts.ts';
import { clearingRefusal } from '../../src/lib/clearing/period.ts';

const ORIGIN = 'https://app.example.test';
const DOCUMENT = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';

describe('the fixed texts of FR-AU-91, verbatim', () => {
  it('names the control and the control of the confirmation as the requirement does', () => {
    expect(CLEAR_ALL).toBe('Clear all documents');
    expect(confirmControl(12)).toBe('Delete 12 documents permanently');
    // The requirement has no singular; this application writes one (docs/plan/slice-23.md, S23-9).
    expect(confirmControl(1)).toBe('Delete 1 document permanently');
  });

  it('says in the editor what the requirement says in place of the editing controls', () => {
    expect(CLEARING_NOW('2 Nov 2026, 14:05')).toBe(
      'This document will be deleted on 2 Nov 2026, 14:05. You can read it and take a draft export. It cannot be edited.',
    );
  });

  // Mutation V17: the editor says "will be deleted on" of a document that its Owner had deleted already (or the other way round).
  it('says of a document deleted before the clearing that it was, and of a live one that it will be (S23-1; words proposed, owed to the owner)', () => {
    const day = '2 Nov 2026, 14:05';
    expect(clearingStatement(true, day)).toBe(
      'This document was deleted by its Owner and will be deleted permanently on 2 Nov 2026, 14:05. You can read it and take a draft export. It cannot be edited.',
    );
    expect(clearingStatement(false, day)).toBe(CLEARING_NOW(day));
  });

  async function email(documents: number, day: Date) {
    vi.resetModules();
    vi.doMock('../../src/lib/settings.ts', () => ({ settings: () => ({ appOrigin: ORIGIN }) }));
    const { clearingEmail } = await import('../../src/lib/clearing/email.ts');
    return clearingEmail('reader@example.com', documents, day);
  }
  afterEach(() => vi.doUnmock('../../src/lib/settings.ts'));

  // Mutation T01: the email names a document, or a title, or leaves its link out.
  it('has the subject and the text of the email, with the number, the day in UTC, and the notifications as the link', async () => {
    const { to, subject, text } = await email(3, new Date(Date.UTC(2026, 10, 2, 14, 5, 59)));
    expect(to).toBe('reader@example.com');
    expect(subject).toBe('Documents you have access to in Ekdotico will be deleted');
    expect(text).toBe(
      `The Owner of 3 documents that you have access to in Ekdotico will delete them on 2 Nov 2026, 14:05 UTC. Until then you can open each one and take a draft export of it. Your notifications in Ekdotico name them:\n${ORIGIN}/notifications`,
    );
    expect(text).not.toMatch(/\/documents\//);
    expect(subject).not.toMatch(/[\r\n]/);
  });

  it('writes the same sentences for one document', async () => {
    const { text } = await email(1, new Date(Date.UTC(2026, 10, 2, 14, 5)));
    expect(text).toBe(
      `The Owner of 1 document that you have access to in Ekdotico will delete it on 2 Nov 2026, 14:05 UTC. Until then you can open it and take a draft export of it. Your notifications in Ekdotico name it:\n${ORIGIN}/notifications`,
    );
  });
});

describe('the confirmation names what FR-AU-91 asks it to name', () => {
  const lines = (over: Partial<Parameters<typeof confirmation>[0]> = {}) =>
    confirmation({
      documents: 5,
      shared: 2,
      people: 4,
      day: '2 Nov 2026, 14:05',
      noticeDays: 7,
      accountWaits: true,
      ...over,
    });

  it('names the number, how many are shared and with how many people, the day, and the rest', () => {
    expect(lines()).toEqual([
      'This deletes 5 documents permanently.',
      '2 of them are shared, with 4 people in all.',
      'A document that is not shared is deleted at once.',
      'The shared ones are deleted on 2 Nov 2026, 14:05, 7 days from now, after their collaborators have been told.',
      'No document can be restored once it is deleted.',
      'The account cannot be deleted before 2 Nov 2026, 14:05.',
      'You can take a copy of a document first by draft export.',
      'Clearing does not delete the account. If you keep it, it has no documents until you create one.',
    ]);
  });

  it('says nothing of a day where nothing is shared, and nothing of "at once" where everything is', () => {
    const none = lines({ shared: 0, people: 0, day: null }).join(' ');
    expect(none).toContain('None of them is shared.');
    expect(none).not.toContain('cannot be deleted before');
    expect(none).not.toContain('collaborators');
    const all = lines({ documents: 2, shared: 2 }).join(' ');
    expect(all).not.toContain('is deleted at once');
  });

  // Mutation H01: the confirmation of the deleted documents alone says that the account cannot be deleted before the day.
  it('does not say that the account waits where the others it owns stay (the deleted documents alone)', () => {
    expect(lines({ accountWaits: false }).join(' ')).not.toContain('The account cannot be deleted before');
    expect(lines({ accountWaits: true }).join(' ')).toContain('The account cannot be deleted before');
  });

  it('is written for one document and one person', () => {
    expect(lines({ documents: 1, shared: 1, people: 1 })).toEqual([
      'This deletes 1 document permanently.',
      'It is shared, with 1 person in all.',
      'The shared document is deleted on 2 Nov 2026, 14:05, 7 days from now, after its collaborators have been told.',
      'No document can be restored once it is deleted.',
      'The account cannot be deleted before 2 Nov 2026, 14:05.',
      'You can take a copy of a document first by draft export.',
      'Clearing does not delete the account. If you keep it, it has no documents until you create one.',
    ]);
    expect(lines({ documents: 1, shared: 0, people: 0, day: null })[1]).toBe('It is not shared.');
  });

  it('tells after the confirmation what is deleted now and what waits', () => {
    expect(cleared({ documents: 3, shared: 1, day: '2 Nov 2026, 14:05' })).toBe(
      '2 documents are being deleted now. Ekdotico completes the deletion without you. 1 document will be deleted on 2 Nov 2026, 14:05. Its collaborators have been told.',
    );
    expect(cleared({ documents: 2, shared: 0, day: null })).toBe(
      '2 documents are being deleted now. Ekdotico completes the deletion without you.',
    );
  });

  it('says in the editor that the document will not be deleted, and whether it can be edited again', () => {
    expect(CLEARING_ENDED(true)).toBe(
      'This document will not be deleted. It can be edited in this tab again.',
    );
    expect(CLEARING_ENDED(false)).toBe('This document will not be deleted.');
  });
});

describe('the answer of a route to a request that would change a document in a clearing', () => {
  // Mutation T02: the answer is a 403 or a 404, or names no day.
  it('is a 409 that names the day and says what was not done', async () => {
    const day = new Date(Date.UTC(2026, 10, 2, 14, 5));
    for (const [change, ending] of [
      ['change', 'Nothing was changed.'],
      ['invite', 'No invitation was created.'],
      ['delete', 'The document was not deleted.'],
      ['restore', 'The document was not restored.'],
    ] as const) {
      const response = clearingRefusal(day, change);
      expect(response.status).toBe(409);
      const { error } = (await response.json()) as { error: { code: string; message: string } };
      expect(error.code).toBe('clearing');
      expect(error.message).toContain('will be deleted on 2 Nov 2026, 14:05 UTC');
      expect(error.message).toContain(ending);
    }
  });
});

describe('the notice of the role carries the day (FR-ED-40 (i))', () => {
  const DAY = '2026-11-02T14:05:00.000Z';

  it('is written with the day where there is one, and without where there is none', () => {
    expect(roleNotice({ role: 'editor', canEdit: false, deletedOn: DAY })).toBe(
      `{"kind":"role","role":"editor","canEdit":false,"deletedOn":"${DAY}"}`,
    );
    expect(roleNotice({ role: 'editor', canEdit: true })).toBe(
      '{"kind":"role","role":"editor","canEdit":true}',
    );
  });

  it('is read field by field, and a day that is not a time is no notice', () => {
    expect(readRoleNotice(roleNotice({ role: 'owner', canEdit: false, deletedOn: DAY }))).toEqual({
      role: 'owner',
      canEdit: false,
      deletedOn: DAY,
    });
    expect(readRoleNotice('{"kind":"role","role":"owner","canEdit":true}')).toEqual({
      role: 'owner',
      canEdit: true,
    });
    for (const deletedOn of [
      'tomorrow',
      '2026-11-02',
      7,
      null,
      '2026-11-02T14:05:00Z',
      '9999-99-99T99:99:99.999Z',
    ]) {
      expect(
        readRoleNotice(JSON.stringify({ kind: 'role', role: 'owner', canEdit: false, deletedOn })),
        String(deletedOn),
      ).toBeNull();
    }
    expect(
      readRoleNotice(`{"kind":"role","role":"owner","canEdit":false,"deletedOn":"${DAY}","x":1}`),
    ).toBeNull();
  });
});

describe('the event on the channel (FR-ED-40 (i))', () => {
  // Mutation T03: `readEvent` does not know the kind (and the server never looks).
  it('is read for a document and for nothing else', () => {
    expect(readEvent(JSON.stringify({ kind: 'clearing-changed', documentId: DOCUMENT }))).toEqual({
      kind: 'clearing-changed',
      documentId: DOCUMENT,
    });
    expect(readEvent(JSON.stringify({ kind: 'clearing-changed' }))).toBeNull();
    expect(
      readEvent(JSON.stringify({ kind: 'clearing-changed', documentId: 'not an identifier' })),
    ).toBeNull();
    // Only the document is read: whatever else a message carries goes no further.
    expect(
      readEvent(
        JSON.stringify({ kind: 'clearing-changed', documentId: DOCUMENT, userId: 'x', title: 'secret' }),
      ),
    ).toEqual({ kind: 'clearing-changed', documentId: DOCUMENT });
  });
});

describe('what the editor’s connection makes of a notice with a day', () => {
  /** The connection, told what the server says, with nothing opened: the state is all it keeps of it. */
  function connection(deletedOn?: string | null) {
    const made = new DocumentConnection({
      url: 'ws://localhost/collab',
      documentId: DOCUMENT,
      errorAfterMs: 30_000,
      probe: async () => 200,
      deletedOn,
    });
    const told = (text: string) => (made as unknown as { told: (payload: string) => void }).told(text);
    return { made, told };
  }
  const DAY = '2026-11-02T14:05:00.000Z';

  // Mutation T04: the day is not kept, or kept only when the role changed.
  it('keeps the day, also for a connection that could not edit before, and says when it goes', () => {
    const { made, told } = connection(null);
    expect(made.getState().deletedOn).toBeUndefined();
    // A Viewer: read-only already, so the notice changes nothing of what it may do, and is still kept.
    told(roleNotice({ role: 'viewer', canEdit: false }));
    told(roleNotice({ role: 'viewer', canEdit: false, deletedOn: DAY }));
    expect(made.getState().deletedOn).toBe(DAY);
    expect(made.getState().clearingEnded).toBe(false);
    // The clearing is cancelled: no day, and the tab is told that it ended.
    told(roleNotice({ role: 'viewer', canEdit: false }));
    expect(made.getState().deletedOn).toBeNull();
    expect(made.getState().clearingEnded).toBe(true);
    // And a later notice of an ordinary change of role does not say it again.
    told(roleNotice({ role: 'editor', canEdit: true }));
    expect(made.getState().clearingEnded).toBe(false);
  });

  it('knows the day the page was opened with, so that a cancellation is told to a tab opened in the period', () => {
    const { made, told } = connection(DAY);
    told(roleNotice({ role: 'editor', canEdit: true }));
    expect(made.getState()).toMatchObject({ deletedOn: null, clearingEnded: true, canEdit: true });
  });

  it('is told the day to a tab that could edit, with the notice of its role', () => {
    const { made, told } = connection(null);
    told(roleNotice({ role: 'editor', canEdit: true }));
    told(roleNotice({ role: 'editor', canEdit: false, deletedOn: DAY }));
    expect(made.getState()).toMatchObject({
      deletedOn: DAY,
      canEdit: false,
      notice: { role: 'editor', canEdit: false },
    });
  });
});
