// The owner's decision of 8 October 2026 (FR-AU-81, FR-AU-90, NFR-SE-19):
// every page whose address holds the token of a single-use link is answered
// with the header `Referrer-Policy: no-referrer`. The header is set in
// next.config.ts; the pages are those of the proxy's list. A token page added
// to the one and not to the other fails here.
import { describe, expect, it } from 'vitest';
import config, { TOKEN_PAGES } from '../../next.config.ts';

import { SESSIONLESS } from '../../src/proxy.ts';

describe('the pages whose address holds a token', () => {
  it('are, in next.config.ts, the pages of the proxy’s list that hold one', () => {
    const pages = SESSIONLESS.filter(
      ({ methods, path }) => methods.includes('GET') && path.includes('[token]') && !path.startsWith('/api/'),
    ).map(({ path }) => path.replace('[token]', ':token'));
    expect(pages.length).toBeGreaterThan(0);
    expect([...TOKEN_PAGES].sort()).toEqual(pages.sort());
  });

  it('are each answered with Referrer-Policy: no-referrer, and with nothing weaker', async () => {
    // After the rule of every response (tests/unit/csp.test.ts), which sets a
    // weaker value: where two rules set one header, Next.js sends the last.
    const [every, ...rules] = await config.headers!();
    expect(every!.source).toBe('/:path*');
    expect(rules.map((rule) => rule.source)).toEqual(TOKEN_PAGES);
    for (const rule of rules) {
      expect(rule.headers, rule.source).toEqual([{ key: 'Referrer-Policy', value: 'no-referrer' }]);
    }
  });
});
