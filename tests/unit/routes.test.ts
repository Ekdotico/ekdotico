// NFR-SE-02: "Routes that do not validate the session shall not exist in the
// application's repository, other than the request paths NFR-SE-05 lists."
//
// proxy.ts validates before any route, but Next.js skips the proxy for a
// request that carries the build's own revalidation identifier
// (docs/operations/deployment.md), so a route does not rest on the proxy: each
// validates the session itself. A route added without it fails here.
import { globSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The routes of NFR-SE-05, each with what authenticates it instead.
const SESSIONLESS: Record<string, string> = {
  'src/app/api/health/route.ts': 'NFR-SE-05 (c): reports that the service is up and nothing else',
  'src/app/api/auth/[...all]/route.ts':
    'NFR-SE-05 (a): the identity library checks the session of its own endpoints',
  'src/app/api/sign-up/route.ts':
    'NFR-SE-05 (a), FR-AU-90: authorised by the token of a pending admission invitation',
  'src/app/api/admission/invitations/route.ts':
    'NFR-SE-05 (b), FR-AU-89 (a), (b): the signature of each request is verified before any processing',
  'src/app/api/admission/invitations/[id]/route.ts':
    'NFR-SE-05 (b), FR-AU-89 (c): the signature of each request is verified before any processing',
};

const routes = globSync('src/app/**/route.ts');

describe('the route handlers', () => {
  it('are found', () => {
    expect(routes.length).toBeGreaterThan(0);
  });

  it.each(routes.filter((route) => !(route in SESSIONLESS)))('%s validates the session', (route) => {
    expect(readFileSync(route, 'utf8')).toMatch(/\bvalidateSession(Row)?\(/);
  });

  it('excepts no route that does not exist', () => {
    for (const route of Object.keys(SESSIONLESS)) expect(routes).toContain(route);
  });
});
