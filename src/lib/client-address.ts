// The network address a request without a session is limited by (NFR-SE-07).
//
// This runs in proxy.ts, where there is no socket: the address can come only
// from `X-Forwarded-For`. Each proxy appends the address it received the
// request from, so with n trusted proxies the n-th entry from the right was
// written by the outermost of them. Everything to its left is the client's own
// claim and is never read.
//
// With no trusted proxy the address cannot be established. Next.js 16.4.0
// fills the header from the socket only where the request carried none
// (`req.headers['x-forwarded-for'] ??= …socket.remoteAddress`, in
// next/dist/server/base-server.js), so a value the client sent arrives here
// unchanged and cannot be told from the socket's. Every such request therefore
// shares one bucket: a limit that is too strict, and never one that a header
// lifts.
import { isIP } from 'node:net';
import { settings } from './settings.ts';

/** The one bucket of every request whose address cannot be established. */
export const UNKNOWN_ADDRESS = 'unknown';

/** `clientAddress` for a given number of proxies. Exported for the tests. */
export function addressBehind(headers: Headers, trustedProxyCount: number): string {
  if (trustedProxyCount < 1) return UNKNOWN_ADDRESS;
  // Headers joins repeated header lines with a comma, in the order received.
  const entry =
    (headers.get('x-forwarded-for') ?? '').split(',').at(-trustedProxyCount)?.trim().toLowerCase() ?? '';
  // An IPv4 address written as IPv6 (`::ffff:192.0.2.1`) is the same client.
  const address = entry.startsWith('::ffff:') && isIP(entry.slice(7)) === 4 ? entry.slice(7) : entry;
  return isIP(address) ? address : UNKNOWN_ADDRESS;
}

export function clientAddress(headers: Headers): string {
  return addressBehind(headers, settings().trustedProxyCount);
}
