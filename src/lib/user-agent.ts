// The browser's name and the operating system family, "derived on the server
// from the `User-Agent` header" (FR-AU-68 (c)), for the list of sessions
// (FR-AU-85). The header says what a browser chooses to say, so this is a
// description for the account's own eyes and never a check of anything.
//
// The order matters: Edge and Opera also say Chrome, every one of them says
// Safari, and Chrome on Android says Linux.
const BROWSERS: readonly [RegExp, string][] = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\b(Firefox|FxiOS)\//, 'Firefox'],
  [/\b(Chrome|CriOS|Chromium)\//, 'Chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'Safari'],
];

const SYSTEMS: readonly [RegExp, string][] = [
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bLinux\b|\bX11\b/, 'Linux'],
];

const first = (list: readonly [RegExp, string][], text: string) =>
  list.find(([pattern]) => pattern.test(text))?.[1] ?? null;

/** Null for each part the header does not name. The header itself is not returned. */
export function describeUserAgent(userAgent: string | null | undefined): {
  browser: string | null;
  system: string | null;
} {
  // Bounded: the header is as long as its sender liked.
  const text = (userAgent ?? '').slice(0, 512);
  return { browser: first(BROWSERS, text), system: first(SYSTEMS, text) };
}
