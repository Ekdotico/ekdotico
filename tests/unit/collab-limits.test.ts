// The limits of a document without the copy (src/lib/collab/state.ts,
// `limitsOf`): that what it adds for an update is never less than what Yjs
// adds, and that it lets no document past a limit that the copy would keep it
// inside. The limits themselves are tested in tests/unit/editor-schema.test.ts.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  MAX_ELEMENT_DEPTH,
  MAX_STATE_BYTES,
  MAX_WAITING_PARTS,
  elementDepth,
  encodeState,
  growthBound,
  limitsOf,
  pastLimits,
  waitingParts,
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

  // The second review of pull request 24. Before it, a document that waited
  // was measured for every update, and one update of a few bytes that names a
  // struct no one sends leaves a document waiting for good.
  describe('a document that waits for a struct it was never sent', () => {
    /**
     * Asks the keeper each update and applies it, and counts the answers that
     * took a copy of the document: a copy reads the document's structs many
     * times, and an answer without one looks once, at what the document waits for.
     */
    function copies(document: Y.Doc, past: ReturnType<typeof limitsOf>, updates: Uint8Array[]): number {
      const { store } = document;
      let looks = 0;
      let copied = 0;
      Object.defineProperty(document, 'store', { configurable: true, get: () => ((looks += 1), store) });
      try {
        for (const update of updates) {
          looks = 0;
          expect(past(update)).toBeNull();
          if (looks > 1) copied += 1;
          Y.applyUpdate(document, update);
        }
      } finally {
        Object.defineProperty(document, 'store', { configurable: true, writable: true, value: store });
      }
      return copied;
    }
    /** The second change of a client whose first is never sent: it waits for ever. */
    function dangling(client: number, change: (document: Y.Doc) => void = () => {}): Uint8Array {
      const source = new Y.Doc();
      source.clientID = client;
      source.getText('p').insert(0, 'never sent');
      const sent: Uint8Array[] = [];
      source.on('update', (update: Uint8Array) => sent.push(update));
      source.transact(() => {
        source.getText('p').insert(5, 'b');
        change(source);
      });
      return sent[0]!;
    }
    /** As many small changes of one client, each an update of its own. */
    function typed(document: Y.Doc, client: number, count: number): Uint8Array[] {
      const { peer, sent } = peerOf(document, client);
      return Array.from({ length: count }, (_, n) => {
        peer.getText('t').insert(n, 'y');
        return sent();
      });
    }

    it('is not copied for every update after it, and not after it was stored and loaded so', () => {
      const document = new Y.Doc();
      document.clientID = 1;
      document.getText('t').insert(0, 'x'.repeat(1024 * 1024));
      const past = limitsOf(document);
      // The first answer is a measure; the update that is left waiting is none.
      expect(copies(document, past, typed(document, 2, 1))).toBe(1);
      expect(copies(document, past, [dangling(99)])).toBe(0);
      expect(waits(document)).toBe(true);
      expect(copies(document, past, typed(document, 3, 200))).toBe(0);
      expect(waits(document)).toBe(true);

      // Yjs writes what waits into the state: the document waits after a load too.
      const loaded = new Y.Doc();
      Y.applyUpdate(loaded, encodeState(document));
      expect(waits(loaded)).toBe(true);
      const again = limitsOf(loaded);
      expect(copies(loaded, again, typed(loaded, 4, 200))).toBe(1);
      // And is copied when it must be: for an update of the client it waits for.
      expect(copies(loaded, again, [dangling(99)])).toBe(0);
    });

    it(
      'still cannot pass 50 levels by what waits, whichever arrives first, with updates of others between',
      { timeout: 120_000 },
      () => {
        /** A member whose first change hangs one quote in the document, and whose second nests `levels` more in it. */
        const nested = (document: Y.Doc, client: number, levels: number) => {
          const { peer, sent } = peerOf(document, client);
          const first = new Y.XmlElement('blockquote');
          peer.getXmlFragment('default').insert(0, [first]);
          const head = sent();
          let parent = first;
          peer.transact(() => {
            for (let level = 0; level < levels; level += 1) {
              const quote = new Y.XmlElement('blockquote');
              parent.insert(0, [quote]);
              parent = quote;
            }
          });
          return { head, rest: sent() };
        };
        for (const levels of [MAX_ELEMENT_DEPTH - 1, MAX_ELEMENT_DEPTH]) {
          const tooDeep = levels + 1 > MAX_ELEMENT_DEPTH;
          // What waits arrives first, others write, and then the struct it waits for.
          const document = new Y.Doc();
          const past = limitsOf(document);
          const { head, rest } = nested(document, 2, levels);
          expect(asked(document, past, rest)).toBe(false);
          expect(waits(document)).toBe(true);
          expect(elementDepth(document)).toBe(0);
          // No copy for what others write meanwhile, and the same answer as the copy gives.
          for (const update of typed(document, 3, 50)) expect(asked(document, past, update)).toBe(false);
          expect(copies(document, past, typed(document, 4, 100))).toBe(0);
          expect(asked(document, past, head), `${levels} levels, waiting first`).toBe(tooDeep);
          expect(elementDepth(document)).toBe(tooDeep ? 0 : MAX_ELEMENT_DEPTH);
          // Refused, it waits still, and is refused again; no update of another brings it in.
          for (const update of typed(document, 5, 20)) expect(asked(document, past, update)).toBe(false);
          expect(asked(document, past, head)).toBe(tooDeep);
          expect(elementDepth(document)).toBeLessThanOrEqual(MAX_ELEMENT_DEPTH);

          // In the order they were written.
          const ordered = new Y.Doc();
          const limits = limitsOf(ordered);
          const inOrder = nested(ordered, 2, levels);
          expect(asked(ordered, limits, inOrder.head)).toBe(false);
          expect(asked(ordered, limits, inOrder.rest), `${levels} levels, in order`).toBe(tooDeep);
          expect(elementDepth(ordered)).toBe(tooDeep ? 1 : MAX_ELEMENT_DEPTH);
        }

        // What waits arrives in pieces, none of which is measured, and is deeper than the room that is left.
        const document = new Y.Doc();
        const past = limitsOf(document);
        for (const update of typed(document, 3, 2)) asked(document, past, update);
        const { peer, sent } = peerOf(document, 2);
        const first = new Y.XmlElement('blockquote');
        peer.getXmlFragment('default').insert(0, [first]);
        const head = sent();
        let parent = first;
        const pieces = Array.from({ length: 3 }, () => {
          peer.transact(() => {
            for (let level = 0; level < 15; level += 1) {
              const quote = new Y.XmlElement('blockquote');
              parent.insert(0, [quote]);
              parent = quote;
            }
          });
          return sent();
        });
        expect(copies(document, past, pieces)).toBe(0);
        expect(waits(document)).toBe(true);
        // Ten levels of another member are taken in: with the 46 that wait, past the limit.
        const other = nested(document, 6, 9);
        expect(asked(document, past, other.head)).toBe(false);
        expect(asked(document, past, other.rest)).toBe(false);
        expect(elementDepth(document)).toBe(10);
        expect(asked(document, past, head)).toBe(false);
        expect(elementDepth(document)).toBe(46);
        // One piece more waits, and the struct that would bring 61 levels in is refused.
        const deeper = new Y.Doc();
        const keeper = limitsOf(deeper);
        for (const update of typed(deeper, 3, 2)) asked(deeper, keeper, update);
        const more = nested(deeper, 2, 0);
        const member = peerOf(deeper, 7);
        Y.applyUpdate(member.peer, more.head);
        let inner = member.peer.getXmlFragment('default').get(0) as Y.XmlElement;
        const waiting = Array.from({ length: 4 }, () => {
          member.peer.transact(() => {
            for (let level = 0; level < 15; level += 1) {
              const quote = new Y.XmlElement('blockquote');
              inner.insert(0, [quote]);
              inner = quote;
            }
          });
          return member.sent();
        });
        // Three are let through without a copy; the fourth is measured, and waits too.
        expect(copies(deeper, keeper, waiting.slice(0, 3))).toBe(0);
        expect(asked(deeper, keeper, waiting[3]!)).toBe(false);
        expect(waits(deeper)).toBe(true);
        expect(asked(deeper, keeper, more.head)).toBe(true);
        expect(elementDepth(deeper)).toBe(0);
      },
    );

    it('still cannot pass 5 MB by what waits, whichever arrives first', { timeout: 120_000 }, () => {
      /** Two pieces of 30,000 bytes that follow one small change: 60,000 where there is room for 40,000. */
      const pieces = (document: Y.Doc) => {
        const { peer, sent } = peerOf(document, 5);
        peer.getText('p').insert(0, 'h');
        const head = sent();
        const large = [1, 2].map(() => {
          peer.getText('p').insert(1, 'w'.repeat(30_000));
          return sent();
        });
        return { head, large };
      };
      // What waits first: its bytes are in the state while it waits, so the second piece is refused there.
      const document = nearlyFull(40_000);
      const past = limitsOf(document);
      const first = pieces(document);
      expect(asked(document, past, first.large[0]!)).toBe(false);
      expect(waits(document)).toBe(true);
      for (const update of typed(document, 3, 20)) expect(asked(document, past, update)).toBe(false);
      expect(asked(document, past, first.large[1]!)).toBe(true);
      expect(asked(document, past, first.head)).toBe(false);
      expect(waits(document)).toBe(false);
      expect(document.getText('p').length).toBe(30_001);
      expect(size(document)).toBeLessThanOrEqual(MAX_STATE_BYTES);

      // In the order they were written.
      const ordered = nearlyFull(40_000);
      const limits = limitsOf(ordered);
      const second = pieces(ordered);
      expect(asked(ordered, limits, second.head)).toBe(false);
      expect(asked(ordered, limits, second.large[0]!)).toBe(false);
      expect(asked(ordered, limits, second.large[1]!)).toBe(true);
      expect(size(ordered)).toBeLessThanOrEqual(MAX_STATE_BYTES);
    });

    it(
      'holds back, at a measure, for what the parts that wait will cost when they are taken in',
      { timeout: 120_000 },
      () => {
        const document = nearlyFull(600_000);
        const past = limitsOf(document);
        for (const update of typed(document, 3, 2)) asked(document, past, update);
        // 1,500 cuts (past 2,000 parts nothing waits: MAX_WAITING_PARTS) of the document wait for one letter, and are let through without a copy.
        const member = peerOf(document, 5);
        member.peer.getText('t').insert(0, 'z');
        const opening = member.sent();
        member.peer.transact(() => {
          for (let n = 0; n < 1500; n += 1) member.peer.getText('t').insert(5000 + 7 * n, 'y');
        });
        expect(copies(document, past, [member.sent()])).toBe(0);
        expect(waits(document)).toBe(true);
        // The room is filled by another member, through measures that see the
        // document as it is: the cuts have cost nothing yet.
        const { peer, sent } = peerOf(document, 6);
        for (const piece of [100_000, 10_000, 1000]) {
          for (;;) {
            peer.getText('more').insert(0, 'w'.repeat(piece));
            if (asked(document, past, sent())) break;
          }
        }
        expect(MAX_STATE_BYTES - size(document)).toBeLessThan(1100);
        for (const update of typed(document, 4, 3)) expect(asked(document, past, update)).toBe(false);
        // The letter is a few bytes, and what it brings in is more than ten thousand.
        expect(opening.byteLength).toBeLessThan(40);
        expect(asked(document, past, opening)).toBe(true);
        expect(size(document)).toBeLessThanOrEqual(MAX_STATE_BYTES);
      },
    );

    it(
      'answers as the copy does for whatever three members send, in whatever order, near 50 levels',
      { timeout: 120_000 },
      () => {
        for (const start of [1, 2, 3, 4, 5, 6]) {
          let seed = 20261012 + start;
          const random = (below: number) => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return (((t ^ (t >>> 14)) >>> 0) % 1_000_000) % below;
          };
          const document = new Y.Doc();
          const past = limitsOf(document);
          // Each member nests in a chain of its own, and writes beside it.
          const members = [11, 2 ** 40 + 5, 2 ** 52 + 9].map((client) => ({
            ...peerOf(document, client),
            chain: [] as Y.XmlElement[],
          }));
          const onTheWay: Uint8Array[] = [];
          const seen = { refused: 0, waited: 0, deepest: 0 };
          for (let round = 0; round < 400; round += 1) {
            const member = members[random(3)]!;
            member.peer.transact(() => {
              for (let n = random(3); n >= 0; n -= 1) {
                const kind = random(10);
                if (kind < 5) {
                  const quote = new Y.XmlElement('blockquote');
                  const parent = member.chain.at(-1) ?? member.peer.getXmlFragment('default');
                  parent.insert(0, [quote]);
                  member.chain.push(quote);
                } else if (kind < 8) member.peer.getText('t').insert(0, 'word ');
                else if (kind === 8 && member.chain.length > 3) {
                  // The innermost three are taken out again.
                  const from = member.chain.length - 3;
                  (member.chain[from - 1] as Y.XmlElement).delete(0, 1);
                  member.chain.length = from;
                } else member.peer.getMap('m').set(`k${random(3)}`, random(9));
              }
            });
            const update = member.sent();
            onTheWay.push(update);
            if (random(4) === 0) onTheWay.push(update);
            while (onTheWay.length && random(3)) {
              const [next] = onTheWay.splice(random(onTheWay.length), 1);
              // The keeper and the copy say the same, of every update, waiting or not.
              if (asked(document, past, next!)) seen.refused += 1;
              if (waits(document)) seen.waited += 1;
              seen.deepest = Math.max(seen.deepest, elementDepth(document));
              expect(elementDepth(document)).toBeLessThanOrEqual(MAX_ELEMENT_DEPTH);
            }
          }
          // The run did something: the document waited, came to the limit, and was held to it.
          expect(seen.waited, `seed ${start}`).toBeGreaterThan(50);
          expect(seen.refused, `seed ${start}`).toBeGreaterThan(0);
          expect(seen.deepest, `seed ${start}`).toBeGreaterThan(MAX_ELEMENT_DEPTH - 5);
        }
      },
    );

    // The third review of pull request 24 (S1'), and the owner's decision of
    // 12 October 2026: one update of some 18 to 136 KB can leave thousands of
    // structs waiting for content no one sends, which fill the room at
    // PART_BYTES each and make every later update of every member a copy.
    describe('at most 2,000 parts wait (MAX_WAITING_PARTS)', () => {
      /** A document of 10,000 letters, with a member whose first change is never delivered and whose second holds `count` structs. */
      function withheld(document: Y.Doc, client: number, count: number) {
        const member = peerOf(document, client);
        member.peer.getText('t').insert(0, 'z');
        const head = member.sent();
        member.peer.transact(() => {
          for (let n = 0; n < count; n += 1) member.peer.getText('t').insert(10 + 3 * n, 'y');
        });
        return { head, rest: member.sent() };
      }
      const base = () => {
        const document = new Y.Doc();
        document.clientID = 1;
        document.getText('t').insert(0, 'x'.repeat(10_000));
        return document;
      };

      it('lets a document wait with 2,000 and refuses the update that takes it to 2,001', () => {
        expect(MAX_WAITING_PARTS).toBe(2000);
        const document = base();
        const past = limitsOf(document);
        const a = withheld(document, 5, MAX_WAITING_PARTS);
        expect(asked(document, past, a.rest)).toBe(false);
        expect(waitingParts(document)).toBe(MAX_WAITING_PARTS);
        // One struct more, from another member, takes it past; the copy and the keeper both refuse.
        const b = withheld(document, 6, 1);
        expect(asked(document, past, b.rest)).toBe(true);
        expect(waitingParts(document)).toBe(MAX_WAITING_PARTS);
        // And at once, in one update: 2,001 where there was nothing.
        const fresh = base();
        expect(asked(fresh, limitsOf(fresh), withheld(fresh, 5, MAX_WAITING_PARTS + 1).rest)).toBe(true);
        expect(waitingParts(fresh)).toBe(0);
      });

      it('refuses what passes it a piece at a time, the sum counted without a copy', () => {
        const document = base();
        const past = limitsOf(document);
        // Four pieces of 600 from four members: 600, 1,200 and 1,800 wait, and the fourth would make 2,400.
        const pieces = [5, 6, 7, 8].map((client) => withheld(document, client, 600).rest);
        expect(asked(document, past, pieces[0]!)).toBe(false);
        expect(copies(document, past, pieces.slice(1, 3))).toBe(0);
        expect(waitingParts(document)).toBe(1800);
        expect(asked(document, past, pieces[3]!)).toBe(true);
        expect(waitingParts(document)).toBe(1800);
      });

      it('still takes in some 1,000 parts that arrive out of order, and resolves them', () => {
        const document = base();
        const past = limitsOf(document);
        const member = peerOf(document, 5);
        member.peer.getText('t').insert(0, 'z');
        const head = member.sent();
        const updates = Array.from({ length: 1000 }, (_, n) => {
          member.peer.getText('t').insert(10 + 3 * n, 'y');
          return member.sent();
        });
        // The last change first, then the rest in reverse, and the first change at the end.
        for (const update of updates.reverse()) expect(asked(document, past, update)).toBe(false);
        expect(waitingParts(document)).toBe(1000);
        expect(asked(document, past, head)).toBe(false);
        expect(waits(document)).toBe(false);
        expect(waitingParts(document)).toBe(0);
        expect(document.getText('t').length).toBe(10_000 + 1001);
      });

      it('admits the next ordinary update without a copy after one was refused', () => {
        const document = base();
        const past = limitsOf(document);
        expect(asked(document, past, withheld(document, 5, 1500).rest)).toBe(false);
        // 400 keys of others are let through without a copy; the keeper holds them as parts that may wait.
        expect(copies(document, past, typed(document, 8, 400))).toBe(0);
        // 1,000 more would make 2,500: refused, and the document is as it was.
        expect(asked(document, past, withheld(document, 6, 1000).rest)).toBe(true);
        expect(waitingParts(document)).toBe(1500);
        // 300 keys of a third member: 1,800 at most once counted again, and none is a copy.
        expect(copies(document, past, typed(document, 7, 300))).toBe(0);
        expect(waitingParts(document)).toBe(1500);
      });

      it('lets a document that was past it load, and takes every update that adds no part to what waits', () => {
        // Waiting with 2,500, as stored before there was a limit: no update was asked.
        const document = base();
        const first = withheld(document, 5, 2500);
        Y.applyUpdate(document, first.rest);
        expect(waitingParts(document)).toBe(2500);
        const loaded = new Y.Doc();
        Y.applyUpdate(loaded, encodeState(document));
        expect(waitingParts(loaded)).toBe(2500);
        const past = limitsOf(loaded);
        // Others write as before: each is measured, as it was.
        for (const update of typed(loaded, 6, 30)) expect(asked(loaded, past, update)).toBe(false);
        // One more struct that waits is refused, and what brings the waiting in is taken.
        expect(asked(loaded, past, withheld(loaded, 7, 1).rest)).toBe(true);
        expect(waitingParts(loaded)).toBe(2500);
        expect(asked(loaded, past, first.head)).toBe(false);
        expect(waitingParts(loaded)).toBe(0);
      });

      it('counts the deleted ranges that wait with the structs', () => {
        const document = base();
        const past = limitsOf(document);
        // 1,500 structs of a member wait for its first change; then it deletes
        // every other one of them, 600 ranges of clocks the document has not
        // reached, which wait too. Alone, neither is past 2,000.
        const member = peerOf(document, 5);
        member.peer.getText('t').insert(0, 'z');
        member.sent();
        member.peer.transact(() => {
          for (let n = 0; n < 1500; n += 1) member.peer.getText('t').insert(10 + 3 * n, 'y');
        });
        const inserted = member.sent();
        member.peer.transact(() => {
          for (let n = 1198; n >= 0; n -= 2) member.peer.getText('t').delete(10 + 3 * n, 1);
        });
        const deleted = member.sent();
        expect(asked(document, past, inserted)).toBe(false);
        expect(waitingParts(document)).toBe(1500);
        expect(asked(document, past, deleted)).toBe(true);
        expect(waitingParts(document)).toBe(1500);
      });
    });
  });

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
