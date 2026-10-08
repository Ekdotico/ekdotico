// The size at which the QR code of a two-factor secret is drawn (FR-AU-83),
// and the longest value it is drawn for. The package's control asks for 3 CSS
// pixels a module or more (@ekdotico/domico README, "The QR code"): a decoder
// read every rendering tried at 2.8 and failed one at 2.3.
//
// 256 pixels stand inside a page 320 pixels wide between its two gutters of
// 24 (FR-AU-88), and at 3 pixels a module hold a code 85 modules across with
// its quiet zone, which is the code of a value of up to 412 bytes. The address
// `otpauth://…` of an account whose email address has 254 characters, none of
// which is escaped, is 375 bytes. tests/unit/qr-size.test.ts holds both
// numbers against the package's encoder.

/** Width and height of the code in CSS pixels, quiet zone included. */
export const QR_SIZE = 256;

/** The most bytes of UTF-8 a value has for its code to keep 3 pixels a module at `QR_SIZE`. */
export const QR_BYTES = 412;

/**
 * Whether the code of `value` is drawn. An address may hold characters that
 * are escaped or are not ASCII, and its `otpauth://` address then runs to as
 * much as 2391 bytes: beyond 412 the code would be too fine for a camera at a
 * size a narrow page holds, and beyond 2331 the control throws. FR-AU-83 does
 * not say what is shown then; the secret as text and the link are, as they
 * were before there was a code (reported to the owner as a register row).
 */
export const qrFits = (value: string): boolean => new TextEncoder().encode(value).length <= QR_BYTES;
