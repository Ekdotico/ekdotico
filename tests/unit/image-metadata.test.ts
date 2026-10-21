// The removal of metadata from an image (NFR-SE-18: "The location data and every
// other piece of embedded metadata of an image are removed before it is
// stored"; the owner's answer to Q13), for each of the four formats: each kind
// of metadata that the format can carry has a file here, and the output is read
// back. Each test names what it checks and so what breaking the rule fails.
import { describe, expect, it } from 'vitest';
import { removeGifMetadata } from '../../src/lib/images/metadata/gif.ts';
import { removeJpegMetadata } from '../../src/lib/images/metadata/jpeg.ts';
import { orientationOf, orientationTiff } from '../../src/lib/images/metadata/orientation.ts';
import { removePngMetadata } from '../../src/lib/images/metadata/png.ts';
import { REMOVAL_POLICY, type RemovalPolicy } from '../../src/lib/images/metadata/policy.ts';
import { removeWebpMetadata } from '../../src/lib/images/metadata/webp.ts';
import {
  GIF_CONTROL,
  GIF_FRAME,
  GPS_MARK,
  JFIF_THUMBNAIL,
  JPEG_FRAME,
  JPEG_SCAN,
  PNG_IDAT,
  SECRET,
  WEBP_PICTURE,
  adobeSegment,
  exifSegment,
  exifTiff,
  gif,
  gifComment,
  gifLoop,
  gifPlainText,
  gifXmp,
  iccSegment,
  jfif,
  jpeg,
  jpegSegment,
  png,
  pngChunk,
  vp8x,
  webp,
  webpChunk,
  xmpSegment,
} from './image-fixtures.ts';

const NONE: RemovalPolicy = { keepColour: false, keepOrientation: false };
const KEEP_BOTH = REMOVAL_POLICY;

/** Nothing of a person's may be left in what is stored: neither the text, nor the mark of a location directory. */
const leaks = (output: Buffer) => output.includes(SECRET) || output.includes(GPS_MARK);

/** The four-letter types of the chunks of a PNG file, in order. */
function pngTypes(file: Buffer): string[] {
  const types: string[] = [];
  for (let at = 8; at < file.length; at += 12 + file.readUInt32BE(at)) {
    types.push(file.toString('latin1', at + 4, at + 8));
  }
  return types;
}
const pngData = (file: Buffer, type: string) => {
  for (let at = 8; at < file.length; at += 12 + file.readUInt32BE(at)) {
    if (file.toString('latin1', at + 4, at + 8) === type)
      return file.subarray(at + 8, at + 8 + file.readUInt32BE(at));
  }
  return null;
};

/** The markers of the segments of a JPEG file that come before its scan, in order. */
function jpegMarkers(file: Buffer): number[] {
  const markers: number[] = [];
  for (let at = 2; at < file.length; at += 2 + file.readUInt16BE(at + 2)) {
    markers.push(file[at + 1]!);
    if (file[at + 1] === 0xda) break;
  }
  return markers;
}
const exifOf = (file: Buffer) => {
  for (let at = 2; at < file.length; at += 2 + file.readUInt16BE(at + 2)) {
    if (file[at + 1] === 0xe1) return file.subarray(at + 4 + 6, at + 2 + file.readUInt16BE(at + 2));
    if (file[at + 1] === 0xda) break;
  }
  return null;
};

describe('the orientation, the one tag of Exif that may be kept', () => {
  it.each([2, 3, 6, 8])('is read from little-endian and big-endian blocks alike: %i', (value) => {
    expect(orientationOf(exifTiff(value))).toBe(value);
    expect(orientationOf(exifTiff(value, true))).toBe(value);
  });

  it('is nothing where it is 1, is not there, or is out of range', () => {
    expect(orientationOf(exifTiff(1))).toBeNull();
    expect(orientationOf(exifTiff(null))).toBeNull();
    expect(orientationOf(exifTiff(9))).toBeNull();
    expect(orientationOf(exifTiff(0))).toBeNull();
  });

  it('is nothing from a block that is cut, or that points outside itself', () => {
    const whole = exifTiff(6);
    for (const length of [0, 4, 8, 9, 12, 20]) expect(orientationOf(whole.subarray(0, length))).toBeNull();
    const far = Buffer.from(whole);
    far.writeUInt32LE(0xffffff00, 4);
    expect(orientationOf(far)).toBeNull();
    expect(orientationOf(Buffer.from('not exif at all, but long enough'))).toBeNull();
  });

  it('is written back as a block of that tag alone: 26 bytes, no text, no location', () => {
    const block = orientationTiff(6);
    expect(block.length).toBe(26);
    expect(orientationOf(block)).toBe(6);
    expect(leaks(block)).toBe(false);
    expect(block.includes(Buffer.from('Secret'))).toBe(false);
  });
});

describe('a PNG file', () => {
  const metadata: [string, Buffer][] = [
    ['tEXt', pngChunk('tEXt', Buffer.from(`Comment\0${SECRET}`, 'latin1'))],
    ['zTXt', pngChunk('zTXt', Buffer.from(`Comment\0\0${SECRET}`, 'latin1'))],
    [
      'iTXt (where an XMP packet is)',
      pngChunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${SECRET}`, 'latin1')),
    ],
    ['eXIf (where the location is)', pngChunk('eXIf', exifTiff(null))],
    ['tIME', pngChunk('tIME', Buffer.from([7, 234, 10, 20, 12, 30, 5]))],
    ['pHYs', pngChunk('pHYs', Buffer.from([0, 0, 11, 19, 0, 0, 11, 19, 1]))],
    ['sBIT', pngChunk('sBIT', Buffer.from([8, 8, 8]))],
    ['bKGD', pngChunk('bKGD', Buffer.from([0, 255, 0, 255, 0, 255]))],
    ['hIST', pngChunk('hIST', Buffer.from([0, 1]))],
    ['sPLT', pngChunk('sPLT', Buffer.from(`${SECRET}\0\x08`, 'latin1'))],
    ['a private chunk', pngChunk('prIv', Buffer.from(SECRET, 'latin1'))],
    ['an unknown chunk the specification may add', pngChunk('zzZz', Buffer.from(SECRET, 'latin1'))],
  ];

  it.each(metadata)('loses %s, and keeps the picture', (name, chunk) => {
    const type = chunk.toString('latin1', 4, 8);
    for (const where of ['before', 'after'] as const) {
      const output = removePngMetadata(png({ [where]: [chunk] }), NONE)!;
      expect(output, name).not.toBeNull();
      expect(pngTypes(output)).toEqual(['IHDR', 'IDAT', 'IEND']);
      expect(pngTypes(output)).not.toContain(type);
      expect(leaks(output)).toBe(false);
      // The data of the picture is the same bytes: nothing is compressed again.
      expect(output.includes(PNG_IDAT)).toBe(true);
    }
  });

  it('loses everything written after the end of the image', () => {
    const output = removePngMetadata(png({ tail: Buffer.from(`${SECRET}-after-IEND`) }), NONE)!;
    expect(output.includes(SECRET)).toBe(false);
    expect(pngTypes(output).at(-1)).toBe('IEND');
    expect(output.length).toBe(removePngMetadata(png(), NONE)!.length);
  });

  it('loses every kind at once, and what is left is the picture and nothing else', () => {
    const output = removePngMetadata(png({ before: metadata.map(([, chunk]) => chunk) }), KEEP_BOTH)!;
    expect(pngTypes(output)).toEqual(['IHDR', 'IDAT', 'IEND']);
    expect(leaks(output)).toBe(false);
  });

  // Each of the length the format gives it: a colour chunk of another length is dropped (below).
  const COLOUR_LENGTHS: Record<string, number> = { gAMA: 4, cHRM: 32, sRGB: 1, iCCP: 4, cICP: 4 };
  const colour = Object.entries(COLOUR_LENGTHS).map(([type, length]) =>
    pngChunk(type, Buffer.alloc(length, 1)),
  );

  it('keeps its colour chunks by the policy of S19-2, and loses them where it says so', () => {
    expect(pngTypes(removePngMetadata(png({ before: colour }), KEEP_BOTH)!)).toEqual([
      'IHDR',
      'gAMA',
      'cHRM',
      'sRGB',
      'iCCP',
      'cICP',
      'IDAT',
      'IEND',
    ]);
    expect(
      pngTypes(removePngMetadata(png({ before: colour }), { ...KEEP_BOTH, keepColour: false })!),
    ).toEqual(['IHDR', 'IDAT', 'IEND']);
  });

  it('keeps the chunks of an animation and of a palette and of transparency', () => {
    // Of the lengths the format gives them: a palette of one entry, one colour for transparency (the image is
    // truecolour), and the two controls of an animation.
    const picture = [
      pngChunk('PLTE', Buffer.alloc(3, 1)),
      pngChunk('tRNS', Buffer.alloc(6, 1)),
      pngChunk('acTL', Buffer.alloc(8, 1)),
      pngChunk('fcTL', Buffer.alloc(26, 1)),
    ];
    const output = removePngMetadata(
      png({ before: picture, after: [pngChunk('fdAT', Buffer.from([0, 0, 0, 1, 9]))] }),
      NONE,
    )!;
    expect(pngTypes(output)).toEqual(['IHDR', 'PLTE', 'tRNS', 'acTL', 'fcTL', 'IDAT', 'fdAT', 'IEND']);
  });

  // The review of pull request 52 (S4): a part whose length the format fixes keeps no more than that, and a
  // string that a writer hid in one does not survive. Each of these carried one.
  describe('a part of a length the format gives it (S4)', () => {
    const HIDDEN = Buffer.from('GPS 37.9838N 23.7275E');
    const hides = (output: Buffer | null) => output !== null && output.includes(HIDDEN);

    it('writes the end of the image again with no data, whatever the one that came held', () => {
      const file = png();
      // The IEND of the fixture, replaced by one that holds the string, with the check value that goes with it.
      const end = pngChunk('IEND');
      const hiding = Buffer.concat([file.subarray(0, file.length - end.length), pngChunk('IEND', HIDDEN)]);
      expect(hides(hiding)).toBe(true);
      const output = removePngMetadata(hiding, NONE)!;
      expect(hides(output)).toBe(false);
      expect(output.subarray(-12).equals(pngChunk('IEND'))).toBe(true);
    });

    it('refuses a palette that is no palette: not a multiple of 3 entries, or more than 256', () => {
      for (const length of [1, 2, 4, 769, 771, 3000]) {
        expect(
          removePngMetadata(png({ before: [pngChunk('PLTE', Buffer.alloc(length, 7))] }), NONE),
          String(length),
        ).toBeNull();
      }
      expect(
        removePngMetadata(png({ before: [pngChunk('PLTE', Buffer.alloc(768, 7))] }), NONE),
      ).not.toBeNull();
    });

    it('drops a transparency that is not the length for this kind of image, and keeps the one that is', () => {
      // The fixture is truecolour: one colour, 6 bytes.
      for (const length of [1, 2, 7, 21, 300]) {
        const output = removePngMetadata(png({ before: [pngChunk('tRNS', Buffer.alloc(length, 7))] }), NONE)!;
        expect(pngTypes(output), String(length)).not.toContain('tRNS');
      }
      expect(
        pngTypes(removePngMetadata(png({ before: [pngChunk('tRNS', HIDDEN.subarray(0, 6))] }), NONE)!),
      ).toContain('tRNS');
    });

    it('holds a transparency to the length of each kind of image: grey, palette, and the kinds that have an alpha', () => {
      const ihdrOf = (colourType: number) => {
        const header = Buffer.alloc(13);
        header.writeUInt32BE(1, 0);
        header.writeUInt32BE(1, 4);
        header[8] = 8;
        header[9] = colourType;
        return pngChunk('IHDR', header);
      };
      const kept = (colourType: number, length: number) =>
        pngTypes(
          removePngMetadata(
            png({ ihdr: ihdrOf(colourType), before: [pngChunk('tRNS', Buffer.alloc(length, 7))] }),
            NONE,
          )!,
        ).includes('tRNS');
      // Grey: one value of 2 bytes.
      for (const length of [1, 3, 6, 40]) expect(kept(0, length), `grey ${length}`).toBe(false);
      expect(kept(0, 2)).toBe(true);
      // Palette: one byte for each entry, 256 at most.
      for (const length of [0, 257, 4000]) expect(kept(3, length), `palette ${length}`).toBe(false);
      for (const length of [1, 17, 256]) expect(kept(3, length), `palette ${length}`).toBe(true);
      // An alpha channel is the transparency of those kinds; a chunk for it is no part of the picture.
      for (const colourType of [4, 6]) expect(kept(colourType, 6), `type ${colourType}`).toBe(false);
    });

    it('refuses the controls of an animation that are not their length, and drops a colour chunk that is not', () => {
      expect(removePngMetadata(png({ before: [pngChunk('acTL', HIDDEN)] }), NONE)).toBeNull();
      expect(removePngMetadata(png({ before: [pngChunk('fcTL', HIDDEN)] }), NONE)).toBeNull();
      for (const type of ['gAMA', 'cHRM', 'sRGB', 'cICP']) {
        const output = removePngMetadata(png({ before: [pngChunk(type, HIDDEN)] }), KEEP_BOTH)!;
        expect(hides(output), type).toBe(false);
        expect(pngTypes(output), type).not.toContain(type);
      }
    });

    it('keeps the colour profile whole, text and all, as the owner decided (S19-2)', () => {
      const profile = Buffer.concat([Buffer.from('profile\0\0'), HIDDEN]);
      const output = removePngMetadata(png({ before: [pngChunk('iCCP', profile)] }), KEEP_BOTH)!;
      expect(hides(output)).toBe(true);
    });
  });

  describe('the orientation (S19-2)', () => {
    it('is kept as an Exif chunk of that tag alone, before the data of the picture', () => {
      const output = removePngMetadata(png({ after: [pngChunk('eXIf', exifTiff(6))] }), KEEP_BOTH)!;
      expect(pngTypes(output)).toEqual(['IHDR', 'eXIf', 'IDAT', 'IEND']);
      expect(pngData(output, 'eXIf')!.equals(orientationTiff(6))).toBe(true);
      expect(leaks(output)).toBe(false);
    });

    it('is not written where the image is as stored, where there is none, or where the policy drops it', () => {
      for (const given of [exifTiff(1), exifTiff(null)]) {
        expect(pngTypes(removePngMetadata(png({ before: [pngChunk('eXIf', given)] }), KEEP_BOTH)!)).toEqual([
          'IHDR',
          'IDAT',
          'IEND',
        ]);
      }
      const dropped = removePngMetadata(png({ before: [pngChunk('eXIf', exifTiff(6))] }), {
        ...KEEP_BOTH,
        keepOrientation: false,
      })!;
      expect(pngTypes(dropped)).toEqual(['IHDR', 'IDAT', 'IEND']);
    });
  });

  it('is the same file where it is removed again', () => {
    const once = removePngMetadata(
      png({ before: [...colour, pngChunk('eXIf', exifTiff(3)), metadata[0]![1]] }),
      KEEP_BOTH,
    )!;
    expect(removePngMetadata(once, KEEP_BOTH)!.equals(once)).toBe(true);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['a signature alone', png().subarray(0, 8)],
    ['cut before its end', png().subarray(0, png().length - 5)],
    ['cut in a chunk', png().subarray(0, 30)],
    [
      'a chunk that is longer than the file',
      png({ before: [Buffer.from([0x00, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74])] }),
    ],
    ['a picture chunk with a wrong check value', png({ ihdr: pngChunk('IHDR', Buffer.alloc(13), 12345) })],
    ['a first chunk that is not IHDR', png({ ihdr: pngChunk('PLTE', Buffer.alloc(13)) })],
    [
      'no data of a picture',
      Buffer.concat([png().subarray(0, 8), pngChunk('IHDR', Buffer.alloc(13)), pngChunk('IEND')]),
    ],
    ['a chunk with a name that is no letters', png({ before: [pngChunk('t1xt', Buffer.alloc(2))] })],
    ['a JPEG file', jpeg()],
    ['an SVG file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')],
  ])('is refused as %s', (_name, bytes) => {
    expect(removePngMetadata(bytes, KEEP_BOTH)).toBeNull();
  });
});

describe('a JPEG file', () => {
  const metadata: [string, Buffer][] = [
    ['APP1 Exif (the location, the device, a thumbnail)', exifSegment(exifTiff(null))],
    ['APP1 XMP', xmpSegment()],
    ['APP13 (Photoshop and IPTC)', jpegSegment(0xed, Buffer.from(`Photoshop 3.0\0${SECRET}`, 'latin1'))],
    ['a comment', jpegSegment(0xfe, Buffer.from(SECRET, 'latin1'))],
    [
      'APP2 of the multi-picture format (a second image)',
      jpegSegment(0xe2, Buffer.from(`MPF\0${SECRET}`, 'latin1')),
    ],
    ['APP0 JFXX (thumbnails)', jpegSegment(0xe0, Buffer.from(`JFXX\0\x10${SECRET}`, 'latin1'))],
    ['APP3, a segment of the vendors', jpegSegment(0xe3, Buffer.from(`Meta\0${SECRET}`, 'latin1'))],
    ['APP5', jpegSegment(0xe5, Buffer.from(SECRET, 'latin1'))],
    ['APP12 (a ducky segment)', jpegSegment(0xec, Buffer.from(`Ducky${SECRET}`, 'latin1'))],
    ['a JPG extension segment', jpegSegment(0xf3, Buffer.from(SECRET, 'latin1'))],
  ];

  it.each(metadata)('loses %s, and keeps the picture', (name, segment) => {
    for (const where of ['first', 'before', 'after'] as const) {
      const output = removeJpegMetadata(jpeg({ [where]: [segment] }), NONE)!;
      expect(output, name).not.toBeNull();
      expect(leaks(output)).toBe(false);
      // Only the table, frame and scan markers are left: DQT, SOF0, DHT, SOS.
      expect(jpegMarkers(output)).toEqual([0xdb, 0xc0, 0xc4, 0xda]);
      // The tables, the frame, and the scan, byte for byte, entropy-coded data with its stuffed byte and restart marker.
      expect(output.includes(JPEG_FRAME)).toBe(true);
      expect(output.includes(JPEG_SCAN)).toBe(true);
    }
  });

  it('loses everything written after the end of the image', () => {
    const output = removeJpegMetadata(
      jpeg({ tail: Buffer.concat([exifSegment(exifTiff(null)), Buffer.from(SECRET)]) }),
      NONE,
    )!;
    expect(output.includes(SECRET)).toBe(false);
    expect(output.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    expect(output.length).toBe(removeJpegMetadata(jpeg(), NONE)!.length);
  });

  it('loses the thumbnail of the JFIF header, and keeps the header with a thumbnail of 0 by 0', () => {
    const output = removeJpegMetadata(jpeg({ first: [jfif(true)] }), NONE)!;
    expect(output.includes(JFIF_THUMBNAIL)).toBe(false);
    expect(jpegMarkers(output)).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
    // SOI, then the header: marker, length 16, "JFIF\0", version, units, densities, and the thumbnail's width and height.
    const header = output.subarray(2, 2 + 4 + 14);
    expect(header.readUInt16BE(2)).toBe(16);
    expect(header.subarray(4, 9).toString('latin1')).toBe('JFIF\0');
    expect([header[4 + 12], header[4 + 13]]).toEqual([0, 0]);
    expect(output.includes(JPEG_SCAN)).toBe(true);
  });

  it('loses every kind at once, and what is left is the picture and its JFIF header', () => {
    const output = removeJpegMetadata(
      jpeg({
        first: [jfif(true), ...metadata.slice(0, 5).map(([, each]) => each)],
        after: metadata.slice(5).map(([, each]) => each),
      }),
      KEEP_BOTH,
    )!;
    expect(leaks(output)).toBe(false);
    expect(jpegMarkers(output)).toEqual([0xe0, 0xdb, 0xc0, 0xc4, 0xda]);
  });

  it('keeps the segment that says how to read the colours (Adobe), whatever the policy', () => {
    const output = removeJpegMetadata(jpeg({ before: [adobeSegment()] }), NONE)!;
    expect(jpegMarkers(output)).toEqual([0xee, 0xdb, 0xc0, 0xc4, 0xda]);
  });

  it('keeps its ICC profile by the policy of S19-2, and loses it where it says so', () => {
    expect(jpegMarkers(removeJpegMetadata(jpeg({ before: [iccSegment()] }), KEEP_BOTH)!)).toContain(0xe2);
    expect(
      jpegMarkers(removeJpegMetadata(jpeg({ before: [iccSegment()] }), { ...KEEP_BOTH, keepColour: false })!),
    ).not.toContain(0xe2);
  });

  describe('the orientation (S19-2)', () => {
    it.each([
      ['little-endian', false],
      ['big-endian', true],
    ])('is kept, from a %s Exif block, as one Exif segment of that tag alone', (_name, big) => {
      const output = removeJpegMetadata(
        jpeg({ first: [jfif(), exifSegment(exifTiff(8, big)), xmpSegment()] }),
        KEEP_BOTH,
      )!;
      expect(leaks(output)).toBe(false);
      expect(jpegMarkers(output)).toEqual([0xe0, 0xe1, 0xdb, 0xc0, 0xc4, 0xda]);
      expect(exifOf(output)!.equals(orientationTiff(8))).toBe(true);
    });

    it('is not written where the image is as stored, where there is none, or where the policy drops it', () => {
      for (const given of [exifTiff(1), exifTiff(null)]) {
        expect(
          jpegMarkers(removeJpegMetadata(jpeg({ first: [exifSegment(given)] }), KEEP_BOTH)!),
        ).not.toContain(0xe1);
      }
      const dropped = removeJpegMetadata(jpeg({ first: [exifSegment(exifTiff(6))] }), {
        ...KEEP_BOTH,
        keepOrientation: false,
      })!;
      expect(jpegMarkers(dropped)).not.toContain(0xe1);
      expect(leaks(dropped)).toBe(false);
    });
  });

  it('is the same file where it is removed again', () => {
    const once = removeJpegMetadata(
      jpeg({ first: [jfif(true), exifSegment(exifTiff(6)), iccSegment(), adobeSegment()] }),
      KEEP_BOTH,
    )!;
    expect(removeJpegMetadata(once, KEEP_BOTH)!.equals(once)).toBe(true);
  });

  it('reads fill bytes before a marker, and a restart marker and a stuffed byte in the scan', () => {
    const filled = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), jpeg().subarray(2)]);
    expect(removeJpegMetadata(filled, NONE)).not.toBeNull();
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['a start alone', Buffer.from([0xff, 0xd8])],
    ['no end of image', jpeg().subarray(0, jpeg().length - 2)],
    [
      'a segment after the scan and no end of image',
      Buffer.concat([jpeg().subarray(0, jpeg().length - 2), jpegSegment(0xfe, Buffer.from('after'))]),
    ],
    ['cut in a segment', jpeg().subarray(0, 20)],
    [
      'a segment longer than the file',
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), Buffer.alloc(10)]),
    ],
    [
      'a scan before any frame',
      Buffer.concat([Buffer.from([0xff, 0xd8]), JPEG_SCAN, Buffer.from([0xff, 0xd9])]),
    ],
    ['a marker that is reserved', jpeg({ before: [jpegSegment(0x42, Buffer.alloc(2))] })],
    [
      'a length that is less than 2',
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 1]), jpeg().subarray(2)]),
    ],
    [
      'a byte that is no marker where a marker belongs',
      Buffer.concat([Buffer.from([0xff, 0xd8, 0x00]), jpeg().subarray(2)]),
    ],
    ['a PNG file', png()],
    ['an SVG file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])('is refused as %s', (_name, bytes) => {
    expect(removeJpegMetadata(bytes, KEEP_BOTH)).toBeNull();
  });
});

describe('a GIF file', () => {
  const metadata: [string, Buffer][] = [
    ['a comment', gifComment()],
    ['an application extension that is not the loop count (where XMP is)', gifXmp()],
    ['an application extension of another application', gifExtension2()],
  ];
  function gifExtension2(): Buffer {
    return Buffer.concat([
      Buffer.from([0x21, 0xff, 11]),
      Buffer.from('ICCRGBG1012', 'latin1'),
      Buffer.from([SECRET.length]),
      Buffer.from(SECRET, 'latin1'),
      Buffer.from([0]),
    ]);
  }

  it.each(metadata)('loses %s, and keeps the picture', (name, block) => {
    for (const where of ['before', 'after'] as const) {
      const output = removeGifMetadata(gif({ [where]: [block] }), NONE)!;
      expect(output, name).not.toBeNull();
      expect(leaks(output)).toBe(false);
      // What is left is what a GIF without it would be: byte for byte.
      expect(output.equals(gif())).toBe(true);
    }
  });

  it('loses a plain text extension, and the graphic control that waits for it, so the next frame is not given it', () => {
    // The frame has no control of its own, so one that is left over would be given to it.
    const output = removeGifMetadata(
      gif({ before: [GIF_CONTROL, gifPlainText()], frames: [GIF_FRAME] }),
      NONE,
    )!;
    expect(leaks(output)).toBe(false);
    expect(output.equals(gif({ frames: [GIF_FRAME] }))).toBe(true);
    expect(output.includes(GIF_CONTROL)).toBe(false);
  });

  it('loses everything written after the trailer', () => {
    const output = removeGifMetadata(gif({ tail: Buffer.from(`${SECRET}-after`) }), NONE)!;
    expect(output.equals(gif())).toBe(true);
  });

  it('keeps the loop count of an animation, the control of each frame, and every frame', () => {
    const frames = [GIF_CONTROL, GIF_FRAME, gifComment(), GIF_CONTROL, GIF_FRAME];
    const output = removeGifMetadata(gif({ before: [gifLoop()], frames }), NONE)!;
    expect(
      output.equals(gif({ before: [gifLoop()], frames: [GIF_CONTROL, GIF_FRAME, GIF_CONTROL, GIF_FRAME] })),
    ).toBe(true);
    expect(output.includes(Buffer.from('NETSCAPE2.0'))).toBe(true);
  });

  it('keeps the colour tables of the screen and of a frame', () => {
    const local = Buffer.concat([
      Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x80]),
      Buffer.from([9, 9, 9, 8, 8, 8]),
      Buffer.from([2, 2, 0x44, 0x01, 0]),
    ]);
    const file = gif({ frames: [GIF_CONTROL, local] });
    expect(removeGifMetadata(file, NONE)!.equals(file)).toBe(true);
  });

  it('is the same file where it is removed again', () => {
    const once = removeGifMetadata(gif({ before: [gifLoop(), gifXmp(), gifComment()] }), KEEP_BOTH)!;
    expect(removeGifMetadata(once, KEEP_BOTH)!.equals(once)).toBe(true);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['a header alone', Buffer.from('GIF89a')],
    ['no trailer', gif().subarray(0, gif().length - 1)],
    ['cut in a frame', gif().subarray(0, 36)],
    [
      'sub-blocks that run past the file',
      Buffer.concat([gif().subarray(0, gif().length - 1), Buffer.from([0x21, 0xfe, 200, 1, 2])]),
    ],
    ['a block that is none', gif({ before: [Buffer.from([0x99])] })],
    ['no frame at all', gif({ frames: [] })],
    [
      'a colour table the file is too short for',
      Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0xf7, 0, 0])]),
    ],
    ['a PNG file', png()],
    ['an SVG file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])('is refused as %s', (_name, bytes) => {
    expect(removeGifMetadata(bytes, KEEP_BOTH)).toBeNull();
  });
});

describe('a WebP file', () => {
  const ICC = webpChunk('ICCP', Buffer.from('PROFILE-BYTES', 'latin1'));
  const XMP = webpChunk('XMP ', Buffer.from(`<x:xmpmeta>${SECRET}</x:xmpmeta>`, 'latin1'));
  const UNKNOWN = webpChunk('ZZZZ', Buffer.from(SECRET, 'latin1'));
  const sizeOf = (file: Buffer) => file.readUInt32LE(4);

  /** The types of the chunks of a WebP file, in order. */
  function types(file: Buffer): string[] {
    const found: string[] = [];
    for (
      let at = 12;
      at < file.length;
      at += 8 + file.readUInt32LE(at + 4) + (file.readUInt32LE(at + 4) % 2)
    ) {
      found.push(file.toString('latin1', at, at + 4));
    }
    return found;
  }
  const flagsOf = (file: Buffer) => file[12 + 8]!;

  it('that is simple is the same file, and is as long as its header says', () => {
    const file = webp();
    const output = removeWebpMetadata(file, KEEP_BOTH)!;
    expect(output.equals(file)).toBe(true);
    expect(sizeOf(output) + 8).toBe(output.length);
  });

  it('loses XMP, an Exif block (where the location is), a chunk that is unknown, and what is after the container', () => {
    const file = webp(
      [vp8x(0x2c), ICC, WEBP_PICTURE, webpChunk('EXIF', exifTiff(null)), XMP, UNKNOWN],
      Buffer.from(`${SECRET}-after-the-container`),
    );
    const output = removeWebpMetadata(file, NONE)!;
    expect(leaks(output)).toBe(false);
    expect(types(output)).toEqual(['VP8X', 'VP8L']);
    expect(output.includes(WEBP_PICTURE)).toBe(true);
    // The flags announce nothing that is gone, and the size is of the new container.
    expect(flagsOf(output) & (0x20 | 0x08 | 0x04)).toBe(0);
    expect(sizeOf(output) + 8).toBe(output.length);
  });

  it('keeps its ICC profile by the policy of S19-2, with the flag, and loses it where it says so', () => {
    const file = webp([vp8x(0x20), ICC, WEBP_PICTURE]);
    const kept = removeWebpMetadata(file, KEEP_BOTH)!;
    expect(types(kept)).toEqual(['VP8X', 'ICCP', 'VP8L']);
    expect(flagsOf(kept) & 0x20).toBe(0x20);
    const dropped = removeWebpMetadata(file, { ...KEEP_BOTH, keepColour: false })!;
    expect(types(dropped)).toEqual(['VP8X', 'VP8L']);
    expect(flagsOf(dropped) & 0x20).toBe(0);
  });

  it('keeps the orientation as an Exif chunk of that tag alone, with the flag, after the picture', () => {
    const file = webp([vp8x(0x08), WEBP_PICTURE, webpChunk('EXIF', exifTiff(5)), XMP]);
    const output = removeWebpMetadata(file, KEEP_BOTH)!;
    expect(leaks(output)).toBe(false);
    expect(types(output)).toEqual(['VP8X', 'VP8L', 'EXIF']);
    expect(flagsOf(output) & 0x08).toBe(0x08);
    const exif = output.subarray(output.length - 26);
    expect(exif.equals(orientationTiff(5))).toBe(true);
    // The identifier of the JPEG form before the TIFF structure is read too.
    const prefixed = webp([
      vp8x(0x08),
      WEBP_PICTURE,
      webpChunk('EXIF', Buffer.concat([Buffer.from('Exif\0\0'), exifTiff(7)])),
    ]);
    expect(removeWebpMetadata(prefixed, KEEP_BOTH)!.subarray(-26).equals(orientationTiff(7))).toBe(true);
  });

  it('does not write the orientation where the image is as stored, where there is none, or where the policy drops it', () => {
    for (const given of [exifTiff(1), exifTiff(null)]) {
      expect(
        types(removeWebpMetadata(webp([vp8x(0x08), WEBP_PICTURE, webpChunk('EXIF', given)]), KEEP_BOTH)!),
      ).toEqual(['VP8X', 'VP8L']);
    }
    const dropped = removeWebpMetadata(webp([vp8x(0x08), WEBP_PICTURE, webpChunk('EXIF', exifTiff(6))]), {
      ...KEEP_BOTH,
      keepOrientation: false,
    })!;
    expect(types(dropped)).toEqual(['VP8X', 'VP8L']);
    expect(flagsOf(dropped) & 0x08).toBe(0);
  });

  it('keeps the animation, the flag for it, the alpha, and every frame', () => {
    const frame = webpChunk('ANMF', Buffer.concat([Buffer.alloc(16), WEBP_PICTURE]));
    const file = webp([vp8x(0x12), webpChunk('ANIM', Buffer.alloc(6)), frame, XMP, frame, UNKNOWN]);
    const output = removeWebpMetadata(file, NONE)!;
    expect(types(output)).toEqual(['VP8X', 'ANIM', 'ANMF', 'ANMF']);
    expect(flagsOf(output) & 0x12).toBe(0x12);
    expect(leaks(output)).toBe(false);
  });

  it('is the same file where it is removed again', () => {
    const once = removeWebpMetadata(
      webp([vp8x(0x2c), ICC, WEBP_PICTURE, webpChunk('EXIF', exifTiff(3)), XMP]),
      KEEP_BOTH,
    )!;
    expect(removeWebpMetadata(once, KEEP_BOTH)!.equals(once)).toBe(true);
  });

  it.each([
    ['empty', Buffer.alloc(0)],
    ['a header alone', webp([]).subarray(0, 12)],
    ['a container longer than the file', webp(null, Buffer.alloc(0), 4000)],
    ['a container shorter than its first chunk', webp(null, Buffer.alloc(0), 6)],
    [
      'a chunk that runs past the container',
      webp([Buffer.concat([Buffer.from('VP8L'), Buffer.from([0xff, 0, 0, 0]), Buffer.alloc(4)])]),
    ],
    ['no picture', webp([vp8x(0), XMP])],
    ['a VP8X that is not first', webp([WEBP_PICTURE, vp8x(0)])],
    ['a VP8X that is too short', webp([webpChunk('VP8X', Buffer.alloc(4)), WEBP_PICTURE])],
    [
      'a RIFF container of another kind',
      Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WAVE')]),
    ],
    ['a PNG file', png()],
    ['an SVG file', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ])('is refused as %s', (_name, bytes) => {
    expect(removeWebpMetadata(bytes, KEEP_BOTH)).toBeNull();
  });
});

// The review of pull request 52 (S4): the parts that the removers kept whole and a writer could fill. Each
// has a string hidden in it, which must not come out; the colour profile, which the owner kept whole, does.
describe('a part that is kept whole for its length is rebuilt for what it is defined to hold (S4)', () => {
  const HIDDEN = Buffer.from('GPS 37.9838N 23.7275E');
  const hides = (output: Buffer | null) => output !== null && output.includes(HIDDEN);

  describe('a JPEG file', () => {
    it('keeps the 12 bytes of APP14 "Adobe" and nothing after them, at whatever length it declares', () => {
      const adobe = Buffer.from('Adobe\0\x64\0\0\0\0\x01', 'latin1');
      for (const extra of [
        HIDDEN,
        Buffer.alloc(60_000, 0x41),
        Buffer.concat([HIDDEN, Buffer.alloc(40_000)]),
      ]) {
        const hiding = jpeg({ before: [jpegSegment(0xee, Buffer.concat([adobe, extra]))] });
        if (extra === HIDDEN) expect(hides(hiding)).toBe(true);
        const output = removeJpegMetadata(hiding, NONE)!;
        expect(hides(output)).toBe(false);
        expect(output.length).toBeLessThan(jpeg().length + 4 + 12 + 1);
        expect(jpegMarkers(output)).toContain(0xee);
        // The segment as it was defined: marker, the length 14, and the 12 bytes.
        const at = output.indexOf(Buffer.from([0xff, 0xee]));
        expect(output.readUInt16BE(at + 2)).toBe(14);
        expect(output.subarray(at + 4, at + 16).equals(adobe)).toBe(true);
      }
    });

    it('drops an APP14 that is shorter than the 12 bytes', () => {
      const output = removeJpegMetadata(
        jpeg({ before: [jpegSegment(0xee, Buffer.from('Adobe\0\x64'))] }),
        NONE,
      )!;
      expect(jpegMarkers(output)).not.toContain(0xee);
    });
  });

  describe('a GIF file', () => {
    const loop = (...after: Buffer[]) =>
      Buffer.concat([
        Buffer.from([0x21, 0xff, 11]),
        Buffer.from('NETSCAPE2.0'),
        Buffer.from([3, 1, 0, 0]),
        ...after,
        Buffer.from([0]),
      ]);
    const sub = (data: Buffer) => Buffer.concat([Buffer.from([data.length]), data]);

    it('keeps the three bytes of the loop count of NETSCAPE2.0, and no sub-block after them', () => {
      const hiding = gif({ before: [loop(sub(HIDDEN))] });
      expect(hides(hiding)).toBe(true);
      const output = removeGifMetadata(hiding, NONE)!;
      expect(hides(output)).toBe(false);
      expect(output.equals(gif({ before: [loop()] }))).toBe(true);
    });

    it('drops a NETSCAPE2.0 whose first sub-block is not the loop count', () => {
      const odd = Buffer.concat([
        Buffer.from([0x21, 0xff, 11]),
        Buffer.from('NETSCAPE2.0'),
        sub(HIDDEN),
        Buffer.from([0]),
      ]);
      const output = removeGifMetadata(gif({ before: [odd] }), NONE)!;
      expect(hides(output)).toBe(false);
      expect(output.equals(gif())).toBe(true);
    });

    it('keeps the four bytes of the graphic control and no sub-block after them', () => {
      const hiding = Buffer.concat([
        Buffer.from([0x21, 0xf9, 4, 0, 10, 0, 0]),
        sub(HIDDEN),
        Buffer.from([0]),
      ]);
      expect(hides(gif({ frames: [hiding, GIF_FRAME] }))).toBe(true);
      const output = removeGifMetadata(gif({ frames: [hiding, GIF_FRAME] }), NONE)!;
      expect(hides(output)).toBe(false);
      expect(output.equals(gif({ frames: [GIF_CONTROL, GIF_FRAME] }))).toBe(true);
    });

    it('drops a graphic control that is not four bytes', () => {
      const odd = Buffer.concat([Buffer.from([0x21, 0xf9]), sub(HIDDEN), Buffer.from([0])]);
      const output = removeGifMetadata(gif({ frames: [odd, GIF_FRAME] }), NONE)!;
      expect(hides(output)).toBe(false);
      expect(output.equals(gif({ frames: [GIF_FRAME] }))).toBe(true);
    });
  });

  describe('a WebP file', () => {
    const header = Buffer.alloc(16);
    const animated = (frame: Buffer) =>
      webp([vp8x(0x12), webpChunk('ANIM', Buffer.alloc(6)), webpChunk('ANMF', frame)]);

    it('rebuilds a frame from its header, its alpha and its bitstream, and drops what else it holds', () => {
      const alpha = webpChunk('ALPH', Buffer.from([1, 2, 3, 4]));
      const clean = Buffer.concat([header, alpha, WEBP_PICTURE]);
      const hiding = Buffer.concat([
        header,
        alpha,
        WEBP_PICTURE,
        webpChunk('EXIF', exifTiff(null)),
        webpChunk('XMP ', Buffer.from(`<x:xmpmeta>${SECRET}</x:xmpmeta>`)),
        webpChunk('ZZZZ', HIDDEN),
      ]);
      expect(hides(animated(hiding))).toBe(true);
      const output = removeWebpMetadata(animated(hiding), NONE)!;
      expect(hides(output)).toBe(false);
      expect(leaks(output)).toBe(false);
      expect(output.equals(removeWebpMetadata(animated(clean), NONE)!)).toBe(true);
      expect(output.includes(WEBP_PICTURE)).toBe(true);
      expect(output.includes(alpha)).toBe(true);
    });

    it('refuses a frame that is cut, that has a chunk that runs past it, or that holds no bitstream', () => {
      expect(removeWebpMetadata(animated(header.subarray(0, 10)), NONE)).toBeNull();
      const past = Buffer.concat([Buffer.from('ZZZZ'), Buffer.from([0xff, 0, 0, 0]), HIDDEN]);
      expect(removeWebpMetadata(animated(Buffer.concat([header, WEBP_PICTURE, past])), NONE)).toBeNull();
      expect(
        removeWebpMetadata(animated(Buffer.concat([header, webpChunk('ZZZZ', HIDDEN)])), NONE),
      ).toBeNull();
    });

    it('refuses an animation whose loop chunk is not six bytes', () => {
      const file = webp([
        vp8x(0x12),
        webpChunk('ANIM', Buffer.concat([Buffer.alloc(6), HIDDEN])),
        webpChunk('ANMF', Buffer.concat([header, WEBP_PICTURE])),
      ]);
      expect(removeWebpMetadata(file, NONE)).toBeNull();
    });
  });
});
