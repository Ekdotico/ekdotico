// The few things about a request and a response that the request-interception
// layer and the routes share. Nothing here is of Next.js, so that the
// collaboration server can load it too.

/** A request that only reads (NFR-SE-02). Every other method is taken to change state. */
export function onlyReads(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/**
 * NFR-SE-06, A10: the one statement of a fault on the server, which says
 * nothing of the fault. The proxy answers a 500 with it, and the page of a
 * fault shows it (src/app/error.tsx). Text for a person (the owner's answer to
 * Q6 of the plan).
 */
export const INTERNAL_FAULT =
  'The request could not complete because of a fault on the server. Nothing was changed. Try again in a few minutes.';

/**
 * The one body of an error, `{ "error": { "code", "message" } }` (the owner's
 * answer to Q8 of the plan). The message is text for a person. NFR-SE-06, A10:
 * neither field ever carries a stack trace, an internal identifier, or a secret.
 */
export function errorResponse(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'Cache-Control': 'no-store', ...headers } },
  );
}

/**
 * The JSON of a request as exactly the named fields, each of them text, or
 * null (API design: "any other field is refused"). So a request chooses
 * nothing that its endpoint does not name.
 */
export function textFields<Name extends string>(
  body: unknown,
  ...names: Name[]
): Record<Name, string> | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const given = body as Record<string, unknown>;
  if (Object.keys(given).length !== names.length) return null;
  if (!names.every((name) => Object.hasOwn(given, name) && typeof given[name] === 'string')) return null;
  return given as Record<Name, string>;
}

/**
 * A body that ended at another length than its `Content-Length` declared. Next.js
 * cuts a body its proxy sees at `proxyClientMaxBodySize` (next.config.ts) and
 * ends the stream as if it were whole, so a route can be handed a part of what
 * was sent with no error; this is how it is told. No message: the class says it
 * all (NFR-SE-19).
 */
export class IncompleteBody extends Error {}

/**
 * The bytes of a request's body, or null where it is longer than `maxBytes`.
 * Bounded, so that no request makes a process hold more than its route
 * expects; the reading stops at the bound. It rejects with `IncompleteBody`
 * where the body declared a length and ended at another: only a body sent in
 * chunks, with no length, is taken as it ends.
 */
export async function readBytes(request: Request, maxBytes: number): Promise<Buffer | null> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) !== length)
    throw new IncompleteBody();
  return Buffer.concat(chunks);
}

/**
 * As `readBytes`, for a route that reads JSON from the bytes itself: a body that
 * ended short of its declared length is read as no body, which no reading of
 * JSON accepts, so the route gives the answer of a body of the wrong shape and
 * not a fault.
 */
export async function readWhole(request: Request, maxBytes: number): Promise<Buffer | null> {
  try {
    return await readBytes(request, maxBytes);
  } catch (error) {
    if (error instanceof IncompleteBody) return Buffer.alloc(0);
    throw error;
  }
}

/**
 * Whether a request names its body `application/json`, whatever parameters
 * follow the type. Every route that reads a body holds to it, because a form
 * of another site can post text that reads as JSON under the three types a
 * browser sends without asking first (`text/plain` among them), and cannot
 * send this one. The origin check is the proxy's (NFR-SE-17 (c)); this does
 * not rest on it. A body that is sent as anything else is answered with a 415
 * (`notJson`) by the identity routes, the document routes, and the
 * acknowledgement of the notice (the owner's answer to R28, 12 October 2026);
 * the sign-up route answers it with its own 422 (`readSignUpBody`).
 */
export function sentAsJson(request: Request): boolean {
  return request.headers.get('content-type')?.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/**
 * Text for a person, for the owner's approval: the statement of a body that is
 * not sent as JSON, for the identity routes (the router's 400 and 415 and the
 * route's own) and, since the owner's answer to R28 of 12 October 2026, for
 * the application's own routes too.
 */
export const NOT_JSON =
  'Ekdotico could not read the request, and nothing was changed. A request to this address holds JSON, sent with the content type application/json.';

/**
 * A request that holds no body, by its headers: the sign-out and the ending
 * of the other sessions are sent so (src/components/send.ts). A body sent
 * without a type has a length that is not 0, or is sent in chunks.
 */
export function holdsNoBody({ headers }: Request): boolean {
  return (
    !headers.has('content-type') &&
    !headers.has('transfer-encoding') &&
    (headers.get('content-length') ?? '0') === '0'
  );
}

/**
 * The answer to a request whose body is not sent as `application/json`, or
 * null where it is, or where there is no body at all (R28: 415 everywhere,
 * in the body of every other refusal, `errorResponse`). A route that reads a
 * body calls it after the authorisation of the request and before it reads
 * anything, so that a caller who may not do the thing is told nothing of the body.
 */
export function notJson(request: Request): Response | null {
  return sentAsJson(request) || holdsNoBody(request) ? null : errorResponse(415, 'invalid_request', NOT_JSON);
}

/**
 * The JSON of a request's body, or null where the body is not sent as
 * `application/json`, is longer than `maxBytes`, ended short of its declared
 * length, is not UTF-8, or is not JSON.
 */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  if (!sentAsJson(request)) return null;
  const bytes = await readWhole(request, maxBytes);
  if (!bytes) return null;
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

/**
 * Where a person is returned to after signing in (FR-AU-07): a path of this
 * origin, and `/` for anything else. A value that begins `//` or `/\` names
 * another host to a browser, and one with a scheme does too, so neither is ever
 * handed on as a place to go. The proxy passes what it writes through this, and
 * the sign-in page what it reads.
 */
export function returnPath(value: string | null | undefined): string {
  if (!value || !/^\/(?![/\\])/.test(value) || /[\u0000-\u001f\\]/.test(value)) return '/';
  return value;
}
