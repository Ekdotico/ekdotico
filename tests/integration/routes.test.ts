// NFR-SE-02, as it runs: every route handler that is not on the session-less
// list of NFR-SE-05 answers a request without a cookie 401 `unauthenticated`,
// whatever its method, with no proxy in front of it. tests/unit/routes.test.ts
// reads the same files for the call; this one makes the call.
//
// And FR-AU-83, in the same way: each of them answers an account that the
// founding-team gate stops 403, with no proxy in front of it, but for the
// routes tests/routes.ts excepts by name.
import { afterAll, describe, expect, it } from 'vitest';
import { behindTheGate, PAST_THE_GATE, withSession } from '../routes.ts';
import { cookiesOf, createAccount, load, ORIGIN, prepare, signIn } from './identity.ts';

const database = prepare('routes', { FOUNDING_TEAM_EMAILS: 'founder@example.com' });
const { auth, db, valkey } = await load();

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;

/** The address of a route file, with a value in place of each parameter. */
const addressOf = (route: string) =>
  ORIGIN +
  route
    .replace(/^src\/app/, '')
    .replace(/\/route\.[a-z]+$/, '')
    .replace(/\/\([^/]+\)/g, '')
    .replace(/\[[^\]]+\]/g, 'x');

const handlers = (
  await Promise.all(
    withSession.map(async (route) => {
      const exported = (await import(/* @vite-ignore */ `../../${route}`)) as Record<string, unknown>;
      return METHODS.filter((method) => typeof exported[method] === 'function').map(
        (method) => [route, method, exported[method] as Handler] as const,
      );
    }),
  )
).flat();

const ask = (route: string, method: string, handler: Handler, cookie?: string) =>
  handler(
    new Request(addressOf(route), {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
    }),
    { params: Promise.resolve({}) },
  );

afterAll(async () => {
  await db().$disconnect();
  valkey().disconnect();
  database.drop();
});

describe('the route handlers with a session', () => {
  it('are found, each with a method', () => {
    expect(withSession.length).toBeGreaterThan(0);
    expect(new Set(handlers.map(([route]) => route)).size).toBe(withSession.length);
  });

  it.each(handlers)('%s answers a %s without a cookie 401', async (route, method, handler) => {
    const response = await ask(route, method, handler);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).error.code).toBe('unauthenticated');
  });
});

describe('the route handlers, asked by an account the founding-team gate stops (FR-AU-83)', () => {
  it('excepts no route that does not exist', () => {
    for (const route of Object.keys(PAST_THE_GATE)) expect(withSession).toContain(route);
  });

  it.each(handlers.filter(([route]) => behindTheGate.includes(route)))(
    '%s answers its %s 403, and an account that is not on the list otherwise',
    async (route, method, handler) => {
      const cookieOf = async (email: string) => {
        if (!(await db().user.count({ where: { email } }))) await createAccount(auth, email);
        return cookiesOf(await signIn(auth, email));
      };
      const stopped = await ask(route, method, handler, await cookieOf('founder@example.com'));
      expect(stopped.status).toBe(403);
      expect(stopped.headers.get('cache-control')).toBe('no-store');
      expect((await stopped.json()).error.code).toBe('two_factor_required');

      const other = await ask(route, method, handler, await cookieOf('person@example.com'));
      expect([401, 403]).not.toContain(other.status);
    },
  );
});
