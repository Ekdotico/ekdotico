// The route handlers of the repository, and those of them that carry no
// session, for the two tests of NFR-SE-02: tests/unit/routes.test.ts reads
// each file, and tests/integration/routes.test.ts calls each handler.
import { globSync } from 'node:fs';

// The routes of NFR-SE-05, each with what authenticates it instead.
export const SESSIONLESS: Record<string, string> = {
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

/** Every file Next.js would take for a route handler. */
export const routes = globSync('src/app/**/route.{ts,tsx,js}');

/** The routes that must validate a session themselves. */
export const withSession = routes.filter((route) => !(route in SESSIONLESS));
