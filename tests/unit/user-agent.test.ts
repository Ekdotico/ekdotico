// The browser's name and the operating system family of a session, as the
// account settings show them (FR-AU-85; FR-AU-68 (c)).
import { describe, expect, it } from 'vitest';
import { describeUserAgent } from '../../src/lib/user-agent.ts';

describe('describeUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0',
      'Firefox',
      'macOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
      'Edge',
      'Windows',
    ],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15',
      'Safari',
      'macOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1',
      'Safari',
      'iOS',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome',
      'iOS',
    ],
    [
      'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
      'Chrome',
      'Android',
    ],
    ['Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0', 'Firefox', 'Linux'],
    [
      'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      'Chrome',
      'ChromeOS',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0',
      'Opera',
      'Windows',
    ],
  ])('%s', (header, browser, system) => {
    expect(describeUserAgent(header)).toEqual({ browser, system });
  });

  it.each([null, undefined, '', 'curl/8.7.1', 'A Browser/1.0', '<script>alert(1)</script>'])(
    'names nothing it was not told: %j',
    (header) => {
      expect(describeUserAgent(header)).toEqual({ browser: null, system: null });
    },
  );

  it('returns names of its own and never a word of the header', () => {
    const { browser, system } = describeUserAgent('Firefox/<b>1</b> Windows"onload="x');
    expect([browser, system]).toEqual(['Firefox', 'Windows']);
  });

  it('reads no further than the header could honestly be long', () => {
    expect(describeUserAgent(`${'x'.repeat(600)} Firefox/1.0 Windows`)).toEqual({
      browser: null,
      system: null,
    });
  });
});
