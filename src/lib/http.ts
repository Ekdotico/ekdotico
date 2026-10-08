// The few things about a request and a response that the request-interception
// layer and the routes share. Nothing here is of Next.js, so that the
// collaboration server can load it too.

/** A request that only reads (NFR-SE-02). Every other method is taken to change state. */
export function onlyReads(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

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
