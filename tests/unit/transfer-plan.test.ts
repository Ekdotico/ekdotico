// What the transfer of all documents decides without a database (FR-AU-92, FR-AU-91, FR-ED-47; docs/plan/slice-24.md):
// the longest-standing Editor, the plan for each document, the fixed texts, and the email, verbatim. The rest is in
// tests/integration/transfer*.test.ts. Each test of a rule names the weakening that makes it fail (section 9 of the plan).
import { describe, expect, it, vi } from 'vitest';
import {
  longestStanding,
  offersCounted,
  offeredIds,
  planTransfer,
  type PlanDocument,
} from '../../src/lib/account/transfer.ts';
import {
  confirmation,
  confirmControl,
  offeredStatement,
  OPTION_LONGEST,
  OPTION_PERSON,
  TRANSFER_MESSAGES,
} from '../../src/lib/account/transfer-texts.ts';
import { chosenPerson } from '../../src/lib/account/transfer-choice.ts';

const ORIGIN = 'https://app.example.test';
const NOW = new Date('2026-10-28T12:00:00Z');
const at = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);

const editor = (userId: string, since: number, added = since) => ({
  userId,
  roleSince: at(since),
  addedAt: at(added),
});

function document(over: Partial<PlanDocument> = {}): PlanDocument {
  return {
    id: 'd1',
    deleted: false,
    claimed: false,
    clearingAt: null,
    transferable: true,
    pending: null,
    editors: [editor('b', 10)],
    passedOver: new Set(),
    ...over,
  };
}

describe('the longest-standing Editor (FR-AU-92 (a))', () => {
  // Mutation P01: the sort is by the time the collaboration began, not by the time the role was granted.
  it('is the one who has held the role longest, counted from the time the current role was granted', () => {
    expect(longestStanding([editor('a', 5, 100), editor('b', 50, 60), editor('c', 20, 200)])).toBe('b');
  });

  // Mutation P02: the tie falls to the user identifier before the time of the collaboration.
  it('settles an equal tie by the collaboration that began first, and then by the identifier that sorts first', () => {
    expect(longestStanding([editor('a', 10, 30), editor('b', 10, 90), editor('c', 10, 60)])).toBe('b');
    expect(longestStanding([editor('z', 10, 30), editor('m', 10, 30), editor('q', 10, 30)])).toBe('m');
  });

  // Mutation P03: a former Owner is counted from the time they were first a collaborator.
  it('counts a former Owner from the time of the transfer, which is the roleSince the acceptance writes', () => {
    // 'former' collaborated for years before, but became an Editor 2 days ago by a transfer: 'b' is longer standing.
    expect(longestStanding([editor('former', 2, 400), editor('b', 10, 10)])).toBe('b');
  });

  it('is nobody where there is no Editor', () => {
    expect(longestStanding([])).toBeNull();
  });
});

describe('the plan for each document', () => {
  // Mutation P04: the deleted document is offered.
  it('skips a deleted document, with its reason, whatever the choice', () => {
    const plan = planTransfer([document({ deleted: true })], { mode: 'longest' }, NOW);
    expect(plan.get('d1')).toEqual({ kind: 'skip', reason: 'deleted' });
    expect(
      planTransfer([document({ deleted: true })], { mode: 'person', userId: 'b' }, NOW).get('d1'),
    ).toEqual({ kind: 'skip', reason: 'deleted' });
  });

  // Mutation P05: the day of a clearing is not looked at; P06: the claim is not.
  it('skips a document whose clearing day has come or that the timer has claimed, and offers one that waits for it', () => {
    const day = (ms: number) => new Date(NOW.getTime() + ms);
    expect(planTransfer([document({ clearingAt: day(-1) })], { mode: 'longest' }, NOW).get('d1')).toEqual({
      kind: 'skip',
      reason: 'being_deleted',
    });
    expect(planTransfer([document({ clearingAt: day(0) })], { mode: 'longest' }, NOW).get('d1')).toEqual({
      kind: 'skip',
      reason: 'being_deleted',
    });
    expect(
      planTransfer([document({ clearingAt: day(86_400_000), claimed: true })], { mode: 'longest' }, NOW).get(
        'd1',
      ),
    ).toEqual({ kind: 'skip', reason: 'being_deleted' });
    expect(
      planTransfer([document({ clearingAt: day(86_400_000) })], { mode: 'longest' }, NOW).get('d1'),
    ).toEqual({
      kind: 'offer',
      toUserId: 'b',
    });
  });

  // Mutation P07: a recorded document or one outside a personal workspace is offered.
  it('skips what FR-ED-47 does not cover', () => {
    expect(planTransfer([document({ transferable: false })], { mode: 'longest' }, NOW).get('d1')).toEqual({
      kind: 'skip',
      reason: 'not_transferable',
    });
  });

  // Mutation P08: a pending offer is replaced.
  it('keeps a pending offer, counts it as offered, and offers nothing else, whatever the choice', () => {
    const pending = document({ pending: { toUserId: 'x' } });
    for (const choice of [{ mode: 'longest' }, { mode: 'person', userId: 'b' }] as const) {
      const plan = planTransfer([pending], choice, NOW);
      expect(plan.get('d1')).toEqual({ kind: 'keep' });
      expect(offeredIds(plan)).toEqual(['d1']);
    }
  });

  // Mutation P09: the Editor who declined is offered again.
  it('passes over an Editor who declined or let an offer expire, and offers the next', () => {
    const doc = document({
      editors: [editor('b', 50), editor('c', 10)],
      passedOver: new Set(['b']),
    });
    expect(planTransfer([doc], { mode: 'longest' }, NOW).get('d1')).toEqual({ kind: 'offer', toUserId: 'c' });
    const last = document({ editors: [editor('b', 50)], passedOver: new Set(['b']) });
    expect(planTransfer([last], { mode: 'longest' }, NOW).get('d1')).toEqual({
      kind: 'skip',
      reason: 'no_other_editor',
    });
  });

  // Mutation P10: "To one person" also passes the person over.
  it('offers a person they have declined once, when the user chooses them', () => {
    const doc = document({ editors: [editor('b', 50)], passedOver: new Set(['b']) });
    expect(planTransfer([doc], { mode: 'person', userId: 'b' }, NOW).get('d1')).toEqual({
      kind: 'offer',
      toUserId: 'b',
    });
  });

  // Mutation P11: the document with no Editor is given an offer to someone else.
  it('has no offer for a document without an Editor, and for one the chosen person does not edit', () => {
    expect(planTransfer([document({ editors: [] })], { mode: 'longest' }, NOW).get('d1')).toEqual({
      kind: 'skip',
      reason: 'no_editor',
    });
    expect(planTransfer([document()], { mode: 'person', userId: 'someone-else' }, NOW).get('d1')).toEqual({
      kind: 'skip',
      reason: 'not_their_editor',
    });
  });

  // Mutation P12: "To one person" offers every document.
  it('offers a person only the documents they edit', () => {
    const documents = [
      document({ id: 'd1', editors: [editor('b', 10), editor('c', 5)] }),
      document({ id: 'd2', editors: [editor('c', 5)] }),
      document({ id: 'd3', editors: [editor('b', 1)] }),
    ];
    const plan = planTransfer(documents, { mode: 'person', userId: 'b' }, NOW);
    expect([...plan].filter(([, o]) => o.kind === 'offer').map(([id]) => id)).toEqual(['d1', 'd3']);
    expect(offeredIds(plan)).toEqual(['d1', 'd3']);
  });

  it('chooses the longest-standing Editor of each document separately', () => {
    const documents = [
      document({ id: 'd1', editors: [editor('b', 10), editor('c', 5)] }),
      document({ id: 'd2', editors: [editor('b', 1), editor('c', 5)] }),
    ];
    const plan = planTransfer(documents, { mode: 'longest' }, NOW);
    expect(plan.get('d1')).toEqual({ kind: 'offer', toUserId: 'b' });
    expect(plan.get('d2')).toEqual({ kind: 'offer', toUserId: 'c' });
  });
});

describe('the texts', () => {
  it('names the two options as FR-AU-92 does', () => {
    expect(OPTION_LONGEST).toBe('To the longest-standing Editor');
    expect(OPTION_PERSON).toBe('To one person');
  });

  it('names the number offered and the number that cannot be, in the singular and the plural', () => {
    expect(confirmation({ mode: 'longest', personName: null, offered: 3, kept: 0, cannot: 1 })).toEqual([
      'You are offering the ownership of 3 documents, each to its longest-standing Editor.',
      '1 document cannot be offered. The list on the page says why.',
    ]);
    expect(confirmation({ mode: 'person', personName: 'Ada', offered: 1, kept: 0, cannot: 2 })).toEqual([
      'You are offering the ownership of 1 document to Ada.',
      '2 documents cannot be offered. The list on the page says why.',
    ]);
    expect(confirmControl(1)).toBe('Offer 1 document');
    expect(confirmControl(5)).toBe('Offer 5 documents');
    expect(offeredStatement({ offered: 2, kept: 1 })).toBe(
      'Ownership of 2 documents offered. Each Editor has been told by a notification and by email. 1 document already had an offer, which stands.',
    );
  });

  // Mutation I4 (review of pull request 64, item 4): the documents that already have an offer are counted in "to [name]".
  it('says the documents that already have an offer apart from the new offers, and makes none of them a new one', () => {
    expect(confirmation({ mode: 'person', personName: 'Ada', offered: 2, kept: 3, cannot: 0 })).toEqual([
      'You are offering the ownership of 2 documents to Ada.',
      '3 documents already have an offer, which stands.',
    ]);
    expect(confirmation({ mode: 'longest', personName: null, offered: 0, kept: 1, cannot: 0 })).toEqual([
      'No new offer can be made in this way.',
      '1 document already has an offer, which stands.',
    ]);
    expect(offeredStatement({ offered: 0, kept: 2 })).toBe(
      'No new offer was made. 2 documents already had an offer, which stands.',
    );
  });

  // Mutation I5: "To one person" with nobody chosen is worded as a choice made.
  it('asks for a person where none is chosen, and puts none in the place of one who has left', () => {
    expect(confirmation({ mode: 'person', personName: null, offered: 0, kept: 0, cannot: 0 })).toEqual([
      'Choose a person to see how many documents can be offered to them.',
    ]);
    const people = [{ collaboratorId: 'a' }, { collaboratorId: 'b' }];
    expect(chosenPerson(people, 'b')).toBe(people[1]);
    expect(chosenPerson(people, '')).toBeUndefined();
    expect(chosenPerson(people, 'gone')).toBeUndefined();
    expect(chosenPerson([], 'a')).toBeUndefined();
  });

  // Mutation L1 (item 9): the rule of the count is spread over the places that use it.
  it('counts, as built, one offer of the limit for each new offer, whoever it is made to', () => {
    expect(offersCounted([])).toBe(0);
    expect(offersCounted([{ toUserId: 'a' }, { toUserId: 'a' }, { toUserId: 'b' }])).toBe(3);
  });

  it('words the refusal over the limit with the shared allowance and the hour it is counted over', () => {
    const text = TRANSFER_MESSAGES.overLimit(20, 25);
    expect(text).toContain('at most 20 offers of ownership in any hour, counted over the last hour');
    expect(text).toContain('offers made one by one from the sharing pages use the same allowance');
    expect(text).toContain('This would make 25.');
    expect(TRANSFER_MESSAGES.changed).not.toMatch(/reload/i);
    expect(TRANSFER_MESSAGES.noSuchPerson).not.toMatch(/reload/i);
  });

  // Mutation P13: the subject or the text is reworded.
  it('writes the email of FR-AU-92 verbatim, and names no document', async () => {
    vi.resetModules();
    vi.doMock('../../src/lib/settings.ts', () => ({ settings: () => ({ appOrigin: ORIGIN }) }));
    const { batchOfferEmail } = await import('../../src/lib/account/transfer-email.ts');
    const message = batchOfferEmail('ed@example.com', 'Grace', 3, new Date(Date.UTC(2026, 10, 11, 9, 30)));
    vi.doUnmock('../../src/lib/settings.ts');
    expect(message.to).toBe('ed@example.com');
    expect(message.subject).toBe('An offer of ownership of 3 documents in Ekdotico');
    expect(message.text).toBe(
      `Grace has offered you ownership of 3 documents that you edit in Ekdotico. To accept or decline each one, open your notifications in Ekdotico: ${ORIGIN}/notifications. The offers are open until 11 Nov 2026, 09:30 UTC. For each one you accept, you become the Owner of the document and Grace becomes an Editor.`,
    );
    expect(message.text).not.toMatch(/\/documents\//);
  });
});
