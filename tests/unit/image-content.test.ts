// What an upload is accepted as (NFR-SE-18, FR-ED-08): the type is the content's
// and nothing else's, the size is 20 MB at most, and an upload is what comes
// out of the removal of its metadata. And what an image block may hold
// (NFR-SE-06 A01). Each test names the rule whose breaking it fails.
import { describe, expect, it } from 'vitest';
import { REMOVAL_POLICY } from '../../src/lib/images/metadata/policy.ts';
import {
  IMAGE_ALT_MOST,
  IMAGE_ATTRIBUTES,
  IMAGE_CAPTION_MOST,
  IMAGE_ID,
  IMAGE_MOST_BYTES,
  IMAGE_TYPES,
  imageAttributeAllowed,
} from '../../src/lib/images/node.ts';
import { prepareImage } from '../../src/lib/images/prepare.ts';
import { sniffImage } from '../../src/lib/images/sniff.ts';
import { documentOfKey, newObjectKey } from '../../src/lib/images/storage.ts';
import { exifSegment, exifTiff, gif, jpeg, png, SECRET, webp } from './image-fixtures.ts';

const text = (value: string) => Buffer.from(value, 'utf8');

describe('the type of an upload is read from its content (NFR-SE-18)', () => {
  it.each([
    ['png', png()],
    ['jpeg', jpeg()],
    ['gif', gif()],
    ['gif', Buffer.concat([text('GIF87a'), gif().subarray(6)])],
    ['webp', webp()],
  ])('is %s for the content of one', (format, bytes) => {
    expect(sniffImage(bytes)).toBe(format);
  });

  it.each([
    ['an SVG file', text('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')],
    [
      'an SVG file with its declaration',
      text('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'),
    ],
    ['an HTML file', text('<!doctype html><script>alert(1)</script>')],
    ['a script', text('#!/bin/sh\necho hi')],
    ['a PDF', text('%PDF-1.7 ...')],
    ['empty content', Buffer.alloc(0)],
    ['a signature that is cut', png().subarray(0, 7)],
    ['a RIFF file of another kind', Buffer.concat([text('RIFF'), Buffer.alloc(4), text('WAVE')])],
    ['a WebP signature that is cut', webp().subarray(0, 11)],
    ['a GIF of another version', text('GIF90a......')],
    ['a BMP', text('BM......')],
    ['an ICO', Buffer.from([0, 0, 1, 0, 1, 0])],
  ])('is none for %s', (_name, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });

  it('is not changed by what the file says it is: a name or a declared type is no parameter', () => {
    // The function takes the bytes and nothing else, so neither can be taken for evidence.
    expect(sniffImage.length).toBe(1);
    // An SVG file under a PNG's name is refused; a PNG under an SVG's name is a PNG.
    expect(prepareImage(text('<svg xmlns="http://www.w3.org/2000/svg"/>')).ok).toBe(false);
    expect(prepareImage(png()).ok).toBe(true);
  });

  it('is the same wherever a file begins with the signature of one and holds another', () => {
    // A polyglot: the signature of a GIF, the body of an SVG. It does not parse as a GIF, so it is refused.
    expect(
      prepareImage(Buffer.concat([text('GIF89a'), text('<svg xmlns="http://www.w3.org/2000/svg"/>')])),
    ).toEqual({
      ok: false,
      reason: 'not_accepted',
    });
    // The signature of a PNG alone.
    expect(prepareImage(png().subarray(0, 8))).toEqual({ ok: false, reason: 'not_accepted' });
  });
});

describe('an upload becomes what is stored (NFR-SE-18)', () => {
  it.each([
    ['png', png(), 'image/png'],
    ['jpeg', jpeg(), 'image/jpeg'],
    ['gif', gif(), 'image/gif'],
    ['webp', webp(), 'image/webp'],
  ] as const)('keeps the type the server established: %s', (format, bytes, contentType) => {
    const prepared = prepareImage(bytes);
    expect(prepared).toMatchObject({ ok: true, format, contentType });
    expect(contentType).toBe(IMAGE_TYPES[format]);
  });

  it('has no type that a browser would run as a document', () => {
    expect(Object.values(IMAGE_TYPES).sort()).toEqual(['image/gif', 'image/jpeg', 'image/png', 'image/webp']);
  });

  it('has its metadata removed: it is what comes out that is stored', () => {
    const prepared = prepareImage(jpeg({ first: [exifSegment(exifTiff(null))] }));
    expect(prepared.ok && prepared.bytes.includes(SECRET)).toBe(false);
    const alone = prepareImage(jpeg({ first: [exifSegment(exifTiff(null))] }), {
      keepColour: false,
      keepOrientation: false,
    });
    expect(alone).toMatchObject({ ok: true });
  });

  it('is refused at more than 20 MB, and accepted at exactly 20 MB', () => {
    expect(IMAGE_MOST_BYTES).toBe(20 * 1024 * 1024);
    const base = png();
    // A PNG of the size, with the filling after its end, which the removal drops: the size is of what was sent.
    const exact = Buffer.concat([base, Buffer.alloc(IMAGE_MOST_BYTES - base.length)]);
    const over = Buffer.concat([base, Buffer.alloc(IMAGE_MOST_BYTES + 1 - base.length)]);
    expect(exact.length).toBe(IMAGE_MOST_BYTES);
    expect(prepareImage(exact, REMOVAL_POLICY).ok).toBe(true);
    expect(prepareImage(over)).toEqual({ ok: false, reason: 'too_large' });
  });

  it('is refused for its size before its type is read, so that an oversized file is told its size', () => {
    expect(prepareImage(Buffer.alloc(IMAGE_MOST_BYTES + 1))).toEqual({ ok: false, reason: 'too_large' });
  });

  it('is refused where it begins as an image and does not parse to its end', () => {
    expect(prepareImage(jpeg().subarray(0, 30))).toEqual({ ok: false, reason: 'not_accepted' });
    expect(prepareImage(gif().subarray(0, 20))).toEqual({ ok: false, reason: 'not_accepted' });
    expect(prepareImage(webp().subarray(0, 20))).toEqual({ ok: false, reason: 'not_accepted' });
  });
});

describe('the key of an object (NFR-SE-18)', () => {
  const document = '2a7f6c1e-5b1c-4d3e-9a58-0d8c3a9d4e11';

  it('names its document, is 128 random bits, and is never twice the same', () => {
    const keys = Array.from({ length: 200 }, () => newObjectKey(document));
    expect(new Set(keys).size).toBe(200);
    for (const key of keys) {
      expect(key).toMatch(/^images\/2a7f6c1e-5b1c-4d3e-9a58-0d8c3a9d4e11\/[0-9a-f]{32}$/);
      expect(documentOfKey(key)).toBe(document);
    }
  });

  it('has no parameter for a file name, so nothing a user typed is in a path', () => {
    expect(newObjectKey.length).toBe(1);
    expect(documentOfKey('images/../../etc/passwd')).toBeNull();
    expect(documentOfKey(`images/${document}/../x`)).toBeNull();
    expect(documentOfKey(`images/${document}/evil.png`)).toBeNull();
  });
});

describe('what an image block may hold (FR-ED-08, NFR-SE-06 A01)', () => {
  const id = 'c' + 'a1b2c3d4e5'.repeat(2) + '0123';

  it('is four attributes, and no attribute that could hold an address', () => {
    expect([...IMAGE_ATTRIBUTES].sort()).toEqual(['alt', 'caption', 'id', 'width']);
    for (const name of [
      'src',
      'href',
      'url',
      'data',
      'srcset',
      'style',
      'onload',
      'class',
      'objectKey',
      'key',
    ]) {
      expect(imageAttributeAllowed(name, 'https://example.com/pixel.png')).toBe(false);
      expect(imageAttributeAllowed(name, null)).toBe(false);
    }
  });

  it('holds an identifier of the form the application issues, and no address or path in its place', () => {
    expect(IMAGE_ID.test(id)).toBe(true);
    expect(imageAttributeAllowed('id', id)).toBe(true);
    expect(imageAttributeAllowed('id', null)).toBe(true);
    for (const bad of [
      'https://example.com/pixel.png',
      'http://169.254.169.254/latest/meta-data',
      '//example.com/x.png',
      'data:image/png;base64,AAAA',
      'javascript:alert(1)',
      'images/2a7f6c1e-5b1c-4d3e-9a58-0d8c3a9d4e11/aabbccddeeff00112233445566778899',
      '../../x',
      '',
      `${id}x`,
      id.slice(1),
      id.toUpperCase(),
      id.replace(/^c/, 'd'),
      5,
      true,
      {},
      [id],
    ]) {
      expect(imageAttributeAllowed('id', bad), String(bad)).toBe(false);
    }
  });

  it('holds text of at most the bound for the alt text and the caption (S19-3, recommended), and no other value', () => {
    expect(imageAttributeAllowed('alt', '')).toBe(true);
    expect(imageAttributeAllowed('alt', 'a'.repeat(IMAGE_ALT_MOST))).toBe(true);
    expect(imageAttributeAllowed('alt', 'a'.repeat(IMAGE_ALT_MOST + 1))).toBe(false);
    expect(imageAttributeAllowed('caption', 'a'.repeat(IMAGE_CAPTION_MOST))).toBe(true);
    expect(imageAttributeAllowed('caption', 'a'.repeat(IMAGE_CAPTION_MOST + 1))).toBe(false);
    // Stored as written (NFR-SE-08): markup is text, and is encoded on output.
    expect(imageAttributeAllowed('alt', '<img src=x onerror=alert(1)> "quoted" &amp;')).toBe(true);
    for (const bad of [1, true, {}, ['a'], undefined]) {
      expect(imageAttributeAllowed('alt', bad)).toBe(false);
      expect(imageAttributeAllowed('caption', bad)).toBe(false);
    }
  });

  it('holds a whole number of percent from 10 to 100 for the width, and no number written as text', () => {
    for (const good of [10, 25, 100]) expect(imageAttributeAllowed('width', good)).toBe(true);
    for (const bad of [9, 101, 0, -50, 33.5, NaN, Infinity, '50', true, {}]) {
      expect(imageAttributeAllowed('width', bad), String(bad)).toBe(false);
    }
  });
});
