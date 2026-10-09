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
// An answer that cannot be read says nothing of whether the request was
// carried out, so the statement does not say that it was not.
const NOT_READ =
  'Ekdotico could not read the answer to the request, so the result is not known. Reload the page to see the current state, then try again.';

/**
 * A request that changes state, to a path of this origin: a POST, or the
 * method a route names. The browser adds the `Origin` header that the proxy
 * checks (NFR-SE-17 (c)). Nothing is logged: a body can hold a password or the
 * token of a link (NFR-SE-19).
 */
export async function send(
  path: string,
  body?: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): Promise<Fault | null> {
  const sent = await sendFor(path, body, method);
  return 'fault' in sent ? sent.fault : null;
}

/** As `send`, for a page that reads the answer to success: its JSON, or null where it holds none. */
export async function sendFor(
  path: string,
  body?: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
): Promise<{ fault: Fault } | { answer: unknown }> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      // Every route answers in JSON and none redirects, so a redirect is an
      // intermediary's, and the page it leads to is never read as success.
      redirect: 'error',
      ...(body === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    });
  } catch {
    return { fault: { code: 'not_reached', message: NOT_REACHED } };
  }
  // Read to its end whatever it holds: a body that is left unread keeps its
  // request open in the browser for as long as the page stays.
  if (response.ok) return { answer: await response.json().catch(() => null) };
  try {
    const { error } = (await response.json()) as { error?: Partial<Fault> };
    if (typeof error?.code === 'string' && typeof error.message === 'string' && error.message) {
      return { fault: { code: error.code, message: error.message, fields: error.fields } };
    }
  } catch {
    // Not JSON: stated below.
  }
  return { fault: { code: 'not_read', message: NOT_READ } };
}
