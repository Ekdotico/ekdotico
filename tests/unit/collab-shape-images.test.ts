// The image block in the shared document (FR-ED-08, NFR-SE-06 A01; register row
// S19-6): the server holds an image element to an identifier, the words of the
// block and its width, and refuses an update that gives it anything else, an
// address under any name above all; and the block is one block of the 5,000.
// Every answer is asked of the update both ways, with the copy of the document
// and without it, which must agree (as tests/unit/collab-shape.test.ts asks).
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc, updateYFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import { Node as PMNode } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { countsOf } from '../../src/app/(app)/documents/[id]/block-limits.ts';
import { extensions } from '../../src/app/(app)/documents/[id]/extensions.tsx';
import { shapeOf, withCopy, withoutCopy, type Shape } from '../../src/lib/collab/shape.ts';
import { IMAGE_ALT_MOST } from '../../src/lib/images/node.ts';

const schema = getSchema(extensions(new Y.Doc()));
const ID = 'cl0123456789abcdefghijklm';
const OTHER = 'cm0123456789abcdefghijklm';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };
const p = (): Json => ({ type: 'paragraph' });
const imageJson = (id: string | null = ID): Json => ({
  type: 'image',
  attrs: { id, alt: '', caption: '', width: 100 },
});
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

/** An image element as a client of its own makes it, each attribute set before it is put in the document. */
function image(attributes: Record<string, unknown>): Y.XmlElement {
  const made = new Y.XmlElement('image');
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, value as string);
  return made;
}
const putImage = (attributes: Record<string, unknown>) => (fragment: Y.XmlFragment) =>
  fragment.insert(fragment.length, [image(attributes)]);

describe('the server holds an image element to its attributes', () => {
  const server = () => opened(doc(p(), p()));

  it('takes an image block with its identifier, its words and its width', () => {
    const base = server();
    expect(
      answer(base, sent(base, putImage({ id: ID, alt: 'A graph', caption: 'Figure 1', width: 50 }))),
    ).toBeNull();
    expect(answer(base, sent(base, putImage({})))).toBeNull();
    expect(answer(base, sent(base, putImage({ id: null, alt: '', caption: '', width: 100 })))).toBeNull();
  });

  it('takes what the editor writes for an image', () => {
    const base = server();
    expect(answer(base, edited(base, doc(p(), p(), imageJson())))).toBeNull();
    expect(answer(base, edited(base, doc(imageJson(), p(), imageJson(OTHER))))).toBeNull();
  });

  it.each([
    ['an address under src', { id: ID, src: 'https://example.com/pixel.png' }],
    ['an address under href', { href: 'https://example.com/pixel.png' }],
    ['an address under srcset', { srcset: 'https://example.com/pixel.png 2x' }],
    ['an address under url', { url: 'http://169.254.169.254/latest/meta-data' }],
    ['a data URL under data', { data: 'data:image/png;base64,AAAA' }],
    ['a script under onload', { onload: 'alert(1)' }],
    [
      'the object key of an image, under key',
      { key: 'images/2a7f6c1e-5b1c-4d3e-9a58-0d8c3a9d4e11/aabbccddeeff00112233445566778899' },
    ],
    ['an address as the identifier', { id: 'https://example.com/pixel.png' }],
    ['an identifier that is a path', { id: '../../etc/passwd' }],
    ['an identifier of another form', { id: 'not-a-cuid' }],
    ['an identifier that is a number', { id: 12345 }],
    ['an alt text over its bound', { alt: 'a'.repeat(IMAGE_ALT_MOST + 1) }],
    ['an alt text that is not text', { alt: 5 }],
    ['a caption that is not text', { caption: true }],
    ['a width written as text', { width: '50' }],
    ['a width under its bound', { width: 5 }],
    ['a width over its bound', { width: 101 }],
    ['a width that is not whole', { width: 33.5 }],
    ['a value that is a shared type', { alt: new Y.Map() }],
    ['a value that is binary', { alt: new Uint8Array([1, 2, 3]) }],
  ])('refuses %s', (_name, attributes) => {
    const base = server();
    expect(answer(base, sent(base, putImage(attributes)))).toBe('image');
  });

  it('refuses a bad attribute among good ones, and a good block beside it is not the reason it is taken', () => {
    const base = server();
    expect(
      answer(
        base,
        sent(
          base,
          putImage({ id: ID, alt: 'fine', caption: 'fine', width: 50, src: 'https://example.com/x.png' }),
        ),
      ),
    ).toBe('image');
  });

  it('refuses one bad image in an update that makes several elements', () => {
    const base = server();
    const update = sent(base, (fragment) =>
      fragment.insert(fragment.length, [
        new Y.XmlElement('paragraph'),
        image({ id: ID }),
        image({ src: 'https://example.com/x.png' }),
      ]),
    );
    expect(answer(base, update)).toBe('image');
  });

  describe('of an image block that is there', () => {
    const blockAt = (fragment: Y.XmlFragment) => fragment.get(1) as Y.XmlElement;
    const base = () => opened(doc(p(), imageJson(), p()));

    it('takes a change of its words and of its width, without a copy of the document', () => {
      const server = base();
      for (const [name, value] of [
        ['alt', 'A new text'],
        ['caption', 'Figure 2'],
        ['width', 75],
        ['id', OTHER],
      ] as const) {
        const update = sent(server, (fragment) => blockAt(fragment).setAttribute(name, value as string));
        expect(answer(server, update), name).toBeNull();
        expect(withoutCopy(server, Y.decodeUpdate(update)), name).not.toBeUndefined();
      }
    });

    it.each([
      ['src', 'https://example.com/pixel.png'],
      ['href', 'https://example.com/pixel.png'],
      ['onerror', 'alert(1)'],
      ['id', 'https://example.com/pixel.png'],
      ['width', '50'],
      ['width', 2000],
      ['alt', 'a'.repeat(IMAGE_ALT_MOST + 1)],
    ])('refuses an attribute set later: %s', (name, value) => {
      const server = base();
      const update = sent(server, (fragment) => blockAt(fragment).setAttribute(name, value as string));
      expect(answer(server, update)).toBe('image');
      // Without the copy, as a browser's update is answered.
      expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('image');
    });

    it('refuses an attribute set again after it was set once, so that the second is the one that stands', () => {
      const server = base();
      sent(server, (fragment) => blockAt(fragment).setAttribute('alt', 'first'));
      const update = sent(server, (fragment) => {
        blockAt(fragment).setAttribute('alt', 'second');
        blockAt(fragment).setAttribute('src', 'https://example.com/pixel.png');
      });
      expect(answer(server, update)).toBe('image');
    });

    it('takes a bad value that the same update writes over with a good one: it stands nowhere', () => {
      const server = base();
      const update = sent(server, (fragment) => {
        blockAt(fragment).setAttribute('alt', 'a'.repeat(IMAGE_ALT_MOST + 1));
        blockAt(fragment).setAttribute('alt', 'fine');
      });
      expect(answer(server, update)).toBeNull();
    });

    it('takes the removal of an attribute and of the block', () => {
      const server = base();
      expect(
        answer(
          server,
          sent(server, (fragment) => blockAt(fragment).removeAttribute('alt')),
        ),
      ).toBeNull();
      expect(
        answer(
          server,
          sent(server, (fragment) => fragment.delete(1, 1)),
        ),
      ).toBeNull();
    });
  });

  it('looks at no other element: an attribute of a paragraph or a table is not this rule’s', () => {
    const server = opened(doc(p(), p()));
    const update = sent(server, (fragment) =>
      (fragment.get(0) as Y.XmlElement).setAttribute('src', 'https://example.com/x.png'),
    );
    expect(answer(server, update)).toBeNull();
    // The same name on an element that is named otherwise in the update.
    expect(
      answer(
        server,
        sent(server, (fragment) => {
          const made = new Y.XmlElement('paragraph');
          made.setAttribute('src', 'https://example.com/x.png');
          fragment.insert(fragment.length, [made]);
        }),
      ),
    ).toBeNull();
  });

  it('refuses an image block that stands in a list, a quote or a cell as it refuses one at the top', () => {
    const server = opened(doc(p()));
    const update = sent(server, (fragment) => {
      const item = new Y.XmlElement('listItem');
      item.insert(0, [new Y.XmlElement('paragraph'), image({ src: 'https://example.com/x.png' })]);
      const list = new Y.XmlElement('bulletList');
      list.insert(0, [item]);
      fragment.insert(fragment.length, [list]);
    });
    expect(answer(server, update)).toBe('image');
  });
});

// The review of pull request 52 (B1): a value of an attribute is not always a plain value. Yjs decodes
// JSON, an embed and a format as the content of an item too, and `getAttribute` hands the first two back as
// it does a plain value. A client that is no editor can write any of them, and the tests above never did:
// `setAttribute` makes a plain value every time. Here the item is made, and its content is replaced before
// the update is encoded, which is what such a client sends.
describe('an image block is held to its attributes whatever the content that carries a value (B1)', () => {
  const base = () => opened(doc(p(), imageJson(), p()));

  /** An update that sets `name` on the image block, its item holding `make()` where a client would hold a plain value. */
  function carried(server: Y.Doc, name: string, value: string | number, make: () => Y.Item['content']) {
    const peer = peerOf(server);
    peer.transact(() =>
      (peer.getXmlFragment('default').get(1) as Y.XmlElement).setAttribute(name, value as string),
    );
    const element = peer.getXmlFragment('default').get(1) as Y.XmlElement;
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
    ['JSON carrying an alt text of 100,000 characters', 'alt', 'x', JSON_OF('x'.repeat(100_000))],
    ['JSON carrying a width of 9999', 'width', 9999, JSON_OF(9999)],
    [
      'an embed carrying an address under src',
      'src',
      'https://evil.example/x.png',
      EMBED_OF('https://evil.example/x.png'),
    ],
    ['an embed carrying a path as the identifier', 'id', '../x', EMBED_OF('../x')],
    ['an embed carrying a width of 9999', 'width', 9999, EMBED_OF(9999)],
    ['a format that hides the identifier', 'id', ID, FORMAT_OF],
    ['a format that hides the width', 'width', 50, FORMAT_OF],
    ['a format under src', 'src', 'x', FORMAT_OF],
  ] as const)('refuses %s', (_name, attribute, value, make) => {
    const server = base();
    const update = carried(server, attribute, value, make);
    expect(answer(server, update)).toBe('image');
    // Without the copy, as a browser's update is answered, and not by the copy alone.
    expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('image');
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
    expect(shapeOf(server, update)).toBe('image');
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

  // The editor writes a plain value and no other kind, so a value in form that arrives as JSON is refused as well.
  it('refuses a value that is in form where it is carried as the editor never carries one', () => {
    const server = base();
    expect(answer(server, carried(server, 'alt', 'fine', JSON_OF('fine')))).toBe('image');
    expect(answer(server, carried(server, 'width', 50, EMBED_OF(50)))).toBe('image');
  });
});

// The review of pull request 52 (S7): a block that holds nothing holds nothing. An image hidden in a divider
// would count as placed (`imageIdsIn` walks into every element) and its row would never be deleted.
describe('a block that holds nothing is refused an element or text inside it (S7)', () => {
  it.each([
    ['an image', 'image'],
    ['a divider', 'horizontalRule'],
    ['a table of contents', 'tableOfContents'],
    ['a page break', 'pageBreak'],
  ])('refuses text put inside %s that is there already', (_name, type) => {
    const server = opened(doc(p(), { type }, p()));
    const update = sent(server, (fragment) =>
      (fragment.get(1) as Y.XmlElement).insert(0, [new Y.XmlText('hidden')]),
    );
    expect(answer(server, update)).toBe('leaf');
    expect(withoutCopy(server, Y.decodeUpdate(update))).toBe('leaf');
  });

  it('refuses an image hidden in a divider, which would count as placed and never be deleted', () => {
    const server = opened(doc(p(), { type: 'horizontalRule' }, p()));
    const update = sent(server, (fragment) =>
      (fragment.get(1) as Y.XmlElement).insert(0, [image({ id: ID })]),
    );
    expect(answer(server, update)).toBe('leaf');
  });

  it('refuses an element made with a child in one change, an image or a divider among them', () => {
    const server = opened(doc(p()));
    for (const name of ['image', 'horizontalRule', 'tableOfContents', 'pageBreak']) {
      const update = sent(server, (fragment) => {
        const made = new Y.XmlElement(name);
        made.insert(0, [new Y.XmlElement('paragraph')]);
        fragment.insert(fragment.length, [made]);
      });
      expect(answer(server, update), name).toBe('leaf');
    }
  });

  it('takes a child that is deleted in the same update, and every block that is meant to hold something', () => {
    const server = opened(doc(p(), imageJson(), p()));
    const hidden = sent(server, (fragment) => {
      const block = fragment.get(1) as Y.XmlElement;
      block.insert(0, [new Y.XmlText('gone')]);
      block.delete(0, 1);
    });
    expect(answer(server, hidden)).toBeNull();
    const holding = sent(server, (fragment) => {
      const quote = new Y.XmlElement('blockquote');
      quote.insert(0, [new Y.XmlElement('paragraph')]);
      fragment.insert(fragment.length, [quote]);
    });
    expect(answer(server, holding)).toBeNull();
    expect(answer(server, edited(server, doc(p(), imageJson(), p(), imageJson(OTHER))))).toBeNull();
  });
});

describe('an image block is one block of the 5,000 (register row S19-6)', () => {
  const blocksOf = (server: Y.Doc) =>
    countsOf(yXmlFragmentToProseMirrorRootNode(server.getXmlFragment('default'), schema)).blocks;
  const paragraphs = (count: number) => Array.from({ length: count }, p);

  it('is counted as the browser counts it, and as one', () => {
    const server = opened(doc(...paragraphs(10), imageJson(), imageJson(OTHER)));
    expect(blocksOf(server)).toBe(12);
  });

  it('takes the document to 5,000 blocks and refuses the 5,001st, the block being an image', () => {
    const under = opened(doc(...paragraphs(4999)));
    const last = edited(under, doc(...paragraphs(4999), imageJson()));
    expect(answer(under, last)).toBeNull();

    const at = opened(doc(...paragraphs(4999), imageJson()));
    expect(blocksOf(at)).toBe(5000);
    expect(answer(at, edited(at, doc(...paragraphs(4999), imageJson(), imageJson(OTHER))))).toBe('blocks');
    // A paragraph past it as well, and an image at a document that holds 5,000 paragraphs.
    const full = opened(doc(...paragraphs(5000)));
    expect(answer(full, edited(full, doc(...paragraphs(5000), imageJson())))).toBe('blocks');
    // And the same with an element a client makes whole in one change, answered without the copy.
    const update = sent(at, putImage({ id: ID }));
    expect(answer(at, update)).toBe('blocks');
    expect(withoutCopy(at, Y.decodeUpdate(update))).toBe('blocks');
  });

  it('allows a document that is past the limit to lose an image, as it can lose any block', () => {
    const over = opened(doc(...paragraphs(5005), imageJson()));
    expect(answer(over, edited(over, doc(...paragraphs(5005))))).toBeNull();
  });
});
