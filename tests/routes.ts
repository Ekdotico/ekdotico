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

// FR-AU-83: the routes with a session that an account stopped by the
// founding-team gate still reaches, each with why: "every API route refuses
// the account's requests other than those of the enrolment itself". None: the
// requests of the enrolment are endpoints of the identity library's handler,
// which is on the list above (tests/integration/founding-gate.test.ts).
export const PAST_THE_GATE: Record<string, string> = {};

/** The routes that must answer such an account 403. */
export const behindTheGate = withSession.filter((route) => !(route in PAST_THE_GATE));
