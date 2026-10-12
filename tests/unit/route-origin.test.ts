// NFR-SE-17 (c), and the owner's decision R50 of 12 October 2026: "Repeat the
// check in every state-changing route, with a test that fails when it is
// removed." The proxy refuses a request of another origin before any route,
// but Next.js skips the proxy for a request that carries the build's own
// revalidation identifier (docs/operations/deployment.md), so a route does not
// rest on it. A handler that changes state and is added without the check
// fails here; tests/integration/route-origin.test.ts calls each one.
import { globSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Permission } from '../../src/lib/documents/permissions.ts';
import { deletedDocumentRoute, documentRoute, permissionOf, stateOf } from '../../src/lib/documents/route.ts';
import { handlersOf, mustCheckOrigin, reads, routes, SESSIONLESS, SIGNED } from '../routes.ts';

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

// ── The one form of the check in a handler ──────────────────────────────────
//
// A handler that is not made by `documentRoute` opens with these two
// statements, and nothing before them but a `try {`:
//
//   const foreign = await refusedOrigin(request.headers);
//   if (foreign) return foreign;
//
// where `request` is its first parameter and `foreign` any one name. The file
// is parsed, so a comment is nothing, the handler is its own body, and no
// statement, no read of the body and no promise started comes before the
// check. One step aside is read: the first statement may call a function of
// the same file on the request, `const refused = await refusal(request);`,
// where that function opens with the two statements itself (the identity
// handler). What a `catch` does with a fault of the check is not read here.

const parse = (text: string) => ts.createSourceFile('route.ts', text, ts.ScriptTarget.Latest, true);

/** Whether the file imports `refusedOrigin` under its own name from src/lib/auth/route-answers.ts. */
function importsTheCheck(file: ts.SourceFile): boolean {
  return file.statements.some(
    (statement) =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text.endsWith('lib/auth/route-answers.ts') &&
      statement.importClause?.namedBindings !== undefined &&
      ts.isNamedImports(statement.importClause.namedBindings) &&
      statement.importClause.namedBindings.elements.some(
        (element) => element.name.text === 'refusedOrigin' && element.propertyName === undefined,
      ),
  );
}

const functionNamed = (file: ts.SourceFile, name: string) =>
  file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );

/** Whether a function opens with the two statements; `aside` allows the one step through a function of the file. */
function opensWithTheCheck(file: ts.SourceFile, made: ts.FunctionDeclaration, aside = true): boolean {
  // Plain parameters: a default value would run before the first statement.
  const names = made.parameters.map((parameter) =>
    ts.isIdentifier(parameter.name) && !parameter.initializer ? parameter.name.text : undefined,
  );
  const request = names[0];
  if (request === undefined || names.includes(undefined) || names.includes('refusedOrigin')) return false;

  let statements: readonly ts.Statement[] = made.body?.statements ?? [];
  if (statements[0] && ts.isTryStatement(statements[0])) statements = statements[0].tryBlock.statements;
  const [declared, returned] = statements;

  // const foreign = await refusedOrigin(request.headers);
  if (!declared || !ts.isVariableStatement(declared)) return false;
  const { declarations, flags } = declared.declarationList;
  const declaration = declarations[0]!;
  const awaited = declaration.initializer;
  if (!(flags & ts.NodeFlags.Const) || declarations.length !== 1 || !ts.isIdentifier(declaration.name)) {
    return false;
  }
  if (!awaited || !ts.isAwaitExpression(awaited) || !ts.isCallExpression(awaited.expression)) return false;
  const call = awaited.expression;
  const argument = call.arguments[0];
  if (!ts.isIdentifier(call.expression) || call.questionDotToken || call.arguments.length !== 1) return false;
  if (call.expression.text === 'refusedOrigin') {
    const ofTheRequest =
      ts.isPropertyAccessExpression(argument!) &&
      !argument.questionDotToken &&
      ts.isIdentifier(argument.expression) &&
      argument.expression.text === request &&
      argument.name.text === 'headers';
    if (!ofTheRequest || !importsTheCheck(file)) return false;
  } else {
    const own = aside ? functionNamed(file, call.expression.text) : undefined;
    const onTheRequest = ts.isIdentifier(argument!) && argument.text === request;
    if (!own || !onTheRequest || !opensWithTheCheck(file, own, false)) return false;
  }

  // if (foreign) return foreign;
  const foreign = declaration.name.text;
  const named = (node: ts.Node | undefined) =>
    node !== undefined && ts.isIdentifier(node) && node.text === foreign;
  return (
    returned !== undefined &&
    ts.isIfStatement(returned) &&
    returned.elseStatement === undefined &&
    named(returned.expression) &&
    ts.isReturnStatement(returned.thenStatement) &&
    named(returned.thenStatement.expression)
  );
}

/**
 * Whether the handler a route file exports under `method` is written as
 * `export async function METHOD(…)` and opens with the check. Exported any
 * other way, a handler is not read here, and so does not pass.
 */
function checksFirst(text: string, method: string): boolean {
  const file = parse(text);
  const made = functionNamed(file, method);
  const exported = made && (ts.getCombinedModifierFlags(made) & ts.ModifierFlags.Export) !== 0;
  return exported === true && opensWithTheCheck(file, made!);
}

// ── A request that only reads, about a document ─────────────────────────────
//
// `documentRoute` asks the origin of every request but a GET and a HEAD, by
// the method of the request. A GET made for a permission that changes the
// document would change state with no origin asked. The permissions under
// which a handler may be a GET or a HEAD are these, which only read; every
// other name of FR-ED-44 changes something or leaves the document. The two
// exports are not here: no route of theirs exists yet, and whoever adds one
// under a GET decides it here, on purpose. A GET that is not made by
// `documentRoute` and changes state is beyond a test to see: it is a matter
// for the review of the route (CLAUDE.md, "Process").
const READS_A_DOCUMENT: Permission[] = ['document.view', 'document.collaborators.view'];

/** Whether a handler made by `documentRoute` may be exported under a method that only reads. */
const mayRead = (handler: unknown) =>
  READS_A_DOCUMENT.includes(permissionOf(handler)!) && stateOf(handler) === 'live';

beforeEach(() => {
  refusedOrigin.mockReset();
  validateSession.mockReset().mockResolvedValue({ session: null, stopped: null, setCookie: [] });
});

describe('the origin check of a handler that changes state (NFR-SE-17 (c))', () => {
  it('reads every route handler under src/app/api, and there is no route handler elsewhere', () => {
    expect(routes.length).toBeGreaterThan(0);
    for (const route of routes) expect(route).toMatch(/^src\/app\/api\//);
  });

  it('finds every handler that changes state, and each opens with the check', async () => {
    const found = await mustCheckOrigin();
    expect(found.length).toBeGreaterThan(0);
    for (const [row, handler] of found) {
      // Made by `documentRoute` or `deletedDocumentRoute`, which check (below).
      if (permissionOf(handler) !== undefined) continue;
      const [route, method] = row.split(' ') as [string, string];
      expect(checksFirst(readFileSync(route, 'utf8'), method), `${row} does not open with the check`).toBe(
        true,
      );
    }
  });

  it('excepts only handlers that exist, of routes that carry no session', async () => {
    for (const row of Object.keys(SIGNED)) {
      const [route, method] = row.split(' ') as [string, string];
      expect(SESSIONLESS[route], row).toMatch(/NFR-SE-05 \(b\)/);
      expect(reads(method), row).toBe(false);
      expect((await handlersOf(route)).map(([name]) => name)).toContain(method);
    }
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

describe('the form of the check', () => {
  const IMPORT = "import { refusedOrigin } from '../../../lib/auth/route-answers.ts';\n";
  const post = (body: string, parameters = 'request: Request') =>
    `export async function POST(${parameters}) {\n${body}\n}\n`;
  const CHECK = '  const foreign = await refusedOrigin(request.headers);\n  if (foreign) return foreign;\n';
  const CHANGE = '  await change(request);';

  it.each([
    ['as the routes write it', IMPORT + post(CHECK + CHANGE)],
    ['inside the try of the handler', IMPORT + post(`  try {\n${CHECK}${CHANGE}\n  } catch {}`)],
    [
      'under other names',
      IMPORT + post(CHECK.replaceAll('foreign', 'no').replaceAll('request', 'r'), 'r: Request'),
    ],
    [
      'through a function of the file that opens with it, as the identity handler has it',
      `${IMPORT}async function refusal(request: Request) {\n  try {\n${CHECK}  } catch {}\n  return notJson(request);\n}\n` +
        post(`  const refused = await refusal(request);\n  if (refused) return refused;\n${CHANGE}`),
    ],
  ])('passes the check %s', (_, text) => {
    expect(checksFirst(text, 'POST')).toBe(true);
  });

  // The first seven are the shapes the security review of pull request 31
  // found the first walk to pass; the rest are what else it should not.
  it.each([
    ['the result of the check ignored', IMPORT + post(`  await refusedOrigin(request.headers);\n${CHANGE}`)],
    [
      'the check on other headers',
      IMPORT + post(CHECK.replace('request.headers', 'new Headers({ origin: APP_ORIGIN })') + CHANGE),
    ],
    [
      'the body read by a method call before the check',
      IMPORT + post(`  const body = await request.json();\n${CHECK}`),
    ],
    [
      'state changed by a method call before the check',
      IMPORT + post(`  await prisma.document.deleteMany({});\n${CHECK}`),
    ],
    [
      'a promise started before the check and awaited after',
      IMPORT + post(`  const deleting = removeEverything(request);\n${CHECK}  await deleting;`),
    ],
    [
      'no check in the handler, and a later function of the file that makes it',
      `${IMPORT + post('  return change(request);')}\nasync function unused(request: Request) {\n${CHECK}}\n`,
    ],
    [
      'the words in a comment',
      IMPORT +
        post(
          `  // const foreign = await refusedOrigin(request.headers);\n  // if (foreign) return foreign;\n${CHANGE}`,
        ),
    ],
    [
      'the check on one branch only',
      IMPORT + post(`  if (request.headers.has("x-check")) await refusedOrigin(request.headers);\n${CHANGE}`),
    ],
    [
      'the session read first',
      IMPORT + post(`  const validation = await validateSessionRow(request.headers);\n${CHECK}`),
    ],
    ['no check at all', IMPORT + post(CHANGE)],
    [
      'the refusal not returned',
      IMPORT +
        post(
          `  const foreign = await refusedOrigin(request.headers);\n  if (foreign) console.log(foreign);\n${CHANGE}`,
        ),
    ],
    ['another value returned', IMPORT + post(CHECK.replace('return foreign', 'return undefined') + CHANGE)],
    [
      'the refusal returned only on another condition',
      IMPORT + post(CHECK.replace('if (foreign)', 'if (foreign && strict)') + CHANGE),
    ],
    [
      'an else beside the return',
      IMPORT + post(CHECK.replace('foreign;\n', 'foreign;\n  else await change(request);\n')),
    ],
    ['the check not awaited', IMPORT + post(CHECK.replace('await ', '') + CHANGE)],
    [
      'a parameter with a default that runs first',
      IMPORT + post(CHECK, 'request: Request, done = change(request)'),
    ],
    ['a check of another name’s making', post(CHECK + CHANGE)],
    [
      'a check imported under the name from elsewhere',
      "import { refusedOrigin } from './mine.ts';\n" + post(CHECK + CHANGE),
    ],
    [
      'another function imported under the name',
      "import { fault as refusedOrigin } from '../../../lib/auth/route-answers.ts';\n" + post(CHECK + CHANGE),
    ],
    [
      'a handler exported as a constant',
      `${IMPORT}export const POST = async (request: Request) => {\n${CHECK}};\n`,
    ],
    [
      'a handler exported under another name',
      `${IMPORT}async function handle(request: Request) {\n${CHECK}}\nexport { handle as POST };\n`,
    ],
    ['a function of the name that is not exported', IMPORT + post(CHECK).replace('export ', '')],
    [
      'a function of the file that does not open with the check',
      `${IMPORT}async function refusal(request: Request) {\n  await change(request);\n${CHECK}}\n` +
        post('  const refused = await refusal(request);\n  if (refused) return refused;'),
    ],
    [
      'a function of the file given something other than the request',
      `${IMPORT}async function refusal(request: Request) {\n${CHECK}}\n` +
        post('  const refused = await refusal(own());\n  if (refused) return refused;'),
    ],
    [
      'two steps aside',
      `${IMPORT}async function inner(request: Request) {\n${CHECK}}\n` +
        'async function outer(request: Request) {\n  const refused = await inner(request);\n  if (refused) return refused;\n}\n' +
        post('  const refused = await outer(request);\n  if (refused) return refused;'),
    ],
  ])('fails %s', (_, text) => {
    expect(checksFirst(text, 'POST')).toBe(false);
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

  // So no handler is a GET or a HEAD for a permission that changes the document.
  it('is exported under a method that only reads for a permission that only reads', async () => {
    let seen = 0;
    for (const route of routes) {
      for (const [method, exported] of await handlersOf(route)) {
        if (!reads(method) || permissionOf(exported) === undefined) continue;
        seen += 1;
        expect(mayRead(exported), `${route} ${method} is made for ${permissionOf(exported)}`).toBe(true);
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('knows a handler that may not be a GET', () => {
    const noop = () => new Response();
    expect(mayRead(documentRoute('document.view', noop))).toBe(true);
    expect(mayRead(documentRoute('document.delete', noop))).toBe(false);
    expect(mayRead(documentRoute('document.rename', noop))).toBe(false);
    expect(mayRead(documentRoute('document.export.draft', noop))).toBe(false);
    expect(mayRead(deletedDocumentRoute(noop))).toBe(false);
    expect(mayRead(noop)).toBe(false);
  });
});
