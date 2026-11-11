import type { NextConfig } from 'next';
import { COMPANION_HEADERS, STATIC_POLICY } from './src/lib/csp.ts';

/**
 * The pages whose address holds the token of a single-use link (src/proxy.ts,
 * group (a)). Each is answered with `Referrer-Policy: no-referrer`, as a
 * header of the response and not as an element of the page alone, so that the
 * address is sent to no one in a `Referer` header whatever the page comes to
 * hold (FR-AU-81 asks it of the link of a lock email; the owner's decision of
 * 8 October 2026 asks it of every page of a token). A page that joins the
 * proxy's list joins this one: tests/unit/token-pages.test.ts holds the two
 * together. So does the one page of a token that needs a session, that of a
 * document invitation's link (FR-ED-21), named apart below.
 */
export const SESSION_TOKEN_PAGES = ['/invitations/:token'];
export const TOKEN_PAGES = [
  '/sign-in/link/:token',
  '/sign-up/:token',
  '/reset-password/:token',
  '/confirm-address/:token',
  ...SESSION_TOKEN_PAGES,
];

const onLocalhost = (url: string | undefined) =>
  URL.canParse(url ?? '') && ['localhost', '127.0.0.1'].includes(new URL(url!).hostname);

/**
 * DEVELOPMENT ONLY. The session cookie is host-only, so a page reaches the
 * collaboration server on its own origin and nowhere else (FR-AU-08). A
 * deployment's reverse proxy serves `/collab` there
 * (docs/operations/deployment.md); a development machine has none, so where
 * `COLLAB_PROXY_TARGET` is set the web application itself passes `/collab`,
 * the WebSocket upgrade included, to the collaboration server. The `Origin`
 * and `Cookie` headers travel as the browser sent them, and the collaboration
 * server checks both exactly as it does in production: nothing here answers
 * for it.
 *
 * Refused unless the application and the target are both on localhost, so
 * that no deployment comes to rest on it: there the proxy's rules for
 * `X-Forwarded-For` and `x-prerender-revalidate` must hold in front of both
 * processes, and this would put one behind the other.
 */
export function collabRewrites(env: Record<string, string | undefined> = process.env) {
  const target = env.COLLAB_PROXY_TARGET;
  if (!target) return [];
  if (!onLocalhost(env.APP_ORIGIN) || !onLocalhost(target)) {
    throw new Error(
      'COLLAB_PROXY_TARGET is for a development machine: unset it, or set it and APP_ORIGIN to addresses on localhost.',
    );
  }
  return [{ source: '/collab', destination: `${new URL(target).origin}/collab` }];
}

const config: NextConfig = {
  poweredByHeader: false,
  rewrites: async () => collabRewrites(),
  // The development server would write an AGENTS.md of its own into the repository.
  agentRules: false,
  experimental: {
    // Next.js 16.4 keeps a copy of the body of every request the proxy (src/proxy.ts) sees, up to this limit, for one
    // path as for any other, and sends no answer until the body has ended (next/dist/server/body-streams.js): a client
    // with no account that withholds the last byte holds that much of the process (S-01 of the audit of November 2026).
    // The largest body a route the proxy sees reads is 256 KB (src/app/api/account/documents/{transfer,clear}). Next.js
    // drops the whole chunk that crosses the limit and ends the body as if it were whole, and a chunk from the socket
    // is up to 64 KB, so 320 KB keeps more than 256 KB of a body that is longer: its route sees that it is past its
    // bound, and refuses it. A body that declares its length is refused as well where it is cut, whatever the bounds
    // (`readBytes`, src/lib/http.ts); one sent in chunks declares none, and nothing but this margin tells its cut. So
    // EVERY ROUTE'S BOUND STAYS AT LEAST ONE 64 KB READ BELOW THIS LIMIT: a route that reads more raises the limit too.
    // The upload of an image, of up to 20 MB (FR-ED-08, NFR-SE-18), is the one path the proxy does not see, so this
    // limit does not cut it; its route reads its own body, to its own bound.
    proxyClientMaxBodySize: '320kb',
  },
  headers: async () => [
    // Every response, the proxy's own answers and those it never saw among
    // them (docs/operations/deployment.md): the headers of src/lib/csp.ts,
    // with the policy that admits nothing. The proxy replaces the policy on
    // the pages it passes on, with one that holds the nonce of the request
    // (src/proxy.ts); a page that reaches a browser without passing the proxy
    // runs nothing.
    {
      source: '/:path*',
      headers: [{ key: 'Content-Security-Policy', value: STATIC_POLICY }, ...COMPANION_HEADERS],
    },
    // After the rule above, so that this value is the one sent: where two
    // rules set one header, Next.js sends the last.
    ...TOKEN_PAGES.map((source) => ({
      source,
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    })),
  ],
};

export default config;
