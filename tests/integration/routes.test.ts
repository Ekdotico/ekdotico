// NFR-SE-02, as it runs: every route handler that is not on the session-less
// list of NFR-SE-05 answers a request without a cookie 401 `unauthenticated`,
// whatever its method, with no proxy in front of it. tests/unit/routes.test.ts
// reads the same files for the call; this one makes the call.
import { afterAll, describe, expect, it } from 'vitest';
import { withSession } from '../routes.ts';
import { load, ORIGIN, prepare } from './identity.ts';

const database = prepare('routes');
const { db, valkey } = await load();

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
    const request = new Request(addressOf(route), {
      method,
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}' }),
    });
    const response = await handler(request, { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.json()).error.code).toBe('unauthenticated');
  });
});
