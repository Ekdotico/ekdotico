// NFR-SE-02: "Routes that do not validate the session shall not exist in the
// application's repository, other than the request paths NFR-SE-05 lists."
//
// proxy.ts validates before any route, but Next.js skips the proxy for a
// request that carries the build's own revalidation identifier
// (docs/operations/deployment.md), so a route does not rest on the proxy: each
// validates the session itself. A route added without it fails here.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { routes, SESSIONLESS, withSession } from '../routes.ts';

describe('the route handlers', () => {
  it('are found', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(withSession)('%s validates the session', (route) => {
    expect(readFileSync(route, 'utf8')).toMatch(/\bvalidateSession(Row)?\(/);
  });

  it('excepts no route that does not exist', () => {
    for (const route of Object.keys(SESSIONLESS)) expect(routes).toContain(route);
  });
});
