// The body of `POST /api/feedback`, validated as docs/contracts/feedback-intake.md says it (FR-AU-64, FR-AU-66,
// FR-AU-69; "The request body", "The refused characters"). Pure: nothing here reads a request or a clock.
// A fault names a field and a rule from the contract's closed lists, and never quotes what was sent.

export const KINDS = ['problem', 'idea', 'other'] as const;
export type Kind = (typeof KINDS)[number];

export type FieldName = 'kind' | 'message' | 'route' | 'viewport' | 'submissionId';
export type Rule = 'required' | 'unknown' | 'empty' | 'too_long' | 'format' | 'forbidden_character';
/** `field` is `body` for a key the contract names no field for: an unknown one, or a body that is no object. */
export interface FieldFault {
  field: FieldName | 'body';
  rule: Rule;
}

export interface Submission {
  kind: Kind;
  message: string;
  route: string;
  viewport: { width: number; height: number };
  /** Present on a second attempt only: the identifier the failure answer returned. */
  submissionId?: string;
}

export const MAX_MESSAGE_CODE_POINTS = 4000;
/** Bound on the request body, bytes (appsec rule 4): 4,000 four-byte characters and the other fields fit. */
export const MAX_REQUEST_BYTES = 20_480;

// "The refused set": a C0 control other than tab, line feed and carriage return; DEL; a C1 control (U+0080 to
// U+009F); a bidirectional override, U+202A to U+202E and U+2066 to U+2069. Zero-width characters, U+2028 and
// U+2029 are allowed.
const REFUSED = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;

/** Whether `text` carries a character the application and Praktico both refuse. */
export function hasRefusedCharacter(text: string): boolean {
  return REFUSED.test(text);
}

/** Unicode code points, not UTF-16 units (fw-count-unit). */
export function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count += 1; // eslint-disable-line @typescript-eslint/no-unused-vars
  return count;
}

const SUBMISSION_ID = /^[A-Za-z0-9_-]{1,64}$/;
// ponytail: the shape of a route pattern, not the closed list of the application's routes (appsec rule 6);
// the list comes with the widget, which knows the routes it opens from.
const SEGMENT = String.raw`(?:[a-z0-9][a-z0-9-]*|\[[A-Za-z]+\])`;
const ROUTE = new RegExp(String.raw`^/(?:${SEGMENT}(?:/${SEGMENT})*)?$`);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDimension = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 32_767;

export function validateSubmission(
  body: unknown,
): { ok: true; value: Submission } | { ok: false; faults: FieldFault[] } {
  if (!isObject(body)) return { ok: false, faults: [{ field: 'body', rule: 'format' }] };
  const faults: FieldFault[] = [];
  const allowed = ['kind', 'message', 'route', 'viewport', 'submissionId'];
  if (Object.keys(body).some((key) => !allowed.includes(key)))
    faults.push({ field: 'body', rule: 'unknown' });

  const { kind, message, route, viewport, submissionId } = body;

  if (kind === undefined) faults.push({ field: 'kind', rule: 'required' });
  else if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind))
    faults.push({ field: 'kind', rule: 'format' });

  let trimmed = '';
  if (message === undefined) faults.push({ field: 'message', rule: 'required' });
  else if (typeof message !== 'string') faults.push({ field: 'message', rule: 'format' });
  else {
    trimmed = message.trim();
    if (hasRefusedCharacter(message)) faults.push({ field: 'message', rule: 'forbidden_character' });
    else if (trimmed === '') faults.push({ field: 'message', rule: 'empty' });
    else if (codePoints(trimmed) > MAX_MESSAGE_CODE_POINTS)
      faults.push({ field: 'message', rule: 'too_long' });
  }

  if (route === undefined) faults.push({ field: 'route', rule: 'required' });
  else if (typeof route !== 'string' || route.length > 200 || !ROUTE.test(route))
    faults.push({ field: 'route', rule: 'format' });

  if (viewport === undefined) faults.push({ field: 'viewport', rule: 'required' });
  else if (
    !isObject(viewport) ||
    Object.keys(viewport).length !== 2 ||
    !isDimension(viewport.width) ||
    !isDimension(viewport.height)
  )
    faults.push({ field: 'viewport', rule: 'format' });

  if (submissionId !== undefined && (typeof submissionId !== 'string' || !SUBMISSION_ID.test(submissionId)))
    faults.push({ field: 'submissionId', rule: 'format' });

  if (faults.length > 0) return { ok: false, faults };
  const size = viewport as { width: number; height: number };
  return {
    ok: true,
    value: {
      kind: kind as Kind,
      message: trimmed,
      route: route as string,
      viewport: { width: size.width, height: size.height },
      ...(submissionId === undefined ? {} : { submissionId: submissionId as string }),
    },
  };
}
