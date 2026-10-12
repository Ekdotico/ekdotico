// NFR-SE-17 (c), and the owner's decision R50 of 12 October 2026: "Repeat the
// check in every state-changing route, with a test that fails when it is
// removed." The proxy refuses a request of another origin before any route,
// but Next.js skips the proxy for a request that carries the build's own
// revalidation identifier (docs/operations/deployment.md), so a route does not
// rest on it. A handler that changes state and is added without the check
// fails here; tests/integration/route-origin.test.ts calls each one.
import { globSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deletedDocumentRoute, documentRoute, permissionOf } from '../../src/lib/documents/route.ts';
import { routes, SESSIONLESS } from '../routes.ts';

const refusedOrigin = vi.hoisted(() => vi.fn());
const validateSession = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/auth/route-answers.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/auth/route-answers.ts')>()),
  refusedOrigin,
}));
vi.mock('../../src/lib/auth/session.ts', async (original) => ({
  ...(await original<typeof import('../../src/lib/auth/session.ts')>()),
  validateSession,
}));

// The handlers that change state and make no origin check, each with why. They
// carry no cookie, so there is nothing of a person's for another site to ride
// on: each is authorised by the signature of the request, made with a secret
// that no browser holds, and is called by a command and never from a page,
// which sends no `Origin` at all (NFR-SE-05 (b); API design, "Admission": "None
// carries a session, and none is ever called from a browser"). The proxy
// excepts them for the same reason (src/proxy.ts, group (b)).
const SIGNED: Record<string, string> = {
  'src/app/api/admission/invitations/route.ts POST': 'FR-AU-89 (a): the signature is verified first',
  'src/app/api/admission/invitations/[id]/route.ts DELETE': 'FR-AU-89 (c): the signature is verified first',
};

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
// Every method but those that only read (src/lib/http.ts, `onlyReads`). An
// OPTIONS is taken to change state too, and no route exports one.
const READS = ['GET', 'HEAD'];

/** What a route file exports under the name of a method that changes state. */
async function changing(route: string): Promise<[method: string, handler: unknown][]> {
  const exported: Record<string, unknown> = await import(
    /* @vite-ignore */ pathToFileURL(resolve(route)).href
  );
  return Object.entries(exported).filter(([name]) => METHODS.includes(name) && !READS.includes(name));
}

/** The source of a handler written as a function in a route file, from its method to the next. */
function sourceOf(text: string, method: string): string | undefined {
  return text
    .split(/^export (?:async )?function (?=(?:GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\()/m)
    .slice(1)
    .find((source) => source.startsWith(`${method}(`));
}

/**
 * Whether the first thing a handler waits on is the origin check: a call of
 * `refusedOrigin`, or of a function of the same file whose own first wait is
 * that call (the identity handler's `refusal`). Nothing of the request is read
 * before it, the session included.
 */
function checksFirst(text: string, source: string): boolean {
  const first = /\bawait\s+(\w+)\(/.exec(source)?.[1];
  if (first === undefined || first === 'refusedOrigin') return first !== undefined;
  const own = new RegExp(`^(?:async )?function ${first}\\([^]*?^}`, 'm').exec(text)?.[0];
  return own !== undefined && /\bawait\s+(\w+)\(/.exec(own)?.[1] === 'refusedOrigin';
}

beforeEach(() => {
  refusedOrigin.mockReset();
  validateSession.mockReset().mockResolvedValue({ session: null, stopped: null, setCookie: [] });
});

describe('the origin check of a handler that changes state (NFR-SE-17 (c))', () => {
  it('reads every route handler under src/app/api, and there is no route handler elsewhere', () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(route).toMatch(/^src\/app\/api\//);
  });

  it.each(routes)('%s: every handler that changes state checks the origin first', async (route) => {
    const text = readFileSync(route, 'utf8');
    for (const [method, handler] of await changing(route)) {
      const row = `${route} ${method}`;
      if (row in SIGNED) continue;
      // Made by `documentRoute` or `deletedDocumentRoute`, which check (below).
      if (permissionOf(handler) !== undefined) continue;
      const source = sourceOf(text, method);
      // Written any other way, a handler is not read here, and so does not pass.
      expect(source, `${row} is neither made by documentRoute nor written as a function`).toBeDefined();
      expect(checksFirst(text, source!), `${row} does not call refusedOrigin before anything else`).toBe(
        true,
      );
    }
  });

  it('excepts only handlers that exist, of routes that carry no session', async () => {
    for (const row of Object.keys(SIGNED)) {
      const [route, method] = row.split(' ') as [string, string];
      expect(SESSIONLESS[route], row).toMatch(/NFR-SE-05 \(b\)/);
      expect((await changing(route)).map(([name]) => name)).toContain(method);
    }
  });

  it('knows a handler that does not check first', () => {
    const file = (body: string) => `export async function POST(request: Request) {\n${body}\n}\n`;
    const read = (text: string) => checksFirst(text, sourceOf(text, 'POST')!);
    expect(read(file('  const foreign = await refusedOrigin(request.headers);'))).toBe(true);
    expect(read(file('  return new Response();'))).toBe(false);
    expect(
      read(file('  await validateSessionRow(request.headers);\n  await refusedOrigin(request.headers);')),
    ).toBe(false);
    // Through a function of the file, which must itself check first.
    const through = (own: string) => `async function refusal(request: Request) {\n${own}\n}\n\n`;
    const called = file('  const refused = await refusal(request);');
    expect(read(through('  return await refusedOrigin(request.headers);') + called)).toBe(true);
    expect(read(through('  return await somethingElse(request);') + called)).toBe(false);
    expect(read(called)).toBe(false);
  });

  // A server action is a POST to a page, which no route file shows and this
  // test does not read. There is none; one that is added is given its check,
  // and its place here, on purpose.
  it('has no server action to read', () => {
    for (const file of globSync('src/**/*.{ts,tsx}')) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/^\s*['"]use server['"]/m);
    }
  });
});

describe('a handler made by documentRoute or deletedDocumentRoute', () => {
  const FOREIGN = new Response(null, { status: 403 });
  const context = { params: Promise.resolve({ id: 'an-identifier' }) };
  const handler = vi.fn(() => new Response());
  const made = [
    ['documentRoute', documentRoute('document.delete', handler)],
    ['deletedDocumentRoute', deletedDocumentRoute(handler)],
  ] as const;
  const call = (route: (typeof made)[number][1], method: string) =>
    route(new Request('https://app.example.test/api/documents/an-identifier', { method }), context);

  it.each(made)(
    '%s refuses a request of another origin before the session is looked at',
    async (_, route) => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        refusedOrigin.mockResolvedValueOnce(FOREIGN);
        expect(await call(route, method), method).toBe(FOREIGN);
      }
      expect(refusedOrigin).toHaveBeenCalledTimes(5);
      expect(validateSession).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it.each(made)('%s goes on to the session where the origin is the application’s own', async (_, route) => {
    refusedOrigin.mockResolvedValue(null);
    expect((await call(route, 'DELETE')).status).toBe(401);
    expect(refusedOrigin).toHaveBeenCalledTimes(1);
    expect(validateSession).toHaveBeenCalledTimes(1);
  });

  // A browser sends no `Origin` with a GET of its own pages, so a request
  // that only reads is not asked for one.
  it.each(made)('%s asks no origin of a request that only reads', async (_, route) => {
    expect((await call(route, 'GET')).status).toBe(401);
    expect((await call(route, 'HEAD')).status).toBe(401);
    expect(refusedOrigin).not.toHaveBeenCalled();
  });
});
