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

const config: NextConfig = {
  poweredByHeader: false,
  // The development server would write an AGENTS.md of its own into the repository.
  agentRules: false,
  headers: async () =>
    TOKEN_PAGES.map((source) => ({
      source,
      headers: [{ key: 'Referrer-Policy', value: 'no-referrer' }],
    })),
};

export default config;
