// What a page sends to the application's own routes, and how it reads a
// refusal. Every route answers an error in the one shape
// `{ "error": { "code", "message" } }` (src/lib/http.ts), the proxy's 403, 429
// and 500 included, and the message is text for a person: a page shows it as it
// is given and never rewords it.

export interface Fault {
  code: string;
  message: string;
  /** The rule a field did not meet, by the field's name (a 422). */
  fields?: Record<string, string | undefined>;
}

// The two statements a page makes by itself, where no answer in the one shape
// arrived. Written under the Expression Guidelines (system feedback, classes B
// and C); the owner approves them with the pull request.
const NOT_REACHED = 'The request did not reach Ekdotico. Check the connection and try again.';
const NOT_READ = 'Ekdotico could not complete the request. Try again in a few minutes.';

/**
 * A request that changes state, to a path of this origin: a POST, or the
 * method a route names. The browser adds the `Origin` header that the proxy
 * checks (NFR-SE-17 (c)). Nothing is logged: a body can hold a password or the
 * token of a link (NFR-SE-19).
 */
export async function send(
  path: string,
  body?: unknown,
  method: 'POST' | 'PATCH' = 'POST',
): Promise<Fault | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return { code: 'not_reached', message: NOT_REACHED };
  }
  if (response.ok) return null;
  try {
    const { error } = (await response.json()) as { error?: Partial<Fault> };
    if (typeof error?.code === 'string' && typeof error.message === 'string' && error.message) {
      return { code: error.code, message: error.message, fields: error.fields };
    }
  } catch {
    // Not JSON: stated below.
  }
  return { code: 'not_read', message: NOT_READ };
}
