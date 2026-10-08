// The code of an authenticator application as the application computes it
// (FR-AU-83: "time-based one-time passwords (TOTP, RFC 6238)"), against the
// published values and not against itself. The same function against the
// identity library's own is in tests/integration/two-factor.test.ts.
import { describe, expect, it } from 'vitest';
import { totpAt, totpStep } from '../../src/lib/auth/two-factor.ts';

describe('totpAt', () => {
  // RFC 4226, Appendix D: the secret "12345678901234567890", counts 0 to 9.
  it('gives the test values of RFC 4226', () => {
    expect(Array.from({ length: 10 }, (_, count) => totpAt('12345678901234567890', count))).toEqual([
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]);
  });

  // RFC 6238, Appendix B, SHA-1: the last six digits of each value given
  // there for eight, at the step of each time given there.
  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ])('gives the test value of RFC 6238 for the time %i', (seconds, code) => {
    expect(totpAt('12345678901234567890', totpStep(seconds * 1000))).toBe(code);
  });

  it('counts a step as 30 seconds', () => {
    expect(totpStep(0)).toBe(0);
    expect(totpStep(29_999)).toBe(0);
    expect(totpStep(30_000)).toBe(1);
  });
});
