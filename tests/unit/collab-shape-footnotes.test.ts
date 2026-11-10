// The marker and the entry of a footnote in the shared document (FR-ED-05, NFR-SE-06;
// docs/plan/slice-20.md, section 4): the server holds each to an identifier of the one form
// and refuses an update that gives it anything else, whatever the content of the Yjs item that
// carries the value (the review of pull request 52 found that a check which looked at plain values
// alone let JSON, an embed and a format through, and this file asks all of them); a marker holds
// nothing; an entry is one block of the 5,000. Every answer is asked of the update both ways, with
// the copy of the document and without it, which must agree (as tests/unit/collab-shape.test.ts
// asks).
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc, updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { countsOf } from '../../src/app/(app)/documents/[id]/block-limits.ts';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { shapeOf, withCopy, withoutCopy, type Shape } from '../../src/lib/collab/shape.ts';

const schema = getSchema(extensions(new Y.Doc()));
const ID = '0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba98';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };
const text = (words: string): Json => ({ type: 'text', text: words });
const p = (...content: Json[]): Json => ({ type: 'paragraph', ...(content.length ? { content } : {}) });
const marker = (id: string | null = ID): Json => ({ type: 'footnoteReference', attrs: { id } });
const entry = (id: string | null = ID, ...content: Json[]): Json => ({
  type: 'footnote',
  attrs: { id },
  ...(content.length ? { content } : {}),
});
const list = (...entries: Json[]): Json => ({ type: 'footnotes', content: entries });
const doc = (...content: Json[]): Json => ({ type: 'doc', content });
const opened = (json: Json) => prosemirrorJSONToYDoc(schema, json, 'default');

function peerOf(server: Y.Doc) {
  const peer = new Y.Doc();
  Y.applyUpdate(peer, Y.encodeStateAsUpdate(server));
  return peer;
}
const sentBy = (peer: Y.Doc, server: Y.Doc) => Y.encodeStateAsUpdate(peer, Y.encodeStateVector(server));
/** What a client that is no editor sends. */
function sent(server: Y.Doc, change: (fragment: Y.XmlFragment) => void): Uint8Array {
  const peer = peerOf(server);
  peer.transact(() => change(peer.getXmlFragment('default')));
  return sentBy(peer, server);
}
function edited(server: Y.Doc, json: Json): Uint8Array {
  const peer = peerOf(server);
  peer.transact(() =>
    updateYFragment(peer, peer.getXmlFragment('default'), PMNode.fromJSON(schema, json), {
      mapping: new Map(),
      isOMark: new Map(),
    }),
  );
  return sentBy(peer, server);
}

/** The answer of the server, and the answer of the copy, which must agree. */
function answer(server: Y.Doc, update: Uint8Array): Shape | null {
  const shape = shapeOf(server, update);
  expect(withCopy(server, update)).toBe(shape);
  return shape;
}

/** An element as a client of its own makes it, each attribute set before it is put in the document. */
function made(
  name: string,
  attributes: Record<string, unknown>,
  children: (Y.XmlElement | Y.XmlText)[] = [],
) {
  const element = new Y.XmlElement(name);
  for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value as string);
  if (children.length > 0) element.insert(0, children);
  return element;
}
const words = (written: string) => {
  const run = new Y.XmlText();
  run.insert(0, written);
  return run;
};

/** The two nodes the rule is for: where each stands in a document that holds both, and how it is written. */
const NODES = [
  {
    name: 'footnoteReference',
    base: () => doc(p(text('x'), marker(), text('y')), list(entry(ID, text('note')))),
    /** An update that puts a new one in: a marker in the first paragraph, an entry in the list. */
    put: (attributes: Record<string, unknown>) => (fragment: Y.XmlFragment) =>
      (fragment.get(0) as Y.XmlElement).insert(1, [made('footnoteReference', attributes)]),
    existing: (fragment: Y.XmlFragment) => (fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement,
  },
  {
    name: 'footnote',
    base: () => doc(p(text('x'), marker(), text('y')), list(entry(ID, text('note')))),
    put: (attributes: Record<string, unknown>) => (fragment: Y.XmlFragment) =>
      (fragment.get(1) as Y.XmlElement).insert(1, [made('footnote', attributes, [words('more')])]),
    existing: (fragment: Y.XmlFragment) => (fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement,
  },
] as const;

describe.each(NODES)('the server holds a $name element to its identifier', (node) => {
  const server = () => opened(node.base());

  it('takes a new one with an identifier, with none, and with null', () => {
    const base = server();
    expect(answer(base, sent(base, node.put({ id: OTHER })))).toBeNull();
    expect(answer(base, sent(base, node.put({})))).toBeNull();
    expect(answer(base, sent(base, node.put({ id: null })))).toBeNull();
  });

  it.each([
    ['an address under src', { id: OTHER, src: 'https://example.com/pixel.png' }],
    ['an address under href', { href: 'https://example.com/pixel.png' }],
    ['an address under url', { url: 'http://169.254.169.254/latest/meta-data' }],
    ['a data URL under data', { data: 'data:text/html;base64,AAAA' }],
    ['a script under onclick', { onclick: 'alert(1)' }],
    ['a note under text', { text: 'the words of the footnote' }],
    ['a number under number', { number: 3 }],
    ['a class', { class: 'x' }],
    ['an address as the identifier', { id: 'https://example.com/pixel.png' }],
    ['an identifier that is a path', { id: '../../api/auth/sign-out' }],
    ['an identifier in capitals', { id: OTHER.toUpperCase() }],
    ['an identifier too short', { id: OTHER.slice(1) }],
    ['an identifier too long', { id: `${OTHER}0` }],
    ['an identifier with a line break at its end', { id: `${OTHER}\n` }],
    ['an identifier of 100,000 characters', { id: 'a'.repeat(100_000) }],
    ['an identifier that is a number', { id: 12345 }],
    ['an identifier that is true', { id: true }],
    ['an identifier that is an object', { id: { a: 1 } }],
    ['a value that is a shared type', { id: new Y.Map() }],
    ['a value that is binary', { id: new Uint8Array([1, 2, 3]) }],
  ])('refuses a new one with %s', (_name, attributes) => {
    const base = server();
    expect(answer(base, sent(base, node.put(attributes)))).toBe('footnote');
  });

  it('refuses a bad attribute among good ones', () => {
    const base = server();
    expect(answer(base, sent(base, node.put({ id: OTHER, src: 'https://example.com/x.png' })))).toBe(
      'footnote',
    );
  });

  describe('that is there', () => {
    it('takes a change of its identifier, as the editor makes one, without a copy of the document', () => {
      const base = server();
      const update = sent(base, (fragment) => node.existing(fragment).setAttribute('id', OTHER));
      expect(answer(base, update)).toBeNull();
      expect(withoutCopy(base, Y.decodeUpdate(update))).not.toBeUndefined();
    });

    it.each([
      ['src', 'https://example.com/pixel.png'],
      ['href', 'https://example.com/pixel.png'],
      ['onerror', 'alert(1)'],
      ['id', 'https://example.com/pixel.png'],
      ['id', OTHER.toUpperCase()],
      ['id', 7],
    ])('refuses an attribute set later: %s', (name, value) => {
      const base = server();
      const update = sent(base, (fragment) => node.existing(fragment).setAttribute(name, value as string));
      expect(answer(base, update)).toBe('footnote');
      // Without the copy, as a browser's update is answered.
      expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('footnote');
    });

    it('refuses an attribute set again after it was set once, so that the second is the one that stands', () => {
      const base = server();
      const update = sent(base, (fragment) => {
        node.existing(fragment).setAttribute('id', OTHER);
        node.existing(fragment).setAttribute('id', 'https://example.com/pixel.png');
      });
      expect(answer(base, update)).toBe('footnote');
    });

    it('takes a bad value that the same update writes over with a good one: it stands nowhere', () => {
      const base = server();
      const update = sent(base, (fragment) => {
        node.existing(fragment).setAttribute('id', 'not an identifier');
        node.existing(fragment).setAttribute('id', OTHER);
      });
      expect(answer(base, update)).toBeNull();
    });

    it('takes the removal of its identifier, and its own removal', () => {
      const base = server();
      expect(
        answer(
          base,
          sent(base, (fragment) => node.existing(fragment).removeAttribute('id')),
        ),
      ).toBeNull();
    });
  });
});

describe('the rule looks at no other element, and at both of these wherever they stand', () => {
  it('leaves an attribute of a paragraph or an image to the rules that are theirs', () => {
    const server = opened(doc(p(text('x'), marker()), list(entry())));
    const update = sent(server, (fragment) =>
      (fragment.get(0) as Y.XmlElement).setAttribute('src', 'https://example.com/x.png'),
    );
    expect(answer(server, update)).toBeNull();
  });

  it('refuses a marker with a bad attribute that stands in a list, a quote, a cell or a callout as in a paragraph', () => {
    const server = opened(doc(p(text('x'))));
    for (const wrap of [
      (inner: Y.XmlElement) => made('blockquote', {}, [made('paragraph', {}, [inner])]),
      (inner: Y.XmlElement) =>
        made('bulletList', {}, [made('listItem', {}, [made('paragraph', {}, [inner])])]),
      (inner: Y.XmlElement) => made('callout', { type: 'note' }, [made('paragraph', {}, [inner])]),
    ]) {
      const update = sent(server, (fragment) =>
        fragment.insert(fragment.length, [wrap(made('footnoteReference', { id: 'https://example.com/x' }))]),
      );
      expect(answer(server, update)).toBe('footnote');
    }
  });
});

// The review of pull request 52 (B1), asked again for the footnote: a value of an attribute is not always a
// plain value. Yjs decodes JSON, an embed and a format as the content of an item too, and `getAttribute`
// hands the first two back as it does a plain value. A client that is no editor can write any of them, and
// `setAttribute` makes a plain value every time. Here the item is made, and its content is replaced before
// the update is encoded, which is what such a client sends.
describe.each(NODES)(
  '$name is held to its identifier whatever the content that carries a value (B1)',
  (node) => {
    const base = () => opened(node.base());

    function carried(server: Y.Doc, name: string, value: string | number, make: () => Y.Item['content']) {
      const peer = peerOf(server);
      peer.transact(() => node.existing(peer.getXmlFragment('default')).setAttribute(name, value as string));
      const element = node.existing(peer.getXmlFragment('default'));
      const item = element._map.get(name) as Y.Item;
      item.content = make();
      return sentBy(peer, server);
    }

    const JSON_OF = (value: unknown) => () => new Y.ContentJSON([value]);
    const EMBED_OF = (value: unknown) => () => new Y.ContentEmbed(value as object);
    const FORMAT_OF = () => new Y.ContentFormat('src', 'https://example.com/pixel.png');

    it.each([
      [
        'JSON carrying an address under src',
        'src',
        'https://evil.example/x.png',
        JSON_OF('https://evil.example/x.png'),
      ],
      [
        'JSON carrying a path as the identifier',
        'id',
        '../../api/auth/sign-out',
        JSON_OF('../../api/auth/sign-out'),
      ],
      ['JSON carrying an identifier of 100,000 characters', 'id', 'x', JSON_OF('x'.repeat(100_000))],
      ['JSON that is a good identifier', 'id', OTHER, JSON_OF(OTHER)],
      [
        'an embed carrying an address under src',
        'src',
        'https://evil.example/x.png',
        EMBED_OF('https://evil.example/x.png'),
      ],
      ['an embed carrying a path as the identifier', 'id', '../x', EMBED_OF('../x')],
      ['an embed that is a good identifier', 'id', OTHER, EMBED_OF(OTHER)],
      ['a format that hides the identifier', 'id', OTHER, FORMAT_OF],
      ['a format under src', 'src', 'x', FORMAT_OF],
    ] as const)('refuses %s', (_name, attribute, value, make) => {
      const server = base();
      const update = carried(server, attribute, value, make);
      expect(answer(server, update)).toBe('footnote');
      // Without the copy, as a browser's update is answered, and not by the copy alone.
      expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('footnote');
    });

    it('is what the early return of the check let through: an update of this one struct is not skipped as no value', () => {
      const server = base();
      const update = carried(
        server,
        'src',
        'https://evil.example/x.png',
        JSON_OF('https://evil.example/x.png'),
      );
      const read = Y.decodeUpdate(update);
      expect(read.structs).toHaveLength(1);
      expect(read.structs[0]).toBeInstanceOf(Y.Item);
      expect((read.structs[0] as Y.Item).content).toBeInstanceOf(Y.ContentJSON);
      expect(shapeOf(server, update)).toBe('footnote');
    });

    it('still takes an update that only deletes', () => {
      const server = base();
      expect(
        answer(
          server,
          sent(server, (fragment) => fragment.delete(0, 1)),
        ),
      ).toBeNull();
    });
  },
);

describe('a marker holds nothing, and an entry holds text (FR-ED-05)', () => {
  it('refuses text or an element put inside a marker that is there already', () => {
    const server = opened(doc(p(text('x'), marker(), text('y')), list(entry())));
    for (const inner of [new Y.XmlText('hidden'), new Y.XmlElement('paragraph')] as const) {
      const update = sent(server, (fragment) =>
        ((fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement).insert(0, [inner.clone()]),
      );
      expect(answer(server, update)).toBe('leaf');
      expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('leaf');
    }
  });

  it('refuses a marker made with a child in one change', () => {
    const server = opened(doc(p(text('x')), p(text('y'))));
    const update = sent(server, (fragment) =>
      (fragment.get(0) as Y.XmlElement).insert(1, [
        made('footnoteReference', { id: ID }, [new Y.XmlElement('paragraph')]),
      ]),
    );
    expect(answer(server, update)).toBe('leaf');
  });

  it('takes text in an entry, which is what it is for, and an entry made whole', () => {
    const server = opened(doc(p(text('x'), marker()), list(entry(ID, text('note')))));
    const typed = sent(server, (fragment) => {
      const run = ((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
      run.insert(4, ' and more');
    });
    expect(answer(server, typed)).toBeNull();
    const whole = sent(server, (fragment) =>
      (fragment.get(1) as Y.XmlElement).insert(1, [made('footnote', { id: OTHER }, [words('another')])]),
    );
    expect(answer(server, whole)).toBeNull();
  });

  it('takes a list with no entry in it, which the schema allows: no list is ever deleted once it is made (B2)', () => {
    const server = opened(doc(p(text('x'))));
    const update = sent(server, (fragment) => fragment.insert(fragment.length, [made('footnotes', {})]));
    expect(answer(server, update)).toBeNull();
  });

  it('refuses any attribute on the list, whatever its value (the list has none)', () => {
    const server = opened(doc(p(text('x'), marker()), list(entry(ID, text('note')))));
    for (const value of ['x', '', 'https://evil.example/x.png', 1]) {
      const update = sent(server, (fragment) =>
        (fragment.get(1) as Y.XmlElement).setAttribute('class', value as string),
      );
      expect(answer(server, update)).toBe('footnote');
      expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('footnote');
    }
    // A list made with the attribute, in one change.
    const whole = sent(server, (fragment) =>
      fragment.insert(fragment.length, [made('footnotes', { id: OTHER })]),
    );
    expect(answer(server, whole)).toBe('footnote');
    expect(withoutCopy(server, Y.decodeUpdate(whole))).toBe('footnote');
  });

  it('refuses a value of two on an attribute of a marker, and an attribute that holds a subdocument (S5)', () => {
    const server = opened(doc(p(text('x'), marker(), text('y')), list(entry(ID, text('note')))));
    const existing = (fragment: Y.XmlFragment) => (fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement;
    const carried = (make: () => Y.Item['content']) => {
      const peer = peerOf(server);
      peer.transact(() => existing(peer.getXmlFragment('default')).setAttribute('id', OTHER));
      (existing(peer.getXmlFragment('default'))._map.get('id') as Y.Item).content = make();
      return sentBy(peer, server);
    };
    // Two values in one item: the identifier that is good first, a second behind it.
    const two = carried(() => new Y.ContentAny([OTHER, '../../x']));
    expect(answer(server, two)).toBe('footnote');
    expect(withoutCopy(server, Y.decodeUpdate(two))).toBe('footnote');
    // Made as a client makes it: a document as the value.
    const sub = sent(server, (fragment) =>
      existing(fragment).setAttribute('id', new Y.Doc() as unknown as string),
    );
    expect(Y.decodeUpdate(sub).structs.some((s) => (s as Y.Item).content instanceof Y.ContentDoc)).toBe(true);
    expect(answer(server, sub)).toBe('footnote');
    expect(withoutCopy(server, Y.decodeUpdate(sub))).toBe('footnote');
  });

  it('takes what the editor writes for a footnote', () => {
    const server = opened(doc(p(text('x')), p(text('y'))));
    const update = edited(server, doc(p(text('x'), marker()), p(text('y')), list(entry(ID))));
    expect(answer(server, update)).toBeNull();
    const next = new Y.Doc();
    Y.applyUpdate(next, Y.encodeStateAsUpdate(server));
    Y.applyUpdate(next, update);
    const more = edited(
      next,
      doc(p(text('x'), marker(), marker(OTHER)), p(text('y')), list(entry(ID), entry(OTHER))),
    );
    expect(answer(next, more)).toBeNull();
  });
});

// B1 of the review of pull request 55: a value that is no element and no text, put among the children of an
// element or of the root. The editor never writes one, the binding reads such a child as nothing it knows and
// writes the document again without it, but the server held the value in the shared document, where a reader
// of the export or the record would find it. The rule looks at the Yjs item whatever stands in it.
describe('a raw value among the children is refused wherever the children stand (B1)', () => {
  const server = () => opened(doc(p(text('x'), marker(), text('y')), list(entry(ID, text('note')))));
  /** Where a child may be put: the root, a paragraph, a marker, the list, an entry. */
  const PLACES = [
    ['the root', (fragment: Y.XmlFragment) => fragment],
    ['a paragraph', (fragment: Y.XmlFragment) => fragment.get(0) as Y.XmlElement],
    // The marker is the leaf the review named: a value inside it is refused as a value, whatever its kind.
    ['a marker', (fragment: Y.XmlFragment) => (fragment.get(0) as Y.XmlElement).get(1) as Y.XmlElement],
    ['the list of footnotes', (fragment: Y.XmlFragment) => fragment.get(1) as Y.XmlElement],
    ['an entry', (fragment: Y.XmlFragment) => (fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement],
  ] as const;
  const RAW = [
    ['a string', () => 'raw'],
    ['a number', () => 7],
    ['a boolean', () => true],
    ['an object', () => ({ a: 1 })],
    ['an array', () => [1, 2]],
    ['bytes', () => new Uint8Array([1, 2, 3])],
    ['a subdocument', () => new Y.Doc()],
  ] as const;

  describe.each(PLACES)('among the children of %s', (_where, parent) => {
    it.each(RAW)('refuses %s, put in at the end and at the start', (_what, value) => {
      for (const at of ['start', 'end'] as const) {
        const base = server();
        const update = sent(base, (fragment) => {
          const holder = parent(fragment);
          holder.insert(at === 'start' ? 0 : holder.length, [value() as never]);
        });
        expect(answer(base, update)).toBe('raw');
        expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('raw');
      }
    });

    it.each([
      // A string that is the child itself: only a client of its own writes one (`insert` makes a value of it).
      ['a string', () => new Y.ContentString('r')],
      ['JSON', () => new Y.ContentJSON(['raw'])],
      ['an embed', () => new Y.ContentEmbed({ a: 1 })],
      ['a format', () => new Y.ContentFormat('bold', true)],
    ] as const)('refuses %s that is put in as the child by a client of its own', (_what, make) => {
      const base = server();
      const peer = peerOf(base);
      peer.transact(() => parent(peer.getXmlFragment('default')).insert(0, ['raw'] as never));
      const holder = parent(peer.getXmlFragment('default'));
      (holder._start as Y.Item).content = make();
      const update = sentBy(peer, base);
      expect(answer(base, update)).toBe('raw');
      expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('raw');
    });
  });

  it('refuses an embed in a run of text, where only characters and formats stand', () => {
    const base = server();
    const update = sent(base, (fragment) => {
      const run = ((fragment.get(1) as Y.XmlElement).get(0) as Y.XmlElement).get(0) as Y.XmlText;
      run.insertEmbed(2, { a: 1 });
    });
    expect(answer(base, update)).toBe('raw');
    expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('raw');
  });

  it('refuses text put among the children of a list that holds no text, where it is no value and no element', () => {
    // A run of text is an element of the Yjs type, and the rule of the shape (a list holds entries) and of the
    // leaves is theirs: what this rule adds is the value that is neither.
    const base = server();
    const update = sent(base, (fragment) => (fragment.get(0) as Y.XmlElement).insert(0, ['raw'] as never));
    expect(answer(base, update)).toBe('raw');
  });

  it('takes what the editor writes: elements, runs of text with their formats, hard breaks, a deletion', () => {
    const base = server();
    expect(
      answer(base, edited(base, doc(p(text('x'), marker(OTHER), text('y')), list(entry(OTHER, text('n')))))),
    ).toBeNull();
    expect(
      answer(
        base,
        sent(base, (fragment) => fragment.delete(0, 1)),
      ),
    ).toBeNull();
  });

  it('does not refuse an update that deletes a raw value which is already there', () => {
    // A document that was written before the rule: its raw value must be removable, or the document is stuck.
    const base = server();
    const peer = peerOf(base);
    peer.transact(() => (peer.getXmlFragment('default').get(0) as Y.XmlElement).insert(0, ['raw'] as never));
    Y.applyUpdate(base, sentBy(peer, base));
    const update = sent(base, (fragment) => (fragment.get(0) as Y.XmlElement).delete(0, 1));
    expect(answer(base, update)).toBeNull();
  });
});

// S-02 of the audit of November 2026: the server loads the stored state into a document of its own and asks
// nothing of its root until the first store, so that the root is a type of no kind until then. The fast path
// found the parent through the item beside, or by its key, and asked the kind of that type: none, so no rule.
describe('a raw value at the root of a document the server has only loaded is refused (S-02)', () => {
  /** The server's copy as a load leaves it: the stored state applied to a document, and nothing asked of it. */
  const loaded = (json: Json = doc(p(text('x')), p(text('y')))) => {
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(opened(json)));
    return server;
  };

  it.each([
    ['after the first paragraph', 1],
    ['at the start', 0],
    ['at the end', 2],
  ] as const)('refuses a string put in %s', (_where, at) => {
    const server = loaded();
    const update = sent(server, (fragment) => fragment.insert(at, ['raw'] as never));
    expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('raw');
    expect(answer(server, update)).toBe('raw');
    // Asking did not give the root a kind: the answer stands on what a load leaves.
    expect(server.share.get('default')).not.toBeInstanceOf(Y.XmlFragment);
  });

  it('refuses a string put into a root whose children were all deleted, which names the root by its key', () => {
    const base = loaded();
    Y.applyUpdate(
      base,
      sent(base, (fragment) => fragment.delete(0, 2)),
    );
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(base));
    const update = sent(server, (fragment) => fragment.insert(0, ['raw'] as never));
    expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('raw');
    expect(answer(server, update)).toBe('raw');
  });

  it('takes what the editor writes there', () => {
    const server = loaded();
    expect(answer(server, edited(server, doc(p(text('x')), p(text('z')), p(text('y')))))).toBeNull();
  });
});

// S-03 of the audit of November 2026: the rule asked only whether a child was a shared type, not which one. The
// binding throws on a root child that is no element, and on a child of an element that is neither an element
// nor a run of text, so that the document cannot be opened.
describe('a shared type that is no element and no run of text is refused among the children (S-03)', () => {
  const typed = () => opened(doc(p(text('x')), p(text('y'))));
  const untyped = () => {
    const server = new Y.Doc();
    Y.applyUpdate(server, Y.encodeStateAsUpdate(typed()));
    return server;
  };
  const AT_THE_ROOT = [
    ['a map', () => new Y.Map()],
    ['a run of text', () => new Y.XmlText('raw')],
    ['an array', () => new Y.Array()],
    ['a plain text', () => new Y.Text('raw')],
    ['a hook', () => new Y.XmlHook('raw')],
    ['a fragment', () => new Y.XmlFragment()],
  ] as const;
  const IN_A_PARAGRAPH = [
    ['a map', () => new Y.Map()],
    ['an array', () => new Y.Array()],
    ['a plain text', () => new Y.Text('raw')],
    ['a hook', () => new Y.XmlHook('raw')],
    ['a fragment', () => new Y.XmlFragment()],
  ] as const;

  describe.each([
    ['a root that has its kind', typed],
    ['a root the server has only loaded', untyped],
  ] as const)('on %s', (_root, server) => {
    it.each(AT_THE_ROOT)('refuses %s at the root, without the copy and on it', (_what, make) => {
      for (const at of [0, 1, 2]) {
        const base = server();
        const update = sent(base, (fragment) => fragment.insert(at, [make() as never]));
        expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('raw');
        expect(withCopy(base, update)).toBe('raw');
      }
    });

    it.each(IN_A_PARAGRAPH)('refuses %s inside a paragraph, without the copy and on it', (_what, make) => {
      for (const at of [0, 1]) {
        const base = server();
        const update = sent(base, (fragment) =>
          (fragment.get(0) as Y.XmlElement).insert(at, [make() as never]),
        );
        expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('raw');
        expect(withCopy(base, update)).toBe('raw');
      }
    });

    it('refuses a map inside a paragraph the update makes', () => {
      const base = server();
      const update = sent(base, (fragment) => {
        const made = new Y.XmlElement('paragraph');
        made.insert(0, [new Y.XmlText('a'), new Y.Map() as never]);
        fragment.insert(1, [made]);
      });
      expect(withoutCopy(base, Y.decodeUpdate(update))).toBe('raw');
      expect(withCopy(base, update)).toBe('raw');
    });

    it('takes an element at the root and a run of text inside an element', () => {
      const base = server();
      const update = sent(base, (fragment) => {
        const made = new Y.XmlElement('paragraph');
        made.insert(0, [new Y.XmlText('a')]);
        fragment.insert(1, [made]);
      });
      expect(answer(base, update)).toBeNull();
      expect(withoutCopy(base, Y.decodeUpdate(update))).toBeNull();
    });
  });
});

describe('an entry is one block of the 5,000 (register row S20-2)', () => {
  const blocksOf = (server: Y.Doc) =>
    countsOf(yXmlFragmentToProseMirrorRootNode(server.getXmlFragment('default'), schema)).blocks;
  const paragraphs = (count: number) => Array.from({ length: count }, () => p());
  const ids = (count: number) => Array.from({ length: count }, (_, at) => at.toString(16).padStart(24, '0'));

  it('is counted as the browser counts it: each entry one, the list and the marker none', () => {
    const server = opened(doc(...paragraphs(10), p(marker(ID)), list(entry(ID, text('a')))));
    expect(blocksOf(server)).toBe(12);
    const three = ids(3);
    const more = opened(doc(p(...three.map((id) => marker(id))), list(...three.map((id) => entry(id)))));
    expect(blocksOf(more)).toBe(4);
  });

  it('takes the document to 5,000 blocks with an entry, and refuses the entry that makes 5,001', () => {
    // 4,999 blocks, with a marker whose entry is not there yet: the entry is the 5,000th.
    const under = opened(doc(...paragraphs(4998), p(marker(ID))));
    expect(blocksOf(under)).toBe(4999);
    const last = edited(under, doc(...paragraphs(4998), p(marker(ID)), list(entry(ID))));
    expect(answer(under, last)).toBeNull();

    const at = opened(doc(...paragraphs(4998), p(marker(ID)), list(entry(ID))));
    expect(blocksOf(at)).toBe(5000);
    const another = [...ids(1)];
    const over = edited(
      at,
      doc(...paragraphs(4998), p(marker(ID), marker(another[0]!)), list(entry(ID), entry(another[0]!))),
    );
    expect(answer(at, over)).toBe('blocks');
    // The same with an element a client makes whole in one change, answered without the copy.
    const update = sent(at, (fragment) =>
      (fragment.get(fragment.length - 1) as Y.XmlElement).insert(1, [
        made('footnote', { id: OTHER }, [words('x')]),
      ]),
    );
    expect(answer(at, update)).toBe('blocks');
    expect(withoutCopy(at, Y.decodeUpdate(update))).toBe('blocks');
  });

  it('allows a document that is past the limit to lose an entry, as it can lose any block', () => {
    const over = opened(doc(...paragraphs(5005), p(marker(ID)), list(entry(ID))));
    expect(answer(over, edited(over, doc(...paragraphs(5005), p())))).toBeNull();
  });
});
