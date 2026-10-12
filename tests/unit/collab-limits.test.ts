// The limits of a document without the copy (src/lib/collab/state.ts,
// `limitsOf`): that what it adds for an update is never less than what Yjs
// adds, and that it lets no document past a limit that the copy would keep it
// inside. The limits themselves are tested in tests/unit/editor-schema.test.ts.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_ELEMENT_DEPTH,
  MAX_STATE_BYTES,
  elementDepth,
  encodeState,
  growthBound,
  limitsOf,
  pastLimits,
} from '../../src/lib/collab/state.ts';

const size = (document: Y.Doc) => encodeState(document).byteLength;
const waits = (document: Y.Doc) =>
  document.store.pendingStructs !== null || document.store.pendingDs !== null;

/** A second copy of a document, under a client of its own, and what it has written since `sent` was last called. */
function peerOf(document: Y.Doc, client: number) {
  const peer = new Y.Doc();
  peer.clientID = client;
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(document));
  // As a client sends: the update of each of its own transactions, and not its
  // whole state against a vector, which carries every deletion there ever was.
  const own: Uint8Array[] = [];
  peer.on('update', (update: Uint8Array, _origin: unknown, _doc: Y.Doc, transaction: Y.Transaction) => {
    if (transaction.local) own.push(update);
  });
  return {
    peer,
    sent: () => (own.length > 0 ? Y.mergeUpdates(own.splice(0)) : Uint8Array.of(0, 0)),
  };
}

/** How many marks of formatting a document holds that are not deleted. */
function formats(document: Y.Doc): number {
  let found = 0;
  for (const structs of document.store.clients.values())
    for (const struct of structs)
      if (struct instanceof Y.Item && !struct.deleted && struct.content instanceof Y.ContentFormat)
        found += 1;
  return found;
}

/** What applying `update` added to `document`, against what `growthBound` says it can. */
function added(document: Y.Doc, update: Uint8Array) {
  const before = { bytes: size(document), depth: elementDepth(document), formats: formats(document) };
  const bound = growthBound(update);
  Y.applyUpdate(document, update);
  return {
    bytes: size(document) - before.bytes,
    levels: elementDepth(document) - before.depth,
    bound,
    /**
     * The marks of formatting that were there and are deleted now, which Yjs
     * may have done by itself: each can cost 27 bytes that no update is
     * counted for, and that the keeper holds back for at a measure.
     */
    cleared: Math.max(0, before.formats - formats(document)),
    /** The update as Yjs writes it back: what it adds where it cuts nothing. */
    written: Y.diffUpdate(update, Uint8Array.of(0)).byteLength,
  };
}

// The update format of Yjs, version 1, written by hand.
const varint = (value: number): number[] => {
  const bytes = [];
  for (; value > 127; value = Math.floor(value / 128)) bytes.push(128 | (value % 128));
  return [...bytes, value];
};
const text = (value: string) => [...varint(Buffer.byteLength(value)), ...Buffer.from(value)];

describe('what an update can add to a document (growthBound)', () => {
  it('is more than the length of the update where Yjs writes back more than it read', () => {
    // One struct of client 5 in the root `j`: a thousand values, each the JSON text `1e20`.
    const values = Array.from({ length: 1000 }, () => text('1e20')).flat();
    const update = Uint8Array.from([1, 1, 5, 0, 2, 1, ...text('j'), ...varint(1000), ...values, 0]);
    const document = new Y.Doc();
    const { bytes, bound } = added(document, update);
    expect(document.getArray('j').get(0)).toBe(1e20);
    // Each is stored as its 21 digits: the state grew by four times the update.
    expect(bytes).toBeGreaterThan(4 * update.byteLength);
    expect(bytes).toBeLessThanOrEqual(bound.bytes);
  });

  it('counts what a struct and a deleted range cut in two', () => {
    const document = new Y.Doc();
    document.clientID = 1;
    document.getText('t').insert(0, 'x'.repeat(100_000));
    // A thousand characters deleted, far apart: each range cuts the one struct twice.
    const deleting = peerOf(document, 2);
    deleting.peer.transact(() => {
      for (let at = 99_000; at > 0; at -= 99) deleting.peer.getText('t').delete(at, 1);
    });
    const deleted = added(document, deleting.sent());
    expect(deleted.bytes).toBeGreaterThan(2 * deleted.written);
    expect(deleted.bytes).toBeLessThanOrEqual(deleted.bound.bytes);

    // A thousand characters written, far apart, into what is left.
    const writing = peerOf(document, 3);
    writing.peer.transact(() => {
      for (let at = 97_000; at > 0; at -= 97) writing.peer.getText('t').insert(at, 'y');
    });
    const written = added(document, writing.sent());
    expect(written.bytes).toBeGreaterThan(written.written + 1000);
    expect(written.bytes).toBeLessThanOrEqual(written.bound.bytes);
  });

  it('counts a cut inside a surrogate pair, and a struct deleted by where it lands', () => {
    const document = new Y.Doc();
    document.clientID = 1;
    document.getText('t').insert(0, '😀'.repeat(5000));
    const element = new Y.XmlElement('blockquote');
    document.getXmlFragment('default').insert(0, [element]);
    document.getMap('m').set('key', 'first');

    const cutting = peerOf(document, 2);
    cutting.peer.transact(() => {
      for (let at = 9999; at > 0; at -= 20) cutting.peer.getText('t').insert(at, 'y');
    });
    const cut = added(document, cutting.sent());
    expect(cut.bytes).toBeLessThanOrEqual(cut.bound.bytes);

    // Written under an element that the document has deleted meanwhile, and over an entry of a map.
    const late = peerOf(document, 3);
    document.getXmlFragment('default').delete(0, 1);
    late.peer.transact(() => {
      const under = late.peer.getXmlFragment('default').get(0) as Y.XmlElement;
      for (let n = 0; n < 200; n += 1) under.insert(0, [new Y.XmlElement('paragraph')]);
      for (let n = 0; n < 200; n += 1) late.peer.getMap('m').set(`key${n % 3}`, n);
    });
    const landed = added(document, late.sent());
    expect(landed.bytes).toBeLessThanOrEqual(landed.bound.bytes);
    expect(landed.levels).toBe(0);
  });

  it('counts a level for each shared type that is not text, and none for text', () => {
    const document = new Y.Doc();
    const { peer, sent } = peerOf(document, 2);
    const paragraph = new Y.XmlElement('paragraph');
    paragraph.insert(0, [new Y.XmlText('words')]);
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [paragraph]);
    peer.getXmlFragment('default').insert(0, [quote]);
    const nested = added(document, sent());
    expect(nested).toMatchObject({ levels: 2, bound: { levels: 2 } });

    (paragraph.get(0) as Y.XmlText).insert(0, 'more ');
    expect(added(document, sent())).toMatchObject({ levels: 0, bound: { levels: 0 } });
    // Side by side they add one level and are counted as three: never too few.
    peer.getXmlFragment('default').insert(
      0,
      [1, 2, 3].map(() => new Y.XmlElement('horizontalRule')),
    );
    expect(added(document, sent())).toMatchObject({ levels: 0, bound: { levels: 3 } });
  });

  // Three members who write, delete, nest and overwrite at once, each update
  // delivered once or twice and not in order: whatever the document held and
  // whatever arrived, it grew by no more than was counted.
  it('holds for whatever three members send, in whatever order', { timeout: 120_000 }, () => {
    let seed = 20261012;
    const random = (below: number) => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return (((t ^ (t >>> 14)) >>> 0) % 1_000_000) % below;
    };
    const words = ['a', 'bc', '😀', 'δοκιμή', 'x'.repeat(40), '😀😀😀😀', '\n'];
    const document = new Y.Doc();
    const members = [11, 2 ** 40 + 5, 2 ** 52 + 9].map((client) => peerOf(document, client));
    const change = (peer: Y.Doc) => {
      const body = peer.getText('t');
      const fragment = peer.getXmlFragment('default');
      const kind = random(10);
      if (kind < 3) body.insert(random(body.length + 1), words[random(words.length)]!);
      else if (kind < 5 && body.length)
        body.delete(random(body.length), 1 + random(Math.min(5, body.length)));
      else if (kind === 5 && body.length)
        body.format(random(body.length), 1 + random(3), { bold: random(2) ? true : null });
      else if (kind === 6)
        peer.getMap('m').set(`k${random(3)}`, [2 ** 40 + 1, { n: random(9) }, null][random(3)]);
      else if (kind === 7)
        peer.getArray('a').insert(random(peer.getArray('a').length + 1), [1.5, 2 ** 33, 'v']);
      else if (kind === 8) {
        // Under the first element, or under the fragment: nesting grows where members agree.
        const first = fragment.length ? fragment.get(random(fragment.length)) : null;
        const parent = first instanceof Y.XmlElement && random(3) ? first : fragment;
        const paragraph = new Y.XmlElement('blockquote');
        paragraph.insert(0, [new Y.XmlText(words[random(words.length)])]);
        parent.insert(random(parent.length + 1), [paragraph]);
      } else if (fragment.length) fragment.delete(random(fragment.length), 1);
    };

    const waitingToArrive: Uint8Array[] = [];
    let held = 0;
    let most = { bytes: 0, levels: 0 };
    for (let round = 0; round < 1500; round += 1) {
      const member = members[random(3)]!;
      member.peer.transact(() => {
        for (let n = random(4); n >= 0; n -= 1) change(member.peer);
      });
      const update = member.sent();
      waitingToArrive.push(update);
      if (random(4) === 0) waitingToArrive.push(update);
      // The members hear of each other late, so that they write at the same places.
      if (random(5) === 0) {
        const other = members[random(3)]!;
        Y.applyUpdate(other.peer, Y.encodeStateAsUpdate(document));
      }
      while (waitingToArrive.length && random(3)) {
        const [next] = waitingToArrive.splice(random(waitingToArrive.length), 1);
        if (waits(document)) {
          Y.applyUpdate(document, next!);
          continue;
        }
        const grew = added(document, next!);
        held += 1;
        expect(grew.bytes, `bytes, round ${round}`).toBeLessThanOrEqual(grew.bound.bytes + 27 * grew.cleared);
        expect(grew.levels, `levels, round ${round}`).toBeLessThanOrEqual(grew.bound.levels);
        most = { bytes: Math.max(most.bytes, grew.bytes), levels: Math.max(most.levels, grew.levels) };
      }
    }
    // The run did something: updates were held to the bound, and the document grew and nested.
    expect(held).toBeGreaterThan(500);
    expect(most.bytes).toBeGreaterThan(100);
    expect(most.levels).toBeGreaterThan(0);
  });

  // Yjs deletes by itself the marks of formatting that no longer change
  // anything, in every document that takes another client's change. One small
  // deletion can leave any number of them so, and each deletion is written
  // into the state: bytes that the update which caused them does not hold.
  it('is not all that formatting which is there can cost: what Yjs clears by itself is counted for each mark', () => {
    const document = formatted(3000);
    expect(formats(document)).toBe(3000);
    const cleared = added(document, DELETE_THE_TEXT(3000));
    // Six bytes sent, and three thousand deletions written.
    expect(cleared.written).toBeLessThan(10);
    expect(cleared.cleared).toBe(2999);
    expect(cleared.bytes).toBeGreaterThan(cleared.bound.bytes + 5000);
    expect(cleared.bytes).toBeLessThanOrEqual(cleared.bound.bytes + 27 * cleared.cleared);
  });
});

/**
 * A document whose text `t` is `marks` + 1 characters of client 1, with a mark
 * of formatting of client 9 between each two, and no two of those marks next
 * to each other in the count of client 9, which starts at 2^40: so that each,
 * when it is deleted, is a range of its own, of seven bytes. Written by hand:
 * no editor makes it, and any client may send it.
 */
function formatted(marks: number, more = 0): Y.Doc {
  const document = new Y.Doc();
  document.clientID = 1;
  document.getText('t').insert(0, 'x'.repeat(marks + 1));
  if (more > 0) document.getText('more').insert(0, 'y'.repeat(more));
  const structs = [0, ...varint(2 ** 40)];
  for (let at = 1; at <= marks; at += 1) {
    // A mark between two characters, its value unlike the one before it: it changes something.
    structs.push(0xc6, 1, ...varint(at - 1), 1, ...varint(at), ...text('b'), ...text(at % 2 ? '1' : '2'));
    // And a character elsewhere, which keeps the count of the marks apart.
    structs.push(4, 1, ...text('o'), ...text('q'));
  }
  Y.applyUpdate(document, Uint8Array.from([1, ...varint(2 * marks + 1), 9, 0, ...structs, 0]));
  return document;
}
/** The deletion of every character of that text, as client 1 or anyone may send it: one range. */
const DELETE_THE_TEXT = (marks: number) => Uint8Array.from([0, 1, 1, 1, 0, ...varint(marks + 1)]);

describe('the limits of a document, asked without the copy (limitsOf)', () => {
  /** Asks, and applies what was let through, as the server does; and the copy must have said the same. */
  function asked(document: Y.Doc, past: ReturnType<typeof limitsOf>, update: Uint8Array) {
    const exact = pastLimits(document, update);
    const refused = past(update) !== null;
    expect(refused).toBe(exact);
    if (!refused) Y.applyUpdate(document, update);
    return refused;
  }
  /** A document of one struct, `room` bytes inside the limit. */
  function nearlyFull(room: number) {
    const document = new Y.Doc();
    document.clientID = 1;
    document.getText('t').insert(0, 'x'.repeat(MAX_STATE_BYTES - room - 16));
    expect(MAX_STATE_BYTES - size(document)).toBeGreaterThanOrEqual(room);
    expect(MAX_STATE_BYTES - size(document)).toBeLessThan(room + 16);
    return document;
  }

  it(
    'lets a document to its limit of bytes and not past it, one small update after another',
    { timeout: 120_000 },
    () => {
      const document = nearlyFull(40_000);
      const past = limitsOf(document);
      const { peer, sent } = peerOf(document, 2);
      let taken = 0;
      for (;;) {
        // In the middle of the one struct: each cuts it again.
        peer.getText('t').insert(1000 + 3 * taken, 'y'.repeat(100));
        if (asked(document, past, sent())) break;
        taken += 1;
        expect(size(document)).toBeLessThanOrEqual(MAX_STATE_BYTES);
      }
      // About 115 bytes each: the room was used, and the next would have passed the limit.
      expect(taken).toBeGreaterThan(300);
      expect(MAX_STATE_BYTES - size(document)).toBeLessThan(130);
    },
  );

  it('lets elements to 50 deep and not past, one level after another', () => {
    const document = new Y.Doc();
    const past = limitsOf(document);
    const { peer, sent } = peerOf(document, 2);
    let parent: Y.XmlFragment = peer.getXmlFragment('default');
    for (let level = 1; level <= MAX_ELEMENT_DEPTH + 1; level += 1) {
      const quote = new Y.XmlElement('blockquote');
      parent.insert(0, [quote]);
      parent = quote;
      expect(asked(document, past, sent()), `level ${level}`).toBe(level > MAX_ELEMENT_DEPTH);
    }
    expect(elementDepth(document)).toBe(MAX_ELEMENT_DEPTH);
  });

  it(
    'measures a document that waits for a struct, which a small update can bring in',
    { timeout: 120_000 },
    () => {
      // By depth: sixty levels arrive first and wait for the element they hang from.
      const document = new Y.Doc();
      const past = limitsOf(document);
      const { peer, sent } = peerOf(document, 2);
      const first = new Y.XmlElement('blockquote');
      peer.getXmlFragment('default').insert(0, [first]);
      const small = sent();
      let parent = first;
      peer.transact(() => {
        for (let level = 0; level < 60; level += 1) {
          const quote = new Y.XmlElement('blockquote');
          parent.insert(0, [quote]);
          parent = quote;
        }
      });
      const deep = sent();
      expect(asked(document, past, deep)).toBe(false);
      expect(waits(document)).toBe(true);
      expect(growthBound(small).levels).toBe(1);
      expect(asked(document, past, small)).toBe(true);
      expect(elementDepth(document)).toBe(0);

      // By bytes: what waited cuts the document in two thousand places when it
      // comes in, and none of that is in the update that brought it in.
      const full = nearlyFull(80_000);
      const limits = limitsOf(full);
      const member = peerOf(full, 3);
      member.peer.getText('t').insert(0, 'z');
      const opening = member.sent();
      member.peer.transact(() => {
        for (let n = 0; n < 2000; n += 1) member.peer.getText('t').insert(5000 + 7 * n, 'y');
      });
      const cuts = member.sent();
      expect(asked(full, limits, cuts)).toBe(false);
      expect(waits(full)).toBe(true);
      const beforeCuts = size(full);
      expect(asked(full, limits, opening)).toBe(false);
      expect(waits(full)).toBe(false);
      // What the cuts cost, beyond every byte that was sent.
      expect(size(full) - beforeCuts).toBeGreaterThan(10_000);
      // Five of these fit and the sixth does not. In few and large pieces, so
      // that what is counted over for each does not hide the ten thousand.
      let taken = 0;
      for (;;) {
        member.peer.getText('t').insert(member.peer.getText('t').length, 'w'.repeat(10_000));
        if (asked(full, limits, member.sent())) break;
        taken += 1;
        expect(size(full)).toBeLessThanOrEqual(MAX_STATE_BYTES);
      }
      expect(taken).toBe(5);
    },
  );

  it(
    'holds back, at a measure, for the formatting that is in the document and that Yjs may yet clear',
    { timeout: 120_000 },
    () => {
      // As a document is when it is loaded: three thousand marks, and 25,000 bytes of room.
      const fill = MAX_STATE_BYTES - 25_000 - size(formatted(3000));
      const document = formatted(3000, fill - 8);
      expect(MAX_STATE_BYTES - size(document)).toBeGreaterThan(24_900);
      expect(MAX_STATE_BYTES - size(document)).toBeLessThan(25_100);
      const past = limitsOf(document);
      // Six bytes, which cost the document some nine thousand.
      const before = size(document);
      expect(asked(document, past, DELETE_THE_TEXT(3000))).toBe(false);
      expect(size(document) - before).toBeGreaterThan(8000);
      // One piece of 10,000 fits in what is left, and the second does not.
      const { peer, sent } = peerOf(document, 2);
      let taken = 0;
      for (;;) {
        peer.getText('more').insert(0, 'w'.repeat(10_000));
        if (asked(document, past, sent())) break;
        taken += 1;
        expect(size(document)).toBeLessThanOrEqual(MAX_STATE_BYTES);
      }
      expect(taken).toBe(1);
    },
  );

  it('does not copy the document for a small update far from a limit', () => {
    const document = new Y.Doc();
    document.clientID = 1;
    document.getText('t').insert(0, 'x'.repeat(1024 * 1024));
    const past = limitsOf(document);
    const { peer, sent } = peerOf(document, 2);
    peer.getText('t').insert(10, 'y');
    asked(document, past, sent());
    // The first was a measure. From here a copy would be a megabyte encoded each time.
    const updates = Array.from({ length: 200 }, (_, n) => {
      peer.getText('t').insert(20 + n, 'y');
      return sent();
    });
    const started = performance.now();
    for (const update of updates) {
      expect(past(update)).toBeNull();
      Y.applyUpdate(document, update);
    }
    const each = (performance.now() - started) / updates.length;
    const one = performance.now();
    pastLimits(document, updates[0]!);
    const copy = performance.now() - one;
    expect(each).toBeLessThan(copy / 5);
  });
});
