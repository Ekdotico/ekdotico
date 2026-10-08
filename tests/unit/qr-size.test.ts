// FR-AU-83: the secret "as a QR code". The size the application draws the
// package's control at keeps the 3 CSS pixels a module that the package asks
// for, for the longest address it is drawn for; and a value it would be too
// fine for, or that the control cannot hold, is not handed to the control.
// The address is built here as src/lib/auth/two-factor.ts builds it, and not
// taken from it.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QrCode } from '@ekdotico/domico/components';
import { QR_BYTES, QR_SIZE, qrFits } from '../../src/components/qr-size.ts';

// A secret as it is shown: 52 characters of base32.
const SECRET = 'JBSWY3DPEHPK3PXP'.repeat(4).slice(0, 52);
const uriOf = (email: string) =>
  `otpauth://totp/Ekdotico:${encodeURIComponent(email)}?${new URLSearchParams({
    secret: SECRET,
    issuer: 'Ekdotico',
    digits: '6',
    period: '30',
  })}`;
const bytesOf = (value: string) => new TextEncoder().encode(value).length;

/** An address of 254 characters, each of them `unit` but for the `@` and the dot. */
const longest = (unit: string) => `${unit.repeat(120)}@${unit.repeat(128)}.${unit.repeat(4)}`;

/** CSS pixels a module of the code of `value`, as the control draws it at the application's size. */
function pixelsPerModule(value: string): number {
  const markup = renderToStaticMarkup(createElement(QrCode, { value, label: 'A code', size: QR_SIZE }));
  expect(markup).toContain(`width="${QR_SIZE}"`);
  const side = Number(/viewBox="0 0 (\d+) \1"/.exec(markup)![1]);
  return QR_SIZE / side;
}

describe('the size of the QR code of a two-factor secret', () => {
  it('keeps 3 pixels a module for an address of 254 characters', () => {
    const uri = uriOf(longest('a'));
    expect(longest('a')).toHaveLength(254);
    expect(bytesOf(uri)).toBe(375);
    expect(qrFits(uri)).toBe(true);
    expect(pixelsPerModule(uri)).toBeGreaterThanOrEqual(3);
  });

  it('keeps 3 pixels a module for every value it is drawn for, and for none that is longer', () => {
    expect(qrFits('a'.repeat(QR_BYTES))).toBe(true);
    expect(pixelsPerModule('a'.repeat(QR_BYTES))).toBeGreaterThanOrEqual(3);
    expect(qrFits('a'.repeat(QR_BYTES + 1))).toBe(false);
    expect(pixelsPerModule('a'.repeat(QR_BYTES + 1))).toBeLessThan(3);
  });

  it('stands inside a page 320 pixels wide, between its two gutters of 24', () => {
    expect(QR_SIZE).toBeLessThanOrEqual(320 - 2 * 24);
  });

  // Bytes and not characters: an address may hold what is escaped, and what is not ASCII.
  it.each([
    ['escaped', '+', 879],
    ['of two bytes', 'é', 1635],
    ['of three bytes', '€', 2391],
  ])('does not draw the code of an address of 254 characters that are %s', (_, unit, bytes) => {
    const uri = uriOf(longest(unit));
    expect(bytesOf(uri)).toBe(bytes);
    expect(qrFits(uri)).toBe(false);
  });

  it('never hands the control a value that it throws for', () => {
    const uri = uriOf(longest('€'));
    expect(() => renderToStaticMarkup(createElement(QrCode, { value: uri, label: 'A code' }))).toThrow(
      RangeError,
    );
    expect(qrFits(uri)).toBe(false);
  });
});
