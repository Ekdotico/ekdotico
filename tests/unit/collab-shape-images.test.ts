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
