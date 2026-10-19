// The data of the row of the people present, and the limit on presence messages
// (FR-ED-17; register rows S14-1, S14-5, S14-6, F14-1; docs/plan/presence-row.md):
// the limiter, the letters of a picture, and the message that tells who is present.
import { describe, expect, it } from 'vitest';
import { AWARENESS_PER_SECOND, AwarenessRate, COLLABORATOR_COLOURS } from '../../src/lib/collab/presence.ts';
import { peopleNotice, readPeopleNotice, type Person } from '../../src/lib/collab/protocol.ts';

describe('the limit on presence messages (S14-5)', () => {
  it('is 60 a second, as the owner decided', () => {
    expect(AWARENESS_PER_SECOND).toBe(60);
  });

  it('lets 60 messages through in a second and drops the 61st', () => {
    const rate = new AwarenessRate();
    const answers = Array.from({ length: 61 }, (_, at) => rate.take(1000 + at));
    expect(answers.slice(0, 60).every(Boolean)).toBe(true);
    expect(answers[60]).toBe(false);
  });

  it('lets one through again when the one 60 messages before it is a second old, and not a millisecond sooner', () => {
    const rate = new AwarenessRate();
    for (let at = 0; at < 60; at += 1) expect(rate.take(5000)).toBe(true);
    expect(rate.take(5999)).toBe(false);
    // A second has gone by for all sixty: sixty more may pass, and the sixty-first waits.
    for (let at = 0; at < 60; at += 1) expect(rate.take(6000)).toBe(true);
    expect(rate.take(6000)).toBe(false);
  });

  it('holds in any second, taken from any moment: never more than 60 pass in it', () => {
    const rate = new AwarenessRate();
    const passed: number[] = [];
    // 200 messages a second for five seconds: far past the limit.
    for (let at = 0; at < 1000; at += 1) if (rate.take(at * 5)) passed.push(at * 5);
    for (const start of passed) {
      expect(passed.filter((time) => time >= start && time < start + 1000).length).toBeLessThanOrEqual(60);
    }
    // And it lets the full 60 through in each second (about), not fewer.
    expect(passed.length).toBeGreaterThanOrEqual(60 * 4);
  });

  it('does not count a message it dropped', () => {
    const rate = new AwarenessRate();
    for (let at = 0; at < 60; at += 1) rate.take(0);
    for (let at = 0; at < 500; at += 1) expect(rate.take(999)).toBe(false);
    // The second after the sixty has passed: dropped ones did not push the window on.
    expect(rate.take(1000)).toBe(true);
  });

  it('is counted for each connection by the one that makes it: two do not share a window', () => {
    const one = new AwarenessRate();
    const two = new AwarenessRate();
    for (let at = 0; at < 60; at += 1) one.take(0);
    expect(one.take(1)).toBe(false);
    expect(two.take(1)).toBe(true);
  });

  it('lets the pace of a person through: a message every 20 ms for ten seconds is all let through', () => {
    const rate = new AwarenessRate();
    for (let at = 0; at < 500; at += 1) expect(rate.take(at * 20)).toBe(true);
  });
});

describe('the message that tells who is present (FR-ED-17)', () => {
  const people: Person[] = [
    { slot: 1, name: 'Ada Owner', role: 'owner', you: true },
    { slot: 2, name: 'Ben Editor', role: 'editor' },
    { slot: 3, name: 'Cy Viewer' },
  ];

  it('is read back as it was written', () => {
    expect(readPeopleNotice(peopleNotice(people))).toEqual(people);
    expect(readPeopleNotice(peopleNotice([]))).toEqual([]);
  });

  it.each([
    ['text that is not JSON', 'people'],
    ['an array', '[]'],
    ['another kind', JSON.stringify({ kind: 'role', people: [] })],
    ['a field more', JSON.stringify({ kind: 'people', people: [], extra: 1 })],
    ['no list', JSON.stringify({ kind: 'people' })],
    ['a list that is not a list', JSON.stringify({ kind: 'people', people: {} })],
    [
      'more people than a document holds connections',
      peopleNotice(Array(COLLABORATOR_COLOURS + 1).fill({ slot: 1, name: 'x' })),
    ],
    ['a person that is not an object', JSON.stringify({ kind: 'people', people: ['Ada'] })],
    [
      'a person with a field more',
      JSON.stringify({ kind: 'people', people: [{ slot: 1, name: 'x', email: 'a@b' }] }),
    ],
    ['a slot of 0', JSON.stringify({ kind: 'people', people: [{ slot: 0, name: 'x' }] })],
    [
      'a slot past the colours',
      JSON.stringify({ kind: 'people', people: [{ slot: COLLABORATOR_COLOURS + 1, name: 'x' }] }),
    ],
    ['a slot that is text', JSON.stringify({ kind: 'people', people: [{ slot: '1', name: 'x' }] })],
    ['a name that is not text', JSON.stringify({ kind: 'people', people: [{ slot: 1, name: 5 }] })],
    [
      'a name of 1,001 characters',
      JSON.stringify({ kind: 'people', people: [{ slot: 1, name: 'x'.repeat(1001) }] }),
    ],
    [
      'a role that is not one',
      JSON.stringify({ kind: 'people', people: [{ slot: 1, name: 'x', role: 'admin' }] }),
    ],
    ['a you that is false', JSON.stringify({ kind: 'people', people: [{ slot: 1, name: 'x', you: false }] })],
  ])('is not read from %s', (_what, payload) => {
    expect(readPeopleNotice(payload)).toBeNull();
  });

  it('keeps nothing a person carries but the four fields', () => {
    const read = readPeopleNotice(peopleNotice([{ slot: 4, name: 'Dee', role: 'viewer' }]));
    expect(Object.keys(read![0]!)).toEqual(['slot', 'name', 'role']);
  });
});
