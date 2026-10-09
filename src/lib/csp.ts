// The Content-Security-Policy and the headers beside it, for every response
// of the web application (NFR-SE-06, A03 and A05; the owner's decision of
// 9 October 2026: "no inline script, no remote origins, inline style
// attributes allowed (the editor needs them for table widths and toolbar
// placement), framing denied").
//
// Two policies. A page is answered with `pagePolicy`, which admits the scripts
// of the build by a nonce made for the one request (src/proxy.ts), and nothing
// from any other origin. Everything else, an answer of an API route, a file of
// the build, and a response the proxy never saw, is answered with
// `STATIC_POLICY`, which admits nothing at all (next.config.ts).
//
// There is no `report-uri` and no `report-to`: an endpoint for reports would
// be a route without a session that takes bodies an attacker writes.

/** The request header by which a page is told the nonce of its request. The name is Next.js's own example. */
export const NONCE_HEADER = 'x-nonce';

/** For what is no page: nothing is loaded, nothing runs, and nothing frames it. */
export const STATIC_POLICY = "default-src 'none'; frame-ancestors 'none'";

/** The headers every response carries beside its policy. */
export const COMPANION_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  // For a browser that does not read `frame-ancestors`.
  { key: 'X-Frame-Options', value: 'DENY' },
  // Nothing was set before but on the pages of a token (next.config.ts,
  // `TOKEN_PAGES`), which stay `no-referrer`. This is the default of today's
  // browsers, said in so many words.
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
];

/** A nonce for one request: 128 random bits. */
export function newNonce(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64');
}

/**
 * The policy of a page.
 *
 * - `script-src`: the files of the build, which are this origin's, and the
 *   scripts written into the page that carry the nonce of this request. No
 *   `'unsafe-inline'`, and no `'unsafe-eval'` outside the development server,
 *   where React needs it to rebuild the stack of a server error (Next.js
 *   16.4.0, "Content Security Policy").
 *
 *   WITHOUT `'strict-dynamic'`, which that guide's example has. Under it a
 *   browser ignores `'self'` and trusts every script element that a running
 *   script makes: one with text of its own and no nonce runs, and one of any
 *   other origin is loaded (measured on Chromium, 9 October 2026). The owner
 *   asked for "no inline script, no remote origins", which that does not
 *   keep. Nothing of the build needs it: every file is this origin's. What
 *   `'self'` admits and it would not is a script element in injected markup
 *   that names a file of this origin; the routes answer `nosniff` with a type
 *   that is no script, so the files of the build are all there is to name.
 * - `style-src`: the stylesheets of the build, and a `<style>` element with
 *   the nonce: the editor's library writes one (./editor.tsx, `injectNonce`).
 *   The development server writes its own without a nonce, so there, and
 *   there alone, `'unsafe-inline'` stands in its place, as the same guide says.
 * - `style-src-attr 'unsafe-inline'`: the owner's decision. ProseMirror writes
 *   the widths of a table's columns as `style` attributes, the editor places
 *   its toolbar by one, and the design package's components carry some. A
 *   `style` attribute loads nothing under this policy (`img-src`, `font-src`).
 * - `img-src 'self'`, without `data:`: every icon and the QR code are SVG in
 *   the page, and no stylesheet of the build names an image.
 * - `connect-src 'self'` is the application's own origin, the WebSocket of
 *   `/collab` on it included.
 * - `upgrade-insecure-requests` away from localhost, where there is no HTTPS.
 */
export function pagePolicy(
  nonce: string,
  { development, local }: { development: boolean; local: boolean },
): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${development ? " 'unsafe-eval'" : ''}`,
    `style-src 'self' ${development ? "'unsafe-inline'" : `'nonce-${nonce}'`}`,
    "style-src-attr 'unsafe-inline'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(local ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}
