// The bound on the width and height of an uploaded image (NFR-SE-18; D301; register Q80, owner's answer: 12,000 pixels
// on each side and 50 megapixels in all; docs@da33e58), read from the header and checked before anything is parsed to
// its end. Each test names the rule whose breaking it fails.
import { describe, expect, it } from 'vitest';
import {
  declaredSize,
  isAnimated,
  IMAGE_MOST_PIXELS,
  IMAGE_MOST_SIDE,
  withinBound,
} from '../../src/lib/images/dimensions.ts';
import { prepareImage } from '../../src/lib/images/prepare.ts';
import {
  gif,
  JPEG_SCAN,
  jpeg,
  jpegSegment,
  png,
  pngChunk,
  webp,
  webpChunk,
  WEBP_PICTURE,
} from './image-fixtures.ts';

const ihdr = (width: number, height: number) => {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 2;
  return pngChunk('IHDR', data);
};
const pngOf = (width: number, height: number) => png({ ihdr: ihdr(width, height) });

const sof = (marker: number, width: number, height: number) =>
  jpegSegment(marker, Buffer.from([8, height >> 8, height & 0xff, width >> 8, width & 0xff, 1, 1, 0x11, 0]));
const jpegOf = (width: number, height: number) => jpeg({ first: [sof(0xc0, width, height)] });

const vp8x = (width: number, height: number) => {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  return webpChunk('VP8X', data);
};
const vp8l = (width: number, height: number) => {
  const data = Buffer.alloc(5);
  data[0] = 0x2f;
  data.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 1);
  return webpChunk('VP8L', data);
};
const vp8 = (width: number, height: number) => {
  const data = Buffer.alloc(10);
  data.set([0x9d, 0x01, 0x2a], 3);
  data.writeUInt16LE(width, 6);
  data.writeUInt16LE(height, 8);
  return webpChunk('VP8 ', data);
};

describe('the size an image declares is read from its header', () => {
  it.each([
    ['png', pngOf(300, 200), 'png'],
    ['jpeg', jpegOf(300, 200), 'jpeg'],
    ['webp lossless', webp([vp8l(300, 200)]), 'webp'],
    ['webp lossy', webp([vp8(300, 200)]), 'webp'],
    ['webp extended', webp([vp8x(300, 200), WEBP_PICTURE]), 'webp'],
  ] as const)('is 300 by 200 for %s', (_name, bytes, format) => {
    expect(declaredSize(bytes, format)).toEqual({ width: 300, height: 200 });
  });

  // Weakening: only the first frame header is read, so a second, larger one hides behind a small one.
  it('takes the largest of each side where a JPEG declares more than one frame', () => {
    const bytes = jpeg({ first: [sof(0xc0, 100, 50)], before: [sof(0xc2, 40, 9000)] });
    expect(declaredSize(bytes, 'jpeg')).toEqual({ width: 100, height: 9000 });
  });

  it('takes the canvas of an extended WebP and the picture, the larger of each', () => {
    expect(declaredSize(webp([vp8x(9000, 100), vp8l(300, 400)]), 'webp')).toEqual({
      width: 9000,
      height: 400,
    });
  });

  it('gives nothing where the header gives no size', () => {
    expect(
      declaredSize(
        png({ ihdr: pngChunk('IDAT', Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])) }),
        'png',
      ),
    ).toBeNull();
    expect(declaredSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), 'jpeg')).toBeNull();
    expect(declaredSize(webp([WEBP_PICTURE.subarray(0, 10)]), 'webp')).toBeNull();
  });
});

describe('the bound is 12,000 pixels on each side and 50 megapixels in all (Q80)', () => {
  it('holds the numbers of the owner’s answer', () => {
    expect(IMAGE_MOST_SIDE).toBe(12_000);
    expect(IMAGE_MOST_PIXELS).toBe(50_000_000);
  });

  // Weakening: either bound dropped, or either compared with < in place of <=.
  it.each([
    [12_000, 4_000, true],
    [12_001, 1, false],
    [1, 12_001, false],
    [10_000, 5_000, true],
    [10_000, 5_001, false],
    [7_071, 7_071, true],
    [7_072, 7_072, false],
    [0, 100, false],
    [100, 0, false],
  ])('%i by %i is within the bound: %s', (width, height, within) => {
    expect(withinBound({ width, height })).toBe(within);
  });
});

describe('an upload past the bound is refused before it is parsed (NFR-SE-18)', () => {
  // Weakening: no check, or the check after the removal of metadata. These images parse to their end.
  it.each([
    ['png', pngOf(12_001, 1)],
    ['png', pngOf(1, 12_001)],
    ['png, in pixels', pngOf(10_000, 5_001)],
    ['jpeg', jpegOf(12_001, 1)],
    ['jpeg, in pixels', jpegOf(8_000, 8_000)],
    ['webp lossless', webp([vp8l(12_001, 1)])],
    ['webp lossy', webp([vp8(1, 12_001)])],
    ['webp extended', webp([vp8x(12_001, 1), WEBP_PICTURE])],
  ])('refuses a %s image', (_name, bytes) => {
    expect(prepareImage(bytes)).toEqual({ ok: false, reason: 'too_many_pixels' });
  });

  it('accepts images at the bound', () => {
    for (const bytes of [pngOf(12_000, 4_000), pngOf(10_000, 5_000), jpegOf(12_000, 4_000)]) {
      expect(prepareImage(bytes).ok).toBe(true);
    }
  });

  // D308: "read from the header before any decoding", and the removal of metadata is held to the same limit.
  // Weakening: the size is read after the container is parsed to its end.
  it('reads the header first: a file that would not parse is told by its size where the size is past the bound', () => {
    expect(prepareImage(pngOf(20_000, 20_000).subarray(0, 40))).toEqual({
      ok: false,
      reason: 'too_many_pixels',
    });
    expect(prepareImage(pngOf(10, 10).subarray(0, 40))).toEqual({ ok: false, reason: 'not_accepted' });
  });

  // Review of PR 80, round 2: a side of 0 is an unreadable header, a 415, and not a 413. Weakening: it is left to the bound.
  it.each([
    ['a height of 0', 10, 0],
    ['a width of 0', 0, 10],
  ])('refuses a JPEG with %s as an unreadable header (D308)', (_name, width, height) => {
    const only = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      sof(0xc0, width, height),
      JPEG_SCAN,
      Buffer.from([0xff, 0xd9]),
    ]);
    expect(declaredSize(only, 'jpeg')).toEqual({ width, height });
    expect(prepareImage(only)).toEqual({ ok: false, reason: 'not_accepted' });
  });

  it('refuses an image whose header gives no size as not an image of the three types (D308)', () => {
    const noHeader = png({ ihdr: pngChunk('IDAT', Buffer.alloc(13)) });
    expect(prepareImage(noHeader)).toEqual({ ok: false, reason: 'not_accepted' });
  });
});

describe('every GIF is refused, and an animated WebP or PNG (D309, D310)', () => {
  const control = (frames: number) => {
    const data = Buffer.alloc(8);
    data.writeUInt32BE(frames, 0);
    return pngChunk('acTL', data);
  };
  const extended = (flags: number) => {
    const data = Buffer.alloc(10);
    data[0] = flags;
    return webpChunk('VP8X', data);
  };

  // Weakening: a still GIF is accepted, or a GIF is told by its name or its declared type (the function has neither).
  it('refuses every GIF, a still one and a one-frame one too, by its first six bytes', () => {
    expect(prepareImage(gif())).toEqual({ ok: false, reason: 'gif' });
    expect(prepareImage(Buffer.from('GIF87a'))).toEqual({ ok: false, reason: 'gif' });
    expect(prepareImage(Buffer.from('GIF89a'))).toEqual({ ok: false, reason: 'gif' });
    // Not parsed: a GIF that is nothing but its signature is still a GIF.
    expect(prepareImage(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(64, 0xff)]))).toEqual({
      ok: false,
      reason: 'gif',
    });
  });

  // Weakening: acTL is looked for after the picture, or not at all.
  it('refuses an animated PNG, by an acTL chunk before the first IDAT, without reading a pixel', () => {
    expect(prepareImage(png({ before: [control(3)] }))).toEqual({ ok: false, reason: 'animated' });
    // After the data, no decoder reads it, and the image is still.
    const still = prepareImage(png({ after: [control(3), pngChunk('fcTL', Buffer.alloc(26))] }));
    expect(still.ok).toBe(true);
    // Accepted, and stored without a control or a frame chunk: the stripper removes them wherever they stand.
    if (still.ok)
      for (const type of ['acTL', 'fcTL', 'fdAT']) expect(still.bytes.includes(type), type).toBe(false);
    expect(isAnimated(png({ before: [control(2)] }), 'png')).toBe(true);
    expect(isAnimated(png(), 'png')).toBe(false);
  });

  // Weakening: only the flag is read, or only the chunks.
  it.each([
    ['the animation flag of the extended header', webp([extended(0x02), WEBP_PICTURE])],
    ['an ANIM chunk', webp([extended(0x00), webpChunk('ANIM', Buffer.alloc(6)), WEBP_PICTURE])],
    ['an ANMF chunk', webp([extended(0x00), webpChunk('ANMF', Buffer.alloc(16)), WEBP_PICTURE])],
    [
      'the flag and the chunks of a real animation',
      webp([extended(0x12), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('ANMF', Buffer.alloc(16))]),
    ],
  ])('refuses a WebP with %s', (_name, bytes) => {
    expect(prepareImage(bytes)).toEqual({ ok: false, reason: 'animated' });
  });

  it('accepts a still WebP, with or without an extended header, and a JPEG', () => {
    expect(prepareImage(webp()).ok).toBe(true);
    expect(prepareImage(webp([extended(0x10), WEBP_PICTURE])).ok).toBe(true);
    expect(prepareImage(jpeg()).ok).toBe(true);
    expect(isAnimated(jpeg(), 'jpeg')).toBe(false);
  });

  // The refusals are approved by the owner and pinned whole.
  it('has the approved words', async () => {
    const { IMAGE_MESSAGES } = await import('../../src/lib/images/answers.ts');
    expect(IMAGE_MESSAGES.gif).toBe(
      'That file is a GIF, and Ekdotico does not accept GIF images, so it was not added. Choose a PNG, JPEG, or WebP image.',
    );
    expect(IMAGE_MESSAGES.animated).toBe(
      'That image is animated, and Ekdotico does not accept animated images, so it was not added. Choose a still PNG, JPEG, or WebP image.',
    );
    expect(IMAGE_MESSAGES.notAccepted).toBe(
      'That file is not a PNG, JPEG, or WebP image, so it was not added. Choose an image in one of those formats.',
    );
  });
});
