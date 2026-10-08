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
  'The request could not be completed because of a fault on the server. Nothing was changed. Try again in a few minutes.';

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
 * The bytes of a request's body, or null where it is longer than `maxBytes`.
 * Bounded, so that no request makes a process hold more than its route
 * expects; the reading stops at the bound.
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
  return Buffer.concat(chunks);
}

/**
 * The JSON of a request's body, or null where the body is longer than
 * `maxBytes`, is not UTF-8, or is not JSON.
 */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const bytes = await readBytes(request, maxBytes);
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
