import type { NextConfig } from 'next';

/**
 * The pages whose address holds the token of a single-use link (src/proxy.ts,
 * group (a)). Each is answered with `Referrer-Policy: no-referrer`, as a
 * header of the response and not as an element of the page alone, so that the
 * address is sent to no one in a `Referer` header whatever the page comes to
 * hold (FR-AU-81 asks it of the link of a lock email; the owner's decision of
 * 8 October 2026 asks it of every page of a token). A page that joins the
 * proxy's list joins this one: tests/unit/token-pages.test.ts holds the two
 * together.
 */
export const TOKEN_PAGES = [
  '/sign-in/link/:token',
  '/sign-up/:token',
  '/reset-password/:token',
  '/confirm-address/:token',
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
  headers: async () =>
    TOKEN_PAGES.map((source) => ({
      source,
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    })),
};

export default config;
