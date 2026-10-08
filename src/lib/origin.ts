// The origin check of NFR-SE-17 (c) and NFR-SE-06 (A02). The session cookie is
// host-only, but every host under the registrable domain is same-site with the
// application, so `SameSite` does not stop a page on one of them from making a
// request that carries the cookie. A request that changes state, and the
// collaboration handshake (FR-AU-08), are therefore refused unless their
// `Origin` header is the application's own origin. The allow-list holds that
// one origin and no other.
//
// This is the application's own check, which API design allows until it adopts
// `@ekdotico/amyntico` ("or one that does the same").
import { settings } from './settings.ts';

/**
 * Whether the value of an `Origin` header is the application's own origin.
 *
 * The comparison is equality of strings, with no parsing: a browser sends the
 * serialised origin (lower-case scheme and host, no default port, no path),
 * and `settings()` holds the application's in that same form, so anything that
 * differs by a character is another origin or is not from a browser.
 *
 * An absent header is refused. A browser sends `Origin` on every request that
 * is not a GET or a HEAD, on a form post as on a fetch, so a state-changing
 * request without one did not come from a page of the application. `null`, the
 * origin of a sandboxed frame or of a redirect across origins, is refused too.
 */
export function isOwnOrigin(origin: string | null | undefined): boolean {
  return typeof origin === 'string' && origin === settings().appOrigin;
}
