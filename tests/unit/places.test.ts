// The places of a document's connections (NFR-PE-05; FR-ED-17; register D174):
// how many, which slot each holds, and that the count and the taking are one step.
import { describe, expect, it } from 'vitest';
import { PENDING_MS, Places } from '../../src/lib/collab/places.ts';
import { COLLABORATOR_COLOURS, CONNECTIONS_PER_DOCUMENT } from '../../src/lib/collab/presence.ts';

const DOCUMENT = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b';
const OTHER = '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';

describe('the places of a document', () => {
  it('admits as many as the limit, and refuses the next', () => {
    const places = new Places();
    const held = Array.from({ length: CONNECTIONS_PER_DOCUMENT }, () => places.reserve(DOCUMENT));
    expect(held.every((each) => each !== null)).toBe(true);
    expect(places.reserve(DOCUMENT)).toBeNull();
    expect(places.count(DOCUMENT)).toBe(CONNECTIONS_PER_DOCUMENT);
    // Another document has places of its own.
    expect(places.reserve(OTHER)?.slot).toBe(1);
  });

  it('counts and takes in one step: a hundred attempts in one tick admit ten', () => {
    const places = new Places();
    const attempts = Array.from({ length: 100 }, () => places.reserve(DOCUMENT));
    expect(attempts.filter((each) => each !== null)).toHaveLength(10);
  });

  it('gives the lowest slot that is free, and a freed slot to the next arrival', () => {
    const places = new Places();
    const [one, two, three] = [
      places.reserve(DOCUMENT)!,
      places.reserve(DOCUMENT)!,
      places.reserve(DOCUMENT)!,
    ];
    expect([one.slot, two.slot, three.slot]).toEqual([1, 2, 3]);
    places.release(two);
    expect(places.reserve(DOCUMENT)!.slot).toBe(2);
    places.release(one);
    places.release(three);
    // The lowest, not the next number up.
    expect(places.reserve(DOCUMENT)!.slot).toBe(1);
    expect(places.reserve(DOCUMENT)!.slot).toBe(3);
    expect(places.reserve(DOCUMENT)!.slot).toBe(4);
  });

  it('never gives two places of a document the same slot, however they come and go', () => {
    const places = new Places();
    const held = new Set<ReturnType<Places['reserve']>>();
    let seed = 7;
    const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let step = 0; step < 2000; step++) {
      if (next() < 0.55) {
        const place = places.reserve(DOCUMENT);
        if (place) held.add(place);
        else expect(held.size).toBe(CONNECTIONS_PER_DOCUMENT);
      } else if (held.size > 0) {
        const place = [...held][Math.floor(next() * held.size)]!;
        held.delete(place);
        places.release(place);
      }
      const slots = [...held].map((each) => each!.slot);
      expect(new Set(slots).size).toBe(slots.length);
      expect(Math.max(0, ...slots)).toBeLessThanOrEqual(COLLABORATOR_COLOURS);
      expect(places.count(DOCUMENT)).toBe(held.size);
    }
  });

  it('gives a place back once: a late second call does not take the slot from its next holder', () => {
    const places = new Places();
    const first = places.reserve(DOCUMENT)!;
    places.release(first);
    const second = places.reserve(DOCUMENT)!;
    expect(second.slot).toBe(first.slot);
    places.release(first);
    expect(places.count(DOCUMENT)).toBe(1);
    expect(places.hold(second)).toBe(true);
  });

  it('counts a place that waits for its connection, and stops counting it after the time that a load can take', () => {
    let now = 1_000;
    const places = new Places(2, () => now);
    const waiting = places.reserve(DOCUMENT)!;
    places.reserve(DOCUMENT);
    expect(places.reserve(DOCUMENT)).toBeNull();
    now += PENDING_MS - 1;
    expect(places.reserve(DOCUMENT)).toBeNull();
    now += 1;
    // Both waited and neither was held: the handshakes ended without a connection.
    expect(places.count(DOCUMENT)).toBe(0);
    expect(places.reserve(DOCUMENT)!.slot).toBe(1);
    // A connection that arrives for a place that expired, whose slot someone has since taken, has none.
    expect(places.hold(waiting)).toBe(false);
  });

  it('never lets a held place expire, and tells a connection whose place was taken that it has none', () => {
    let now = 0;
    const places = new Places(1, () => now);
    const held = places.reserve(DOCUMENT)!;
    expect(places.hold(held)).toBe(true);
    now += 10 * PENDING_MS;
    expect(places.count(DOCUMENT)).toBe(1);
    expect(places.reserve(DOCUMENT)).toBeNull();

    // Another that waited, expired, and whose slot was taken by someone else.
    places.release(held);
    const late = places.reserve(DOCUMENT)!;
    now += PENDING_MS;
    const taken = places.reserve(DOCUMENT)!;
    expect(taken.slot).toBe(late.slot);
    expect(places.hold(late)).toBe(false);
    expect(places.hold(taken)).toBe(true);
  });

  it('drops the places that wait for a connection where their load failed, and no other', () => {
    const places = new Places();
    const connected = places.reserve(DOCUMENT)!;
    expect(places.hold(connected)).toBe(true);
    const waiting = [places.reserve(DOCUMENT)!, places.reserve(DOCUMENT)!, places.reserve(DOCUMENT)!];
    const other = places.reserve(OTHER)!;
    expect(places.count(DOCUMENT)).toBe(4);
    places.dropPending(DOCUMENT);
    // The one that has a connection stays, another document is not touched.
    expect(places.count(DOCUMENT)).toBe(1);
    expect(places.count(OTHER)).toBe(1);
    expect(places.reserve(DOCUMENT)!.slot).toBe(connected.slot + 1);
    // A handshake that comes back is given a place again where there is room, and has none where there is not.
    expect(places.hold(waiting[2]!)).toBe(true);
    places.hold(other);
    places.dropPending('3f2b8c1e-0000-4000-8000-000000000000');
  });

  it('refuses a limit that would let two connections share a colour (FR-ED-17)', () => {
    expect(() => new Places(COLLABORATOR_COLOURS + 1)).toThrow();
    expect(() => new Places(0)).toThrow();
    expect(() => new Places(1.5)).toThrow();
    expect(() => new Places(COLLABORATOR_COLOURS)).not.toThrow();
  });
});
