// Presence (FR-ED-17) and the two numbers it is coupled to (NFR-PE-05, FR-ED-18;
// register Q31): what a connection may say of itself, read from the pure
// functions of src/lib/collab/presence.ts.
import { readFileSync } from 'node:fs';
import { collaboratorSlots } from '@ekdotico/domico/tokens';
import { Awareness, encodeAwarenessUpdate } from 'y-protocols/awareness';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  AWARENESS_MAX_BYTES,
  awarenessClients,
  awarenessTooLong,
  COLLABORATOR_COLOURS,
  CONNECTIONS_PER_DOCUMENT,
  displayNameOf,
  isSlot,
  pinAwareness,
  readCursor,
} from '../../src/lib/collab/presence.ts';

describe('the limit of connections and the colour set, which are revisited together (Q31)', () => {
  it('are ten and ten, and the limit is no more than the colours (FR-ED-17)', () => {
    expect(CONNECTIONS_PER_DOCUMENT).toBe(10);
    expect(COLLABORATOR_COLOURS).toBe(10);
    expect(CONNECTIONS_PER_DOCUMENT).toBeLessThanOrEqual(COLLABORATOR_COLOURS);
  });

  // The number is written here so that the palettes of the package do not travel to the browser.
  it('hold as many colours as the design package’s own set', () => {
    expect(COLLABORATOR_COLOURS).toBe(collaboratorSlots.length);
    expect(collaboratorSlots).toEqual(Array.from({ length: COLLABORATOR_COLOURS }, (_, at) => at + 1));
  });

  // FR-ED-18 gives the words, and they name the number: a limit changed without them is a false statement.
  it('are held with the fixed statement, which says the number the limit is', () => {
    const statement =
      'This document has reached its limit of ten connections. Ekdotico tries again every 30 seconds.';
    const editor = readFileSync('src/app/(app)/documents/[id]/editor.tsx', 'utf8');
    expect(editor).toContain(`'${statement}'`);
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    expect(statement).toContain(`limit of ${words[CONNECTIONS_PER_DOCUMENT]} connections`);
  });

  it('read a slot as a whole number from 1 to the colours, and nothing else', () => {
    for (const slot of [1, 2, 5, COLLABORATOR_COLOURS]) expect(isSlot(slot)).toBe(true);
    for (const slot of [0, -1, COLLABORATOR_COLOURS + 1, 1.5, '1', null, undefined, NaN, Infinity, {}, [1]]) {
      expect(isSlot(slot)).toBe(false);
    }
  });
});

describe('the name of a cursor (FR-ED-17)', () => {
  it('is the name of the account, or the part of the address before the @ where there is none', () => {
    expect(displayNameOf({ name: 'Ada Lovelace', email: 'ada@example.com' })).toBe('Ada Lovelace');
    expect(displayNameOf({ name: '  Ada  ', email: 'ada@example.com' })).toBe('Ada');
    expect(displayNameOf({ name: null, email: 'ada.l@example.com' })).toBe('ada.l');
    expect(displayNameOf({ name: '   ', email: 'ada@example.com' })).toBe('ada');
    expect(displayNameOf({ name: '', email: 'a@b@example.com' })).toBe('a@b');
    expect(displayNameOf({ name: null, email: 'nobody' })).toBe('nobody');
    expect(displayNameOf({ name: null, email: null })).toBe('');
  });
});

/** A cursor as Yjs writes one. */
function cursor() {
  const document = new Y.Doc();
  const fragment = document.getXmlFragment('default');
  const paragraph = new Y.XmlElement('paragraph');
  const text = new Y.XmlText('hello');
  paragraph.insert(0, [text]);
  fragment.insert(0, [paragraph]);
  const at = (index: number) => Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, index));
  return { anchor: at(1), head: at(4) };
}

describe('the cursor a connection may send', () => {
  it('is two relative positions as Yjs writes them, and is passed on as it was written', () => {
    const written = cursor();
    expect(written.anchor).toHaveProperty('type');
    expect(readCursor(written)).toEqual(written);
    // And a document's own start, which names the fragment.
    const start = { tname: 'default' };
    expect(readCursor({ anchor: start, head: { ...start, assoc: -1 } })).toEqual({
      anchor: start,
      head: { ...start, assoc: -1 },
    });
    // What Yjs reads back from it is a position.
    expect(() => Y.createRelativePositionFromJSON(readCursor(written)!.anchor)).not.toThrow();
  });

  it.each([
    ['text', 'text'],
    ['null', null],
    ['an array', [{}, {}]],
    ['nothing', {}],
    ['one end', { anchor: { tname: 'a' } }],
    ['a third field', { anchor: { tname: 'a' }, head: { tname: 'a' }, color: 'red' }],
    ['an end that is text', { anchor: 'a', head: { tname: 'a' } }],
    ['an unknown field of an end', { anchor: { tname: 'a', x: 1 }, head: { tname: 'a' } }],
    ['a type that is text', { anchor: { type: 'a' }, head: { tname: 'a' } }],
    ['an identifier with a third field', { anchor: { item: { client: 1, clock: 1, x: 1 } }, head: {} }],
    ['an identifier of text', { anchor: { item: { client: '1', clock: 1 } }, head: {} }],
    ['a negative clock', { anchor: { item: { client: 1, clock: -1 } }, head: {} }],
    ['a clock that is not whole', { anchor: { item: { client: 1, clock: 1.5 } }, head: {} }],
    ['a client that is unsafe', { anchor: { item: { client: 2 ** 60, clock: 1 } }, head: {} }],
    ['a name of a type that is not text', { anchor: { tname: 5 }, head: {} }],
    ['a name of a type of 257 characters', { anchor: { tname: 'a'.repeat(257) }, head: {} }],
    ['an association of 2', { anchor: { assoc: 2 }, head: {} }],
    ['an association that is text', { anchor: { assoc: '0' }, head: {} }],
  ])('is no cursor where there is %s', (_, value) => {
    expect(readCursor(value)).toBeNull();
  });

  it('is rebuilt field by field, so that what an object carries beyond them goes no further', () => {
    const hostile = { anchor: { tname: 'a', assoc: 0 }, head: { tname: 'b' } };
    Object.defineProperty(hostile, '__proto__', { value: { polluted: true }, enumerable: false });
    const read = readCursor(hostile)!;
    expect(Object.keys(read)).toEqual(['anchor', 'head']);
    expect(read.anchor).toEqual({ tname: 'a', assoc: 0 });
    expect(read.anchor).not.toBe(hostile.anchor);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('what the server lets a connection say of itself (`pinAwareness`)', () => {
  const who = { name: 'Ada Owner', slot: 3 };
  const mine = cursor();
  const states = (...entries: [number, Record<string, unknown>][]) => new Map(entries);
  const none = new Set<number>();

  it('rebuilds the state under the connection’s own name and slot, whatever the client sent', () => {
    const map = states([
      7,
      { user: { name: 'Someone else', slot: 9, color: 'a colour of its own' }, cursor: mine, extra: 'x' },
    ]);
    pinAwareness(map, { own: none, others: none, who });
    expect([...map]).toEqual([[7, { user: { name: 'Ada Owner', slot: 3 }, cursor: mine }]]);
  });

  it('keeps the person and drops a cursor that is not one', () => {
    const map = states([7, { user: { name: 'x', slot: 1 }, cursor: { anchor: 1, head: 2 } }]);
    pinAwareness(map, { own: none, others: none, who });
    expect(map.get(7)).toEqual({ user: who });
  });

  it('gives a state that is no object, or has none of the fields, the name and the slot alone', () => {
    const map = states([7, {}], [8, 'text' as never]);
    pinAwareness(map, { own: new Set([7, 8]), others: none, who });
    expect(map.get(7)).toEqual({ user: who });
    expect(map.get(8)).toEqual({ user: who });
  });

  it('speaks for the identifier it has spoken with, and drops every other', () => {
    const map = states([7, { cursor: mine }], [8, { cursor: mine }], [9, { cursor: mine }]);
    pinAwareness(map, { own: new Set([8]), others: none, who });
    expect([...map.keys()]).toEqual([8]);
  });

  it('speaks for the first identifier no other connection holds, where it has none, and for one only', () => {
    const map = states([7, { cursor: mine }], [8, { cursor: mine }], [9, { cursor: mine }]);
    pinAwareness(map, { own: none, others: new Set([7]), who });
    // Not 7, which another holds; 8, the first that is free; and not 9 as well.
    expect([...map.keys()]).toEqual([8]);
  });

  it('drops an identifier that another connection holds, even where it has spoken for none', () => {
    const map = states([7, { cursor: mine }]);
    pinAwareness(map, { own: none, others: new Set([7]), who });
    expect(map.size).toBe(0);
  });

  it('drops every identifier but its own, however many are sent and in whatever order', () => {
    const map = states([1, {}], [2, {}], [3, {}], [4, {}]);
    pinAwareness(map, { own: new Set([3]), others: new Set([1, 2]), who });
    expect([...map.keys()]).toEqual([3]);
  });
});

/** An awareness message as a client sends it: the document's name, the type 1, and the update. */
function message(update: Uint8Array, name = '3f2b8c1e-5d4a-4e6f-9a7b-0c1d2e3f4a5b'): Uint8Array {
  const number = (value: number) => {
    const bytes: number[] = [];
    for (; value > 127; value = Math.floor(value / 128)) bytes.push(128 | (value % 128));
    return [...bytes, value];
  };
  const text = new TextEncoder().encode(name);
  return Uint8Array.from([...number(text.length), ...text, 1, ...number(update.length), ...update]);
}
/** What awareness writes for these clients. */
function update(...clients: number[]) {
  const document = new Y.Doc();
  const awareness = new Awareness(document);
  const ids = clients.map((each) => {
    awareness.states.set(each, { cursor: 1 });
    awareness.meta.set(each, { clock: 1, lastUpdated: Date.now() });
    return each;
  });
  const written = encodeAwarenessUpdate(awareness, ids);
  awareness.destroy();
  return written;
}

describe('awareness that is longer than a state can be (`awarenessTooLong`)', () => {
  // A payload of n bytes after a length of two bytes: the message holds n + 2 after the type.
  const payload = (n: number) => message(new Uint8Array(n));

  it('reads the limit as the bytes after the type, and counts none before it', () => {
    expect(awarenessTooLong(payload(AWARENESS_MAX_BYTES - 2))).toBe(false);
    expect(awarenessTooLong(payload(AWARENESS_MAX_BYTES - 1))).toBe(true);
    expect(awarenessTooLong(payload(5 * 1024 * 1024))).toBe(true);
    // A longer name of a document is not awareness.
    expect(awarenessTooLong(message(new Uint8Array(100), 'x'.repeat(400)))).toBe(false);
  });

  it('is not about another type of message, however long, nor about a message that is cut short', () => {
    const sync = message(new Uint8Array(8000));
    sync[1 + 36] = 0;
    expect(awarenessTooLong(sync)).toBe(false);
    expect(awarenessTooLong(new Uint8Array())).toBe(false);
    expect(awarenessTooLong(Uint8Array.from([200]))).toBe(false);
    expect(awarenessTooLong(Uint8Array.from([3, 97, 98]))).toBe(false);
  });
});

describe('the clients an awareness message speaks for (`awarenessClients`)', () => {
  it('are the identifiers it writes, in its order, and not the library’s own scratch state', () => {
    expect(awarenessClients(message(update(123456)))).toEqual([123456]);
    expect(awarenessClients(message(update(4294967295, 5, 300)))).toEqual([4294967295, 5, 300]);
  });

  it('are none, and not a guess, for what is not awareness or does not read to its end', () => {
    const real = message(update(123456));
    expect(awarenessClients(real.subarray(0, real.length - 3))).toBeNull();
    expect(awarenessClients(real.subarray(0, 38))).toBeNull();
    expect(awarenessClients(new Uint8Array())).toBeNull();
    const sync = real.slice();
    sync[1 + 36] = 0;
    expect(awarenessClients(sync)).toBeNull();
    // A count that is larger than the message holds.
    expect(awarenessClients(message(Uint8Array.from([50, 1, 1, 2, 123, 125])))).toBeNull();
    // A state that is longer than the update.
    expect(awarenessClients(message(Uint8Array.from([1, 1, 1, 100, 123, 125])))).toBeNull();
  });
});
